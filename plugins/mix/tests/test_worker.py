"""Mocked worker execution only: never starts inference or an executable."""

import contextlib
import io
import json
from pathlib import Path
import signal
import subprocess
import traceback
import unittest
from unittest.mock import patch

import numpy as np
from beets_embed.store import model_ids
from beetsplug.mix.worker import encode_steer


SECRET = "sentinel-private-steer-and-error"


def valid_output():
    return json.dumps([[2.] + [0.] * 511])


class Child:
    pid = 987654

    def __init__(self, output=None, error=None, code=0, action=None, poll_running=False):
        self.output = valid_output() if output is None else output
        self.error = error or SECRET
        self.returncode = code
        self.action = action
        self.running = poll_running
        self.stdout, self.stderr = io.StringIO(), io.StringIO()
        self.timeouts, self.waits = [], []

    def communicate(self, timeout):
        self.timeouts.append(timeout)
        if self.action:
            self.action()
        return self.output, self.error

    def poll(self):
        return None if self.running else self.returncode

    def wait(self, timeout):
        self.waits.append(timeout)
        self.running = False
        return self.returncode


class Steering(unittest.TestCase):
    def setUp(self):
        self.before = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
        self.roots = []
        self.children = []
        self.addCleanup(self.check_restored)

    def check_restored(self):
        for sig, handler in self.before.items():
            self.assertEqual(signal.getsignal(sig), handler)
        self.assertTrue(all(not root.exists() for root in self.roots))
        for child in self.children:
            self.assertTrue(child.stdout.closed)
            self.assertTrue(child.stderr.closed)

    def launch(self, child, callback=None):
        self.children.append(child)

        def popen(command, **kwargs):
            root = Path(command[command.index("--manifest") + 1]).parent
            self.roots.append(root)
            self.assertEqual(json.loads((root / "phrases.json").read_text()), [SECRET])
            if callback:
                callback(command, kwargs, root)
            return child

        return patch("beetsplug.mix.worker.subprocess.Popen", side_effect=popen)

    def assert_safe(self, exc):
        self.assertNotIn(SECRET, "".join(traceback.format_exception(exc)))
        self.assertNotIn(SECRET, str(exc))
        self.assertTrue(exc.__suppress_context__)
        self.assertIsNone(exc.__cause__)

    def test_cpu_single_vector_model_normalization_temporary_offline_environment(self):
        child = Child()

        def inspect(command, kwargs, root):
            self.assertEqual(command[:8], ["trusted worker", "encode-text", "--device", "cpu", "--threads", "2", "--batch-size", "8"])
            self.assertNotIn("shell", kwargs)
            self.assertTrue(kwargs["start_new_session"])
            self.assertTrue(kwargs["text"])
            self.assertEqual(kwargs["stdout"], subprocess.PIPE)
            self.assertEqual(kwargs["stderr"], subprocess.PIPE)
            env = kwargs["env"]
            for name in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE"):
                self.assertEqual(env[name], "1")
            self.assertEqual(env["OMP_NUM_THREADS"], "2")
            self.assertEqual(env["OPENBLAS_NUM_THREADS"], "2")
            self.assertEqual(env["PYTHONDONTWRITEBYTECODE"], "1")
            for name in ("HOME", "HF_HOME", "HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE", "HF_ASSETS_CACHE",
                         "HF_DATASETS_CACHE", "TRANSFORMERS_CACHE", "TORCH_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME",
                         "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "MPLCONFIGDIR", "TMPDIR", "TMP", "TEMP"):
                self.assertTrue(Path(env[name]).is_relative_to(root))
            (Path(env["XDG_CACHE_HOME"]) / "runtime-state").write_text("temporary")

        with self.launch(child, inspect), patch("beetsplug.mix.worker.os.killpg") as kill:
            vector, model = encode_steer(" " + SECRET + " ", "trusted worker", timeout=17)
        self.assertEqual(vector.shape, (512,))
        self.assertEqual(vector.dtype, np.dtype("f4"))
        self.assertTrue(np.isfinite(vector).all())
        self.assertEqual(float(np.linalg.norm(vector)), 1.)
        self.assertEqual(model, model_ids()["text"])
        self.assertEqual(child.timeouts, [17])
        kill.assert_not_called()

    def test_invalid_arguments_do_not_spawn(self):
        with patch("beetsplug.mix.worker.subprocess.Popen") as launch:
            for text in (None, "", "  ", 7, "x" * 241):
                with self.subTest(text_type=type(text)), self.assertRaises(ValueError):
                    encode_steer(text, "worker")
            for timeout in (0, -1, True, float("nan"), float("inf"), "120", 10 ** 1000):
                with self.subTest(timeout_type=type(timeout)), self.assertRaises(ValueError):
                    encode_steer(SECRET, "worker", timeout)
            for worker in (None, "", "  ", "@unsubstituted@", "bad\x00worker", []):
                with self.subTest(worker_type=type(worker)), self.assertRaises((ValueError, OSError)) as raised:
                    encode_steer(SECRET, worker)
                self.assertNotIn(SECRET, str(raised.exception))
            launch.assert_not_called()

    def test_invalid_finite_json_shape_values_and_norm_are_safe(self):
        outputs = [SECRET, "[]", json.dumps([0.] * 512), json.dumps([[1.] * 511]),
                   json.dumps([[1.] * 512, [1.] * 512]), json.dumps([[0.] * 512]),
                   json.dumps([[1e-20] + [0.] * 511]), json.dumps([[True] + [0.] * 511]),
                   json.dumps([["1"] + [0.] * 511]), json.dumps([[1e300] + [0.] * 511]),
                   "[[NaN" + ",0" * 511 + "]]", "[[Infinity" + ",0" * 511 + "]]",
                   valid_output() + SECRET]
        for output in outputs:
            child = Child(output=output)
            stdout, stderr = io.StringIO(), io.StringIO()
            with self.subTest(output_length=len(output)), self.launch(child), \
                 contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr), \
                 self.assertRaises(ValueError) as raised:
                encode_steer(SECRET, "worker")
            self.assert_safe(raised.exception)
            self.assertEqual(stdout.getvalue(), "")
            self.assertEqual(stderr.getvalue(), "")

    def test_nonzero_exit_sanitizes_both_streams(self):
        child = Child(output=SECRET, error=SECRET, code=17)
        with self.launch(child), self.assertRaises(ValueError) as raised:
            encode_steer(SECRET, "worker")
        self.assert_safe(raised.exception)

    def test_spawn_oserror_sanitized_and_temp_cleaned(self):
        def failed(command, **kwargs):
            self.roots.append(Path(command[-1]).parent)
            raise OSError(SECRET)
        with patch("beetsplug.mix.worker.subprocess.Popen", side_effect=failed), self.assertRaises(OSError) as raised:
            encode_steer(SECRET, "worker")
        self.assert_safe(raised.exception)

    def test_timeout_kills_process_group_even_if_leader_exited(self):
        def timeout():
            raise subprocess.TimeoutExpired(SECRET, 1, output=SECRET, stderr=SECRET)
        child = Child(action=timeout, poll_running=False)
        with self.launch(child), patch("beetsplug.mix.worker.os.killpg") as kill, self.assertRaises(ValueError) as raised:
            encode_steer(SECRET, "worker", timeout=1)
        kill.assert_called_once_with(child.pid, signal.SIGKILL)
        self.assertEqual(child.waits, [5])
        self.assert_safe(raised.exception)

    def test_signal_interruptions_cleanup_group_and_restore_handlers(self):
        for sig in (signal.SIGINT, signal.SIGTERM):
            child = Child(action=lambda: signal.raise_signal(sig), poll_running=True)
            with self.subTest(signal=sig), self.launch(child), patch("beetsplug.mix.worker.os.killpg") as kill, \
                 self.assertRaises(SystemExit) as raised:
                encode_steer(SECRET, "worker")
            self.assertEqual(raised.exception.code, 128 + sig)
            kill.assert_called_once_with(child.pid, signal.SIGKILL)
            self.assertEqual(child.waits, [5])
            self.check_restored()

    def test_keyboard_interrupt_and_cleanup_errors_do_not_expose_context(self):
        def keyboard():
            raise KeyboardInterrupt(SECRET)
        child = Child(action=keyboard, poll_running=True)
        with self.launch(child), patch("beetsplug.mix.worker.os.killpg") as kill, self.assertRaises(KeyboardInterrupt) as raised:
            encode_steer(SECRET, "worker")
        self.assert_safe(raised.exception)
        kill.assert_called_once_with(child.pid, signal.SIGKILL)
        child = Child(action=keyboard, poll_running=True)
        with self.launch(child), patch("beetsplug.mix.worker.os.killpg", side_effect=OSError(SECRET)), \
             self.assertRaises(OSError) as raised:
            encode_steer(SECRET, "worker")
        self.assert_safe(raised.exception)


if __name__ == "__main__":
    unittest.main()
