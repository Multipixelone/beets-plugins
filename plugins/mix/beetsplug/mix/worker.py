"""Bounded offline steering only; no persistent phrase/runtime cache.

The caller supplies a trusted executable matching the installed embed manifest.
encode-text returns vectors, not an independently verifiable worker model ID;
packaging must pin the matching executable rather than inventing verification.
"""

import json
import math
import os
from pathlib import Path
import signal
import subprocess
import tempfile

import numpy as np
from beets_embed.store import model_ids
from beets_mix.defaults import STEERING_MIN_NORM
from beets_mix.vectors import normalized


def _reject_nonfinite(value):
    raise ValueError("Invalid text embedding")


def _encode(text, worker, timeout):
    with tempfile.TemporaryDirectory(prefix=".mix-steer-") as temporary:
        root = Path(temporary)
        directories = {name: root / name for name in ("home", "hf", "torch", "cache", "config", "data", "state", "run", "tmp", "matplotlib")}
        for path in directories.values():
            path.mkdir(mode=0o700)
        manifest = root / "phrases.json"
        manifest.write_text(json.dumps([text], ensure_ascii=True, allow_nan=False), encoding="utf-8")
        env = os.environ.copy()
        env.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_DATASETS_OFFLINE="1",
                   TOKENIZERS_PARALLELISM="false", HOME=str(directories["home"]),
                   HF_HOME=str(directories["hf"]), HF_HUB_CACHE=str(directories["hf"] / "hub"),
                   HUGGINGFACE_HUB_CACHE=str(directories["hf"] / "hub"),
                   HF_ASSETS_CACHE=str(directories["hf"] / "assets"),
                   HF_DATASETS_CACHE=str(directories["hf"] / "datasets"),
                   TRANSFORMERS_CACHE=str(directories["hf"] / "transformers"),
                   TORCH_HOME=str(directories["torch"]), XDG_CACHE_HOME=str(directories["cache"]),
                   XDG_CONFIG_HOME=str(directories["config"]), XDG_DATA_HOME=str(directories["data"]),
                   XDG_STATE_HOME=str(directories["state"]), PYTHONDONTWRITEBYTECODE="1",
                   XDG_RUNTIME_DIR=str(directories["run"]), MPLCONFIGDIR=str(directories["matplotlib"]),
                   TMPDIR=str(directories["tmp"]), TEMP=str(directories["tmp"]), TMP=str(directories["tmp"]),
                   OMP_NUM_THREADS="2", OPENBLAS_NUM_THREADS="2")
        previous = {}
        child = None
        completed = False

        def interrupted(signum, frame):
            raise SystemExit(128 + signum)

        try:
            for signum in (signal.SIGTERM, signal.SIGINT):
                previous[signum] = signal.signal(signum, interrupted)
            child = subprocess.Popen([worker, "encode-text", "--device", "cpu", "--threads", "2",
                                      "--batch-size", "8", "--manifest", str(manifest)],
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     env=env, start_new_session=True, text=True)
            output, _ = child.communicate(timeout=timeout)
            completed = True
            if child.returncode:
                raise ValueError("Steering worker failed")
        finally:
            try:
                if child is not None:
                    try:
                        if not completed or child.poll() is None:
                            try:
                                os.killpg(child.pid, signal.SIGKILL)
                            except ProcessLookupError:
                                pass
                            child.wait(timeout=5)
                    finally:
                        for stream in (child.stdout, child.stderr):
                            if stream is not None:
                                stream.close()
            finally:
                for signum, handler in previous.items():
                    signal.signal(signum, handler)
        values = json.loads(output, parse_constant=_reject_nonfinite)
        if (not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], list)
                or len(values[0]) != 512 or any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in values[0])):
            raise ValueError("Invalid text embedding")
        with np.errstate(over="ignore", invalid="ignore"):
            vector = normalized(values[0], 512, minimum_norm=STEERING_MIN_NORM)
        return vector, model_ids()["text"]


def encode_steer(text, worker, timeout=120):
    """Return a normalized finite float32 text vector/current exact model ID.

    No worker starts for absent/invalid steering. Expected worker/IO failures
    are generic with suppressed raw exception chains; signals retain exit status.
    """
    if not isinstance(text, str) or not text.strip() or len(text.strip()) > 240:
        raise ValueError("Steering text must contain 1–240 nonblank characters")
    try:
        valid_timeout = not isinstance(timeout, bool) and isinstance(timeout, (int, float)) and math.isfinite(timeout) and timeout > 0
    except OverflowError:
        valid_timeout = False
    if not valid_timeout:
        raise ValueError("Steering timeout must be finite and positive")
    try:
        worker = os.fspath(worker)
        if not isinstance(worker, str) or not worker.strip() or worker.startswith("@") or "\x00" in worker:
            raise OSError("Steering worker is unavailable")
        return _encode(text.strip(), worker, timeout)
    except OSError:
        raise OSError("Steering worker is unavailable or failed") from None
    except (ValueError, TypeError, OverflowError, subprocess.SubprocessError):
        raise ValueError("Unable to encode steering text") from None
    except KeyboardInterrupt:
        raise KeyboardInterrupt from None
