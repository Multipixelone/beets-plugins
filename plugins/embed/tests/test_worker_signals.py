import json
import signal
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path


@unittest.skipUnless(hasattr(signal, "SIGUSR1"), "requires Unix signals")
class WorkerSignalTests(unittest.TestCase):
    def test_dump_all_threads_then_stop_gracefully(self):
        # Exercise main's signal registration and actual process/store path,
        # with slow fake inference rather than expensive model dependencies.
        script = '''
import sys, time
from unittest.mock import patch
from beets_embed.worker import main
class Prepared:
    def __init__(self, *args):
        time.sleep(2)
    def close(self):
        pass
class Engine:
    def __init__(self, *args, **kwargs):
        pass
    def configure_threads(self):
        pass
    def style(self, *args):
        print("ready", flush=True)
        time.sleep(2)
        return [1], [0], {}, 1
with patch("beets_embed.inference.Models", Engine), patch("beets_embed.audio.PreparedAudio", Prepared):
    sys.exit(main())
'''
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            manifest = root / "manifest.jsonl"
            rows = []
            for index in range(2):
                path = root / str(index)
                path.write_bytes(b"audio")
                rows.append(json.dumps({"id": index, "path": str(path)}))
            manifest.write_text("\n".join(rows) + "\n")
            store = root / "store.sqlite3"
            child = subprocess.Popen([sys.executable, "-u", "-c", script, "embed", "--device", "cpu",
                                      "--assets", "/unused", "--manifest", str(manifest),
                                      "--store", str(store)], stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True)
            try:
                # A bounded reader prevents a failed startup from hanging the suite.
                import selectors
                with selectors.DefaultSelector() as selector:
                    selector.register(child.stdout, selectors.EVENT_READ)
                    self.assertTrue(selector.select(10), "worker never reached inference")
                    self.assertEqual(child.stdout.readline().strip(), "ready")
                child.send_signal(signal.SIGUSR1)
                self.assertIsNone(child.poll())
                child.send_signal(signal.SIGTERM)
                stdout, stderr = child.communicate(timeout=15)
                self.assertEqual(child.returncode, 143, stderr)
                self.assertIn("preparation", stderr)
                self.assertIn("style", stderr)
                self.assertIn("Current thread", stderr)
                counts = json.loads(stdout)
                self.assertTrue(counts["interrupted"])
                self.assertEqual(counts["computed"], 0)
                self.assertIn("profiling", counts)
                with closing(sqlite3.connect(store)) as db:
                    self.assertEqual(db.execute("SELECT COUNT(*) FROM vectors").fetchone()[0], 1)
            finally:
                if child.poll() is None:
                    child.kill()
                child.communicate(timeout=15)
