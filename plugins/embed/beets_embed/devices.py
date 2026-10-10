"""Optional worker discovery and isolated, bounded ROCm correctness checks."""

import json
import shutil
import subprocess
import sys


DEVICES = ("auto", "cpu", "rocm", "gpu")
PROBE_TIMEOUT = 30


def probe_worker(command):
    try:
        result = subprocess.run([*command, "probe-rocm"], capture_output=True,
                                text=True, timeout=PROBE_TIMEOUT, check=False)
    except subprocess.TimeoutExpired as exc:
        raise ValueError(f"ROCm probe timed out after {PROBE_TIMEOUT}s") from exc
    except OSError as exc:
        raise ValueError(f"Cannot start ROCm probe: {exc}") from exc
    if result.returncode:
        raise ValueError(f"ROCm probe exited with status {result.returncode}: "
                         f"{result.stderr.strip()[-1000:]}")
    try:
        data = json.loads(result.stdout)
    except (ValueError, TypeError) as exc:
        raise ValueError("Invalid ROCm probe response") from exc
    if not isinstance(data, dict) or data.get("backend") != "rocm" or data.get("ok") is not True:
        raise ValueError("ROCm probe did not confirm GPU correctness")
    return data


def select_worker(requested, cpu_worker):
    if requested not in DEVICES:
        raise ValueError(f"Unknown embedding device: {requested}")
    if requested == "cpu":
        return cpu_worker, "cpu"
    candidate = shutil.which("beets-embed-worker-rocm")
    try:
        if candidate is None:
            raise ValueError("beets-embed-worker-rocm is not installed on PATH")
        probe_worker([candidate])
    except ValueError as exc:
        if requested == "rocm":
            raise ValueError(f"Requested ROCm worker unavailable: {exc}") from exc
        print(f"Embedding device: cpu ({exc})", file=sys.stderr)
        return cpu_worker, "cpu"
    return candidate, "rocm"


def probe_rocm():
    # This code runs only in the disposable probe process, never in beets.
    import torch
    from .threads import configure_torch_threads
    configure_torch_threads(2)
    from torch.nn.functional import conv1d
    if not torch.version.hip or not torch.cuda.is_available():
        raise ValueError("HIP-backed torch and an accessible GPU are required")
    device = "cuda:0"
    matrix = torch.arange(32 * 32, dtype=torch.float32).reshape(32, 32) / 1024
    signal = torch.linspace(-1, 1, 128).reshape(1, 1, 128)
    kernel = torch.tensor([.25, .5, .25]).reshape(1, 1, 3)
    with torch.inference_mode():
        expected = [matrix @ matrix.T, conv1d(signal, kernel), matrix.sin()]
        actual = [matrix.to(device) @ matrix.T.to(device),
                  conv1d(signal.to(device), kernel.to(device)), matrix.to(device).sin()]
        if any(value.device.type != "cuda" for value in actual):
            raise ValueError("Probe kernels did not execute on GPU")
        torch.cuda.synchronize()
        for cpu, gpu in zip(expected, actual):
            gpu = gpu.cpu()
            if not torch.isfinite(gpu).all() or not torch.allclose(cpu, gpu, rtol=1e-4, atol=1e-4):
                raise ValueError("GPU kernel output disagrees with CPU")
    return {"ok": True, "backend": "rocm", "hip": torch.version.hip,
            "device": torch.cuda.get_device_name(0)}
