"""Pure mapping tests; full snapshot validation remains in the existing API."""

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
from beets_embed.store import Store, fingerprint, model_ids

from beets_mix import extend
from beets_mix.api import metadata
from beets_mix.plex import PlaylistSnapshot
from beets_mix.seeds import SeedResolution, from_plex, from_query


def row(item_id, key):
    return {"id": item_id, "plex_ratingkey": key, "title": "local song",
            "path": f"/{item_id}.flac", "extra": {"nested": []}}


def playlist(*keys):
    return PlaylistSnapshot("Mix", "99", tuple(
        {"plex_ratingkey": key, "title": f"entry {index}"}
        for index, key in enumerate(keys)), object())


class Seeds(unittest.TestCase):
    def test_unique_canonical_mapping_and_metadata(self):
        result = from_plex([row(1, "0007"), row(2, 8)], playlist(7, "008"))
        self.assertIsInstance(result, SeedResolution)
        self.assertEqual(result.seed_item_ids, [1, 2])
        self.assertEqual([r["plex_ratingkey"] for r in result.items], ["7", "8"])
        self.assertEqual([r["plex_ratingkey"] for r in result.playlist_tracks], ["7", "8"])
        self.assertEqual(result.seed_metadata, {"source": "plex", "playlist": "Mix",
            "plex_ratingkey": "99", "unresolved": []})
        self.assertEqual(result.target_metadata, {"plex": True, "playlist": "Mix", "plex_ratingkey": "99"})
        self.assertEqual(metadata(result.seed_metadata, seed=True), result.seed_metadata)
        self.assertEqual(metadata(result.target_metadata, seed=False), result.target_metadata)
        json.dumps(result.diagnostics, allow_nan=False)

    def test_full_library_collision_quarantine_including_nonseed_groups(self):
        rows = [row(1, 1), row(2, 2), row(3, "002"), row(4, 4), row(5, "004"), row(6, None)]
        result = from_plex(rows, playlist(1, 2))
        self.assertEqual([r["id"] for r in result.items], [1, 6])
        self.assertEqual(result.seed_item_ids, [1])
        self.assertEqual(result.diagnostics["quarantined_item_ids"], [2, 3, 4, 5])
        self.assertEqual(result.diagnostics["quarantined_count"], 4)
        self.assertEqual(result.diagnostics["ambiguous_key_count"], 2)
        self.assertEqual(result.diagnostics["ambiguous_count"], 1)

    def test_unmapped_versus_ambiguous_and_bad_keys(self):
        result = from_plex([row(1, 1), row(2, 2), row(3, "02")], playlist(1, 2, 99, None, "/1"))
        d = result.diagnostics
        self.assertEqual(d["raw_entries"], 5)
        self.assertEqual(d["resolved_occurrences"], 1)
        self.assertEqual(d["unresolved_count"], 4)
        self.assertEqual(d["ambiguous_count"], 1)
        self.assertEqual(d["unmapped_count"], 3)
        self.assertEqual(d["ambiguous"][0]["plex_ratingkey"], "2")
        self.assertEqual(result.seed_metadata["unresolved"], d["unresolved"])

    def test_raw_duplicates_dedup_engine_but_count_all_occurrences(self):
        result = from_plex([row(1, 1)], playlist(1, "001", 9, 9))
        self.assertEqual(result.seed_item_ids, [1])
        self.assertEqual(len(result.playlist_tracks), 1)
        self.assertEqual(result.diagnostics["raw_entries"], 4)
        self.assertEqual(result.diagnostics["resolved_occurrences"], 2)
        self.assertEqual(result.diagnostics["duplicate_resolved_occurrences"], 1)
        self.assertEqual(result.diagnostics["unresolved_count"], 2)

    def test_near_keys_not_accidentally_linked(self):
        rows = [row(1, 1)] + [row(i + 2, key) for i, key in enumerate(
            [True, 1.0, "١", "+1", " 1", "/library/metadata/1", "0", None])]
        result = from_plex(rows, playlist(1))
        self.assertEqual(result.seed_item_ids, [1])
        self.assertEqual(result.diagnostics["quarantined_count"], 0)
        self.assertEqual(len(result.items), len(rows))
        self.assertEqual([r["plex_ratingkey"] for r in result.items], ["1"] + [None] * 8)

    def test_zero_resolved_safe_generic(self):
        for rows, snap in [([], playlist(1)), ([row(1, 1), row(2, "01")], playlist(1)),
                           ([row(1, 1)], playlist())]:
            with self.assertRaisesRegex(ValueError, "^No resolved seed items$"):
                from_plex(rows, snap)

    def test_original_rows_kept_without_any_vector_lookup(self):
        rows = [row(1, 1), row(2, 2)]
        result = from_plex(rows, playlist(2, 1))
        self.assertEqual(result.playlist_tracks,
                         [{**rows[1], "plex_ratingkey": "2"}, {**rows[0], "plex_ratingkey": "1"}])
        self.assertEqual([r["plex_ratingkey"] for r in rows], [1, 2])

    def test_inputs_and_nested_rows_owned(self):
        rows, snap = [row(1, 1)], playlist(1, 9)
        before_rows, before_entries = deepcopy(rows), deepcopy(snap.entries)
        result = from_plex(rows, snap)
        self.assertEqual(rows, before_rows)
        self.assertEqual(snap.entries, before_entries)
        result.items[0]["extra"]["nested"].append("changed")
        result.playlist_tracks[0]["extra"]["nested"].append("original changed")
        result.seed_metadata["unresolved"][0]["title"] = "changed"
        self.assertEqual(rows, before_rows)
        self.assertEqual(snap.entries, before_entries)
        self.assertEqual(result.diagnostics["unresolved"][0]["title"], "entry 1")
        self.assertNotIn("_handle", repr(result))

    def test_query_no_implicit_target_or_quarantine(self):
        rows = [row(1, 1), row(2, "01")]
        result = from_query(rows, [2, 1, 2])
        self.assertEqual(result.items, rows)
        self.assertEqual(result.seed_item_ids, [2, 1])
        self.assertEqual(result.seed_metadata, {"source": "query"})
        self.assertEqual(result.target_metadata, {})
        self.assertEqual(result.diagnostics["quarantined_count"], 0)
        result.items[0]["extra"]["nested"].append("changed")
        self.assertEqual(rows[0]["extra"]["nested"], [])

    def test_query_zero_resolved_and_invalid_ids(self):
        for ids in [[], [99], [True], [0], ["1"]]:
            with self.subTest(ids=ids), self.assertRaises(ValueError):
                from_query([row(1, 1)], ids)


class SeedsWithEngine(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        self.store_path = root / "store.sqlite3"
        self.bad_keys = ["0", "000", "bad-key", "/library/metadata/2", -1,
                         "١", "+2", " 2", None]
        keys = [1, *self.bad_keys, True, 1.0, "0002", 3, "003", 4, "004"]
        self.valid_id = len(keys) - 4
        self.quarantined = list(range(self.valid_id + 1, len(keys) + 1))
        self.rows = []
        vector = np.zeros(1280, dtype="f4")
        vector[0] = 1
        with Store(self.store_path) as store:
            for item_id, key in enumerate(keys, 1):
                path = root / f"{item_id}.wav"
                path.write_bytes(b"synthetic audio")
                self.rows.append({**row(item_id, key), "path": str(path),
                    "artist": f"artist {item_id}", "albumartist": "", "title": f"song {item_id}",
                    "album": "album", "year": 2000, "length": 180.0, "mb_trackid": f"mb-{item_id}",
                    "plex_userrating": 0, "plex_skipcount": 0, "plex_viewcount": 0})
                store.put(item_id, fingerprint(path), model_ids()["style"], vector, np.zeros(1280))
        self.before = deepcopy(self.rows)
        self.store_before = self.store_path.read_bytes()

    def proposal(self, resolution):
        return extend(resolution.items, resolution.seed_item_ids, store=self.store_path,
                      cluster_threshold=.1, n=len(self.rows), k=len(self.rows),
                      playlist_tracks=resolution.playlist_tracks,
                      seed_metadata=resolution.seed_metadata,
                      target_metadata=resolution.target_metadata).to_dict()

    def test_plex_bad_key_candidates_are_unlinked_in_actual_extend(self):
        snap = playlist(1, "001", 3, "bad-key", "/library/metadata/2", 99)
        entries_before = deepcopy(snap.entries)
        rows = [r for r in self.rows if type(r["plex_ratingkey"]) not in (bool, float)]
        resolution = from_plex(rows, snap)
        owned_before = deepcopy(resolution)
        proposal = self.proposal(resolution)
        self.assertEqual([r["item_id"] for r in proposal["proposal"]], [self.valid_id])
        self.assertEqual(proposal["proposal"][0]["plex_ratingkey"], "2")
        self.assertEqual(proposal["excluded_counts"]["not_plex_linked"], len(self.bad_keys))
        self.assertEqual(proposal["excluded_counts"]["no_vector"], 0)
        self.assertEqual(proposal["excluded_counts"]["in_playlist"], 1)
        self.assertEqual(resolution.diagnostics, {
            "raw_entries": 6, "resolved_occurrences": 2, "resolved_unique": 1,
            "duplicate_resolved_occurrences": 1, "unresolved_count": 4,
            "unresolved": [{"plex_ratingkey": key, "title": f"entry {index}"}
                           for index, key in [(2, "3"), (3, None), (4, None), (5, "99")]],
            "ambiguous_count": 1, "ambiguous": [{"plex_ratingkey": "3", "title": "entry 2"}],
            "unmapped_count": 3,
            "unmapped": [{"plex_ratingkey": key, "title": f"entry {index}"}
                         for index, key in [(3, None), (4, None), (5, "99")]],
            "quarantined_item_ids": self.quarantined, "quarantined_count": 4,
            "ambiguous_key_count": 2})
        kept = {r["id"]: r for r in resolution.items}
        self.assertEqual(len(kept), len(rows) - 4)
        self.assertEqual(kept[1]["plex_ratingkey"], "1")
        self.assertEqual(kept[self.valid_id]["plex_ratingkey"], "2")
        self.assertTrue(all(r["plex_ratingkey"] is None for i, r in kept.items()
                            if i not in (1, self.valid_id)))
        self.assertEqual(resolution, owned_before)
        self.assertEqual(self.rows, self.before)
        self.assertEqual(snap.entries, entries_before)
        self.assertEqual(self.store_path.read_bytes(), self.store_before)

    def test_plex_bool_float_keys_become_unlinked_before_engine_ingress(self):
        rows = [r for r in self.rows if type(r["plex_ratingkey"]) in (bool, float)
                or r["id"] in (1, self.valid_id)]
        resolution = from_plex(rows, playlist(1))
        proposal = self.proposal(resolution)
        self.assertEqual([r["item_id"] for r in proposal["proposal"]], [self.valid_id])
        self.assertEqual(proposal["excluded_counts"]["not_plex_linked"], 2)
        self.assertTrue(all(r["plex_ratingkey"] is None for r in resolution.items
                            if r["id"] not in (1, self.valid_id)))
        self.assertEqual(self.rows, self.before)

    def test_query_bad_key_candidates_keep_values_and_remain_eligible(self):
        # Bool/float are intentionally invalid engine ingress; exercise those separately.
        rows = [r for r in self.rows if type(r["plex_ratingkey"]) not in (bool, float)]
        resolution = from_query(rows, [1])
        proposal = self.proposal(resolution)
        self.assertEqual(resolution.items, rows)
        self.assertEqual(resolution.target_metadata, {})
        self.assertEqual(resolution.diagnostics["quarantined_count"], 0)
        self.assertEqual(proposal["excluded_counts"]["not_plex_linked"], 0)
        self.assertEqual(proposal["excluded_counts"]["no_vector"], 0)
        self.assertEqual({r["item_id"] for r in proposal["proposal"]}, {r["id"] for r in rows} - {1})
        self.assertEqual({r["item_id"]: r["plex_ratingkey"] for r in proposal["proposal"]},
                         {r["id"]: r["plex_ratingkey"] for r in rows if r["id"] != 1})
        self.assertEqual(self.rows, self.before)
        self.assertEqual(self.store_path.read_bytes(), self.store_before)

    def test_query_bool_float_keys_preserved_and_still_rejected_by_ingress(self):
        for row in self.rows:
            if type(row["plex_ratingkey"]) not in (bool, float):
                continue
            with self.subTest(key=row["plex_ratingkey"]):
                resolution = from_query([self.rows[0], row], [1])
                self.assertEqual(resolution.items[1]["plex_ratingkey"], row["plex_ratingkey"])
                self.assertIs(type(resolution.items[1]["plex_ratingkey"]), type(row["plex_ratingkey"]))
                with self.assertRaisesRegex(ValueError, "plex_ratingkey must be a string, integer, or null"):
                    self.proposal(resolution)
        self.assertEqual(self.rows, self.before)

    def test_plex_key_normalization_does_not_relax_other_snapshot_fields(self):
        rows = [deepcopy(r) for r in self.rows if r["id"] in (1, self.valid_id)]
        rows[1]["plex_userrating"] = "bad-rating"
        resolution = from_plex(rows, playlist(1))
        with self.assertRaisesRegex(ValueError, "plex_userrating must be finite and nonnegative"):
            self.proposal(resolution)
        self.assertEqual(rows[1]["plex_userrating"], "bad-rating")
        self.assertEqual(self.rows, self.before)


if __name__ == "__main__":
    unittest.main()
