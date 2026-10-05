"""Bounded audio preparation. FFmpeg decodes once; resampling stays on disk."""

import subprocess
import tempfile
from pathlib import Path

import numpy as np
from scipy.signal import resample_poly


def resample_file(source, target, divisor, block=48000 * 30):
    # Integer ratios from 48 kHz; a halo longer than scipy's FIR prevents block
    # seams. All boundaries align with the decimation phase.
    signal = np.memmap(source, dtype="<f4", mode="r")
    halo = 120
    with open(target, "wb") as out:
        for start in range(0, len(signal), block):
            end = min(start + block, len(signal))
            left, right = max(0, start - halo), min(len(signal), end + halo)
            result = resample_poly(signal[left:right], 1, divisor)
            offset = (start - left) // divisor
            size = (end - start + divisor - 1) // divisor
            out.write(np.asarray(result[offset:offset + size], dtype="<f4").tobytes())
    del signal


class PreparedAudio:
    def __init__(self, path, ffmpeg="ffmpeg"):
        self.temp = tempfile.TemporaryDirectory(prefix="beets-embed-audio-")
        self.root = Path(self.temp.name)
        try:
            decoded = self.root / "48k.f32"
            with decoded.open("wb") as output:
                subprocess.run([ffmpeg, "-nostdin", "-v", "error", "-threads", "1",
                                "-i", path, "-vn", "-ac", "1", "-ar", "48000",
                                "-f", "f32le", "pipe:1"], stdout=output,
                               stderr=subprocess.PIPE, check=True)
            if decoded.stat().st_size == 0:
                raise ValueError("Decoded audio is empty")
            resample_file(decoded, self.root / "16k.f32", 3)
            resample_file(decoded, self.root / "24k.f32", 2)
            decoded.unlink()
        except BaseException:
            self.close()
            raise

    def samples(self, rate):
        return np.memmap(self.root / f"{rate // 1000}k.f32", dtype="<f4", mode="r")

    def close(self):
        self.temp.cleanup()


def mel_filters():
    # Slaney's piecewise scale, linear triangular weights with unit area.
    # Matches Essentia TensorflowInputMusiCNN (FFT512/hop256/96 bands).
    max_mel = 15 + np.log(8000 / 1000) / (np.log(6.4) / 27)
    mel = np.linspace(0, max_mel, 98)
    hz = np.where(mel < 15, mel * (200 / 3),
                  1000 * np.exp((mel - 15) * (np.log(6.4) / 27)))
    bins = np.arange(257) * 16000 / 512
    rising = (bins[None, :] - hz[:-2, None]) / (hz[1:-1] - hz[:-2])[:, None]
    falling = (hz[2:, None] - bins[None, :]) / (hz[2:] - hz[1:-1])[:, None]
    return (np.maximum(0, np.minimum(rising, falling)) *
            (2 / (hz[2:] - hz[:-2]))[:, None]).astype("f4")


FILTERS = mel_filters()
WINDOW = np.hanning(512).astype("f4")


def musicnn_frames(signal, centers):
    positions = centers[:, None] + np.arange(512)[None, :] - 256
    valid = (positions >= 0) & (positions < len(signal))
    frames = np.asarray(signal[np.clip(positions, 0, len(signal) - 1)]) * valid
    power = np.abs(np.fft.rfft(frames * WINDOW, axis=-1)) ** 2
    return np.log10(1 + 10000 * (power @ FILTERS.T)).astype("f4")


def effnet_patches(signal):
    n_frames = (len(signal) + 255) // 256
    for start in range(0, n_frames, 62):
        centers = np.arange(start, min(start + 128, n_frames)) * 256
        patch = musicnn_frames(signal, centers)
        if len(patch) < 128:
            patch = np.pad(patch, ((0, 128 - len(patch)), (0, 0)), mode="wrap")
        yield patch
        if start + 128 >= n_frames:
            break


def amclap_windows(signal):
    size = 24000 * 10
    for start in range(0, len(signal), size):
        start = min(start, max(0, len(signal) - size))
        window = np.asarray(signal[start:start + size], dtype="f4")
        if len(window) < size:
            window = np.pad(window, (0, size - len(window)))
        yield window


def batches(iterator, size):
    pending = []
    for value in iterator:
        pending.append(value)
        if len(pending) == size:
            yield np.stack(pending)
            pending.clear()
    if pending:
        yield np.stack(pending)
