import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

from beets_embed.style_benchmark import metrics, sample_candidates, verdict


class BenchmarkTests(unittest.TestCase):
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
