"""Synthetic evaluation protocol, read-only preparation and proposal parity."""

import contextlib
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from beets_embed.store import Store, fingerprint, model_ids

from beets_mix import extend
from beets_mix.api import _prepared_proposal
from beets_mix.evaluate import (aggregate, best_observed, centroid_rank, evaluate,
                                main, make_split, random_rank, recall)
from beets_mix.vectors import load_vectors


def track(i, path):
    return dict(id=i, path=str(path), artist=f"artist{i}", albumartist="", title=f"song{i}",
                album="album", year=2000, length=180., mb_trackid=f"mb{i}",
                plex_ratingkey=i, plex_userrating=0, plex_skipcount=0, plex_viewcount=0)


class Evaluation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = self.root / "embeddings.sqlite3"
        self.model = model_ids()["style"]
        self.items = []
        with Store(self.store) as store:
            for i in range(1, 15):
                path = self.root / f"{i}.wav"
                path.write_bytes(b"synthetic")
                row = track(i, path)
                if i in (1, 2, 3):
                    row["album_id"] = 10
                self.items.append(row)
                vector = np.zeros(1280, dtype="f4")
                vector[0] = 1
                if i != 14:
                    store.put(i, fingerprint(path), self.model, vector, np.zeros(1280))
        self.data = {"items": self.items, "playlists": {"fixture": list(range(1, 7)) + [14, 999]}}

    def run_eval(self, **kwargs):
        return evaluate(self.data, store=self.store, thresholds=[.1, .2], ks=[2, 100], trials=2, **kwargs)

    def test_prepared_once_deterministic_and_readonly(self):
        before = copy.deepcopy(self.data)
        database = self.store.read_bytes()
        with patch("beets_mix.evaluate.load_vectors", wraps=load_vectors) as loader:
            result = self.run_eval()
        self.assertEqual(loader.call_count, 1)
        self.assertEqual(before, self.data)
        self.assertEqual(database, self.store.read_bytes())
        reordered = {"items": list(reversed(self.items)), "playlists": {"fixture": list(reversed(self.data["playlists"]["fixture"])) + [1]}}
        second = evaluate(reordered, store=self.store, thresholds=[.2, .1], ks=[100, 2], trials=2)
        self.assertEqual(result, second)
        json.dumps(result, allow_nan=False)
        self.assertNotIn(str(self.root), json.dumps(result))
        self.assertEqual(result["playlists"][0]["no_vector_ids"], [14])
        self.assertEqual(result["playlists"][0]["unresolved_ids"], [999])
        with Store(self.store) as store, self.assertRaisesRegex(ValueError, "query_only"):
            evaluate(self.data, store=store, thresholds=[.1], ks=[100])
        with Store(self.store, readonly=True) as store:
            store.db.execute("PRAGMA query_only=ON")
            protected = evaluate(self.data, store=store, thresholds=[.1], ks=[100], trials=1)
            self.assertEqual(protected["models"]["style"], self.model)

    def test_parity_recoverable_heldouts_and_membership(self):
        result = self.run_eval()
        for trial in result["playlists"][0]["trials"]:
            hidden, training = trial["hidden_ids"], trial["training_ids"]
            self.assertFalse(set(hidden) & set(training))
            self.assertTrue(set(hidden) <= set(trial["eligible_ids"]))
            self.assertIn(14, trial["remaining_original_ids"])
            self.assertEqual(trial["excluded_counts"]["in_playlist"], len(trial["remaining_original_ids"]))
            originals = [row for row in self.items if row["id"] in trial["remaining_original_ids"]]
            for row in trial["results"]:
                ids = row["recommendation_ids"]
                self.assertEqual(len(ids), len(set(ids)))
                self.assertLessEqual(len(ids), row["n"])
                self.assertTrue(set(ids) <= set(trial["eligible_ids"]))
                self.assertFalse(set(ids) & set(trial["remaining_original_ids"]))
                self.assertNotIn(14, ids)
                if row["method"] == "mix":
                    proposal = extend(self.items, training, store=self.store,
                        playlist_tracks=originals, cluster_threshold=row["configuration"]["cluster_threshold"],
                        k=row["configuration"]["k"], n=row["n"]).to_dict()
                    self.assertEqual(ids, [p["item_id"] for p in proposal["proposal"]])
                    self.assertTrue(set(proposal["clusters"][0]["seed_item_ids"]) <= set(training))
                else:
                    self.assertEqual(row["constraints"], "uncapped_baseline")
                    self.assertEqual(row["recommendation_count"], min(row["n"], trial["eligible_count"]))
            full_mix = next(r for r in trial["results"] if r["method"] == "mix" and r["configuration"]["k"] == 100)
            self.assertEqual(full_mix["track_recall"], 1)
            for method in ("centroid", "random"):
                rows = [r for r in trial["results"] if r["method"] == method and r["n"] == 15]
                self.assertTrue(all(r["recommendation_ids"] == rows[0]["recommendation_ids"] for r in rows))

    def test_hidden_filters_raw_recall_and_no_training_floor_leak(self):
        training, hidden = make_split(range(1, 7), seed=0, playlist="fixture", trial=0)
        self.items[hidden[0] - 1]["length"] = 1
        self.items[hidden[1] - 1]["plex_userrating"] = 4
        result = evaluate(self.data, store=self.store, thresholds=[.1], ks=[100], trials=1)
        trial = result["playlists"][0]["trials"][0]
        self.assertEqual(trial["training_ids"], training)
        self.assertEqual(trial["hidden_filtered_count"], 2)
        self.assertEqual(trial["hidden_filtered_counts"]["too_short"], 1)
        self.assertEqual(trial["hidden_filtered_counts"]["low_rated"], 1)
        for row in trial["results"]:
            self.assertEqual(row["track_recall"], 0)
            self.assertIsNone(row["eligible_track_recall"])
            self.assertEqual(row["eligible_track_recall_null_reason"], "no_eligible_hidden_tracks")
        self.items[hidden[1] - 1]["plex_userrating"] = 0
        result = evaluate(self.data, store=self.store, thresholds=[.1], ks=[100], trials=1)
        trial = result["playlists"][0]["trials"][0]
        for row in trial["results"]:
            self.assertEqual(row["track_recall"], .5)
            self.assertEqual(row["eligible_track_recall"], 1)

    def test_duplicate_filter_against_remaining_not_hidden(self):
        training, hidden = make_split(range(1, 7), seed=0, playlist="fixture", trial=0)
        self.items[hidden[0] - 1]["mb_trackid"] = self.items[training[0] - 1]["mb_trackid"]
        self.items[6]["mb_trackid"] = self.items[hidden[1] - 1]["mb_trackid"]
        self.items[7]["mb_trackid"] = self.items[13]["mb_trackid"]
        with Store(self.store, readonly=True) as store:
            self.assertTrue(store.has(8, fingerprint(self.items[7]["path"]), self.model))
        # Another version of a heldout recording is not excluded by that heldout.
        result = evaluate(self.data, store=self.store, thresholds=[.1], ks=[100], trials=1)
        trial = result["playlists"][0]["trials"][0]
        self.assertNotIn(hidden[0], trial["eligible_ids"])
        self.assertIn(7, trial["eligible_ids"])
        self.assertEqual(trial["hidden_filtered_counts"]["version_duplicate"], 1)
        self.assertIn(14, trial["remaining_original_ids"])
        self.assertEqual(result["playlists"][0]["no_vector_ids"], [14])
        self.assertNotIn(8, trial["eligible_ids"])
        self.assertEqual(trial["excluded_counts"]["version_duplicate"], 2)
        self.assertEqual({row["method"] for row in trial["results"]}, {"mix", "centroid", "random"})
        for row in trial["results"]:
            self.assertNotIn(8, row["recommendation_ids"])

    def test_fresh_explicitly_disabled_in_prepared_calls(self):
        with patch("beets_mix.evaluate._prepared_proposal", wraps=_prepared_proposal) as proposal:
            result = evaluate(self.data, store=self.store, thresholds=[.1], ks=[100], trials=1)
        self.assertEqual(proposal.call_count, 2)
        self.assertTrue(all(call.kwargs["fresh"] is False for call in proposal.call_args_list))
        self.assertIs(result["protocol"]["fresh"], False)

    def test_uncapped_baselines_explicit(self):
        for row in self.items:
            row["artist"] = "same artist"
        result = evaluate(self.data, store=self.store, thresholds=[.1], ks=[100], trials=1)
        rows = result["playlists"][0]["trials"][0]["results"]
        self.assertEqual(next(r for r in rows if r["method"] == "mix")["recommendation_count"], 2)
        self.assertGreater(next(r for r in rows if r["method"] == "centroid")["recommendation_count"], 2)
        self.assertIn("uncapped", result["protocol"]["baselines"])

    def test_tiny_skips_and_null_aggregate(self):
        self.data["playlists"] = {"tiny": [1, 2], "empty": [14, 999], "valid": [1, 2, 3]}
        result = self.run_eval()
        self.assertEqual(result["skipped_trials"], 4)
        self.assertTrue(all(t["reason"] == "insufficient_usable_seeds" for p in result["playlists"] if p["name"] != "valid" for t in p["trials"]))
        row = next(r for r in result["summary"] if r["method"] == "mix")
        self.assertEqual(row["macro"]["track_recall"]["valid"], 1)
        self.assertEqual(row["macro"]["track_recall"]["null"], 2)
        self.assertEqual(row["macro"]["track_recall"]["mean"], 1)
        valid = next(p for p in result["playlists"] if p["name"] == "valid")
        self.assertTrue(all(r["album_denominator"] == 1 for t in valid["trials"] for r in t["results"]))
        self.data["playlists"] = {"empty": []}
        result = self.run_eval()
        self.assertIsNone(result["best_observed"]["configuration"])
        self.assertIsNone(result["summary"][0]["macro"]["track_recall"]["mean"])

    def test_cli_strict_json_help_errors_no_paths(self):
        path = self.root / "private-input.json"
        path.write_text(json.dumps(self.data))
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            status = main(["--input", str(path), "--store", str(self.store), "--thresholds", ".1", "--ks", "100", "--trials", "1"])
        self.assertEqual(status, 0)
        result = json.loads(stdout.getvalue())
        self.assertEqual(result["schema"], "beets-mix.evaluation.v1")
        self.assertEqual(stderr.getvalue(), "")
        self.assertNotIn(str(self.root), stdout.getvalue())
        for text in ('{"items":NaN,"playlists":{}}', '{"token":"secret-credential"}', '[]', '{invalid'):
            path.write_text(text)
            stdout, stderr = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                self.assertEqual(main(["--input", str(path), "--store", str(self.store), "--thresholds", ".1", "--ks", "100"]), 2)
            self.assertEqual(stdout.getvalue(), "")
            self.assertNotIn(str(self.root), stderr.getvalue())
            self.assertNotIn("secret-credential", stderr.getvalue())
            self.assertNotIn("Traceback", stderr.getvalue())
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout), self.assertRaises(SystemExit) as exit_info:
            main(["--help"])
        self.assertEqual(exit_info.exception.code, 0)
        self.assertIn("--thresholds", stdout.getvalue())
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit):
            main(["--input", "secret-credential", "--thresholds", "private-path"])
        self.assertNotIn("secret-credential", stderr.getvalue())
        self.assertNotIn("private-path", stderr.getvalue())
        path.write_text(json.dumps(self.data))
        for input_path, store_path in ((self.root / "private-missing-input", self.store),
                                       (path, self.root / "private-missing-store")):
            stdout, stderr = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                self.assertEqual(main(["--input", str(input_path), "--store", str(store_path),
                                       "--thresholds", ".1", "--ks", "100"]), 2)
            self.assertEqual(stdout.getvalue(), "")
            self.assertNotIn(str(self.root), stderr.getvalue())
            self.assertNotIn("Traceback", stderr.getvalue())

    def test_explicit_grid_and_input_validation(self):
        for thresholds, ks, ns, seed in (([], [100], [15, 50], 0), ([float("nan")], [100], [15], 0),
                                         ([.1], [0], [15], 0), ([.1], [100], [0], 0), ([.1], [100], [15], -1)):
            with patch("beets_mix.evaluate.Store") as opener, self.assertRaises(ValueError):
                evaluate(self.data, store=self.store, thresholds=thresholds, ks=ks, ns=ns, seed=seed)
            opener.assert_not_called()
        self.items[0]["album_id"] = 0
        with patch("beets_mix.evaluate.Store") as opener, self.assertRaisesRegex(ValueError, "album_id"):
            self.run_eval()
        opener.assert_not_called()


class PureProtocol(unittest.TestCase):
    def test_rounding_minimum_and_stable_streams(self):
        for size, hidden_count in ((3, 2), (10, 2), (11, 3), (16, 4)):
            training, hidden = make_split(range(size), seed=0, playlist="p", trial=0)
            self.assertEqual(len(hidden), hidden_count)
            self.assertEqual(len(training) + len(hidden), size)
            self.assertEqual((training, hidden), make_split(reversed(range(size)), seed=0, playlist="p", trial=0))
        for size in (0, 1, 2):
            self.assertIsNone(make_split(range(size), seed=0, playlist="p", trial=0))
        self.assertNotEqual(make_split(range(30), seed=0, playlist="p", trial=0), make_split(range(30), seed=0, playlist="p", trial=1))
        random = random_rank(range(30), seed=0, playlist="p", trial=0)
        self.assertEqual(len(random), len(set(random)))
        self.assertEqual(set(random), set(range(30)))
        self.assertEqual(random, random_rank(reversed(range(30)), seed=0, playlist="p", trial=0))
        self.assertNotEqual(random, random_rank(range(30), seed=0, playlist="p", trial=1))
        self.assertNotEqual(random, random_rank(range(30), seed=0, playlist="other", trial=0))
        self.assertEqual(random_rank([], seed=0, playlist="p", trial=0), [])

    def test_centroid_cosine_ties_zero_mean(self):
        vectors = {1: np.array([1., 0.]), 2: np.array([0., 1.]),
                   3: np.array([1., 1.]) / np.sqrt(2), 4: np.array([1., 0.]),
                   5: np.array([1., 0.]), 6: np.array([-1., 0.])}
        self.assertEqual(centroid_rank([5, 4, 3], [1, 2], vectors), [3, 4, 5])
        self.assertEqual(centroid_rank([5, 3, 4], [1, 6], vectors), [3, 4, 5])

    def test_unique_album_denominator_and_item_fallback(self):
        albums = {1: ("album", 10), 2: ("album", 10), 3: ("item", 3), 4: ("item", 4), 5: ("album", 10)}
        result = recall([1, 5], [1, 2, 3], [1], albums)
        self.assertEqual(result["track_recall"], 1 / 3)
        self.assertEqual(result["eligible_track_recall"], 1)
        self.assertEqual(result["album_recall"], .5)
        self.assertEqual(result["album_hits"], 1)
        self.assertEqual(recall([4], [3], [], albums)["album_recall"], 0)

    def test_macro_nulls_and_best_objective(self):
        configs = [{"cluster_threshold": .2, "k": 100}, {"cluster_threshold": .1, "k": 100}, {"cluster_threshold": .1, "k": 2}]
        playlists = []
        for name, values in (("a", [1., 0.]), ("b", [1.]), ("skip", [])):
            trials = []
            for value in values:
                rows = [{"configuration": config, "n": n, "method": method,
                         "track_recall": value, "album_recall": value, "eligible_track_recall": None,
                         "recommendation_count": 2} for config in configs for n in (15, 50) for method in ("mix", "centroid", "random")]
                trials.append({"status": "ok", "results": rows})
            if not trials:
                trials = [{"status": "skipped", "results": []}]
            playlists.append({"name": name, "trials": trials})
        summary = aggregate(playlists, configs, [15, 50])
        self.assertEqual(summary[0]["macro"]["track_recall"], {"mean": .75, "valid": 2, "null": 1})
        self.assertEqual(summary[0]["macro"]["eligible_track_recall"], {"mean": None, "valid": 0, "null": 3})
        self.assertEqual(best_observed(summary, configs)["configuration"], configs[2])
        # Primary track@15 wins even with worse later objectives.
        next(r for r in summary if r["configuration"] == configs[0] and r["n"] == 15 and r["method"] == "mix")["macro"]["track_recall"]["mean"] = .8
        self.assertEqual(best_observed(summary, configs)["configuration"], configs[0])
        self.assertIsNone(best_observed(aggregate(playlists, configs, [15]), configs)["configuration"])


if __name__ == "__main__":
    unittest.main()
