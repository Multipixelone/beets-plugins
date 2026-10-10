import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np

from beets_embed.style_benchmark import main, metrics, run_worker, sample_candidates, verdict
from beets_embed.store import Store


class BenchmarkTests(unittest.TestCase):
    def test_worker_mode_rejects_external_store_before_runtime(self):
        with patch("sys.argv", ["benchmark", "--mode", "worker", "--store", "/real/store"]), \
             patch("beets_embed.style_benchmark.run_worker") as run:
            with self.assertRaises(SystemExit) as error:
                main()
        self.assertEqual(error.exception.code, 2)
        run.assert_not_called()

    def test_worker_mode_uses_real_process_and_fresh_temporary_stores(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tracks = []
            for index in range(2):
                path = root / f"track{index}"
                path.write_bytes(b"audio")
                tracks.append({"id": index, "path": str(path)})
            engine = SimpleNamespace(configure_threads=Mock(), load_text=Mock(),
                                     style=Mock(return_value=([1], [0], {}, 1)),
                                     audio_text=Mock(return_value=([1], [0], {}, 1)))
            torch = SimpleNamespace(version=SimpleNamespace(hip="test"), __version__="test",
                                    cuda=Mock())
            torch.cuda.is_available.return_value = True
            args = SimpleNamespace(threads=2, library="/unused", directory="/unused", seed=1,
                                   count=2, assets="/assets", style_backend="torch", ffmpeg="ffmpeg",
                                   batch_size=8, profile_every=100)
            stores = []
            def store(path):
                self.assertEqual(path.parent, root)
                stores.append(path)
                return Store(path)
            with patch.dict("sys.modules", {"torch": torch}), \
                 patch("beets_embed.threads.configure_torch_threads"), \
                 patch("beets_embed.style_benchmark.sample_candidates", return_value=iter(tracks)), \
                 patch("beets_embed.style_benchmark.Models", return_value=engine), \
                 patch("beets_embed.style_benchmark.PreparedAudio", return_value=SimpleNamespace(close=Mock())), \
                 patch("beets_embed.style_benchmark.Store", side_effect=store), \
                 patch("beets_embed.style_benchmark.cpu_seconds", side_effect=[10, 12]):
                report = run_worker(args, root)
            self.assertEqual([p.name for p in stores], ["warmup.sqlite3", "measurement.sqlite3"])
            self.assertEqual(report["counts"]["computed"], 2)
            self.assertEqual(report["counts"]["skipped"], 0)
            self.assertEqual(report["measurement"]["cpu_seconds"], 2)
            self.assertEqual(report["counts"]["profiling"]["stages_seconds"]["style"]["n"], 2)
            self.assertEqual(engine.style.call_count, 3)
            self.assertEqual(engine.audio_text.call_count, 3)
            with Store(stores[1], readonly=True) as measured:
                self.assertEqual(measured.db.execute("SELECT COUNT(*) FROM vectors").fetchone()[0], 4)

    def test_metric_zero_and_scalar_semantics(self):
        self.assertEqual(metrics([0, 0], [0, 0])["cosine"], 1)
        self.assertEqual(metrics([0, 0], [1, 0])["cosine"], 0)
        self.assertEqual(metrics([1], [-1])["cosine"], -1)
        self.assertEqual(metrics([0], [1e-6])["max_rel"], 100)
        with self.assertRaises(ValueError):
            metrics([np.nan], [0])
        with self.assertRaises(ValueError):
            metrics([1, 2], [1])

    def test_verdict_thresholds_and_quantization_boundary(self):
        row = {"aggregates": {"stored_mean": {"cosine": .99999, "close": False},
                               "embeddings_mean": {"close": True}},
               "patch_summary": {"embeddings": {"close": True, "max_abs": 1e-6},
                                 "instrument": {"close": True, "max_abs": 1e-6}}}
        self.assertEqual(verdict([row]), "identical-for-practical-purposes")
        row["patch_summary"]["instrument"]["close"] = False
        self.assertEqual(verdict([row]), "slightly-off-but-sane")
        row["patch_summary"]["instrument"]["max_abs"] = .1
        self.assertEqual(verdict([row]), "broken")

    def test_sampling_is_varied_deterministic_and_read_only(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            library = root / "library.db"
            music = root / "music"
            music.mkdir()
            with sqlite3.connect(library) as db:
                db.execute("CREATE TABLE items (id,path,genre,length,artist,album,title)")
                for index in range(24):
                    path = music / f"{index}.flac"
                    path.touch()
                    db.execute("INSERT INTO items VALUES (?,?,?,?,?,?,?)", (
                        index, os.fsencode(path if index % 2 else path.relative_to(music)),
                        ["folk", "rock", "jazz"][index % 3],
                        60 + index * 30, f"artist {index}", f"album {index}", str(index)))
            db.close()
            before = library.read_bytes()
            real_connect = sqlite3.connect
            def readonly(filename, **kwargs):
                self.assertTrue(filename.endswith("?mode=ro"))
                self.assertTrue(kwargs["uri"])
                return real_connect(filename, **kwargs)
            with patch("beets_embed.style_benchmark.sqlite3.connect", side_effect=readonly):
                first = list(sample_candidates(library, music))[:20]
                second = list(sample_candidates(library, music))[:20]
            self.assertEqual(first, second)
            self.assertEqual(len({t["genre"] for t in first}), 3)
            self.assertEqual(len({t["duration_quartile"] for t in first}), 4)
            self.assertEqual(library.read_bytes(), before)
