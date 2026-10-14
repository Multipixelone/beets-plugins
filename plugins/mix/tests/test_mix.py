"""Offline fixtures: production dimensions at Store boundary, tiny pure math."""

import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from beets_embed.store import Store, fingerprint, model_ids

from beets_mix import extend
from beets_mix.cluster import cluster_seeds
from beets_mix.filters import duplicate, filter_candidates, normalize
from beets_mix.rank import allocate_shares, rank_cluster, rerank_pool, select, zscores
from beets_mix.vectors import load_head_metadata, normalized


def item(i, **changes):
    return {**dict(id=i, path=f"/{i}.wav", artist=f"artist {i}", albumartist="",
                title=f"song {i}", album="album", year=2000, length=180.0,
                mb_trackid=f"mb-{i}", plex_ratingkey=i, plex_userrating=0,
                plex_skipcount=0, plex_viewcount=0), **changes}


def direction(size, axis=0):
    vector = np.zeros(size, dtype="f4")
    vector[axis] = 1
    return vector


class Filters(unittest.TestCase):
    def eligible(self, candidate, *, seeds=None, text=None, top_styles=None, plex=False):
        return filter_candidates([candidate], playlist_tracks=seeds or [item(1)],
                                 vectors={candidate["id"]: np.ones(2)}, text_vectors=text,
                                 top_styles=top_styles, plex_target=plex, shortest_seed_length=(seeds or [item(1)])[0]["length"])

    def test_rating_and_skip_boundaries(self):
        for rating, kept in [(0, True), (0.1, False), (4, False), (4.01, True), (10, True)]:
            self.assertEqual(bool(self.eligible(item(2, plex_userrating=rating))[0]), kept)
        for skip, view, kept in [(2, 0, True), (3, 3, False), (3, 4, True), (4, 3, False)]:
            self.assertEqual(bool(self.eligible(item(2, plex_skipcount=skip, plex_viewcount=view))[0]), kept)

    def test_floor_link_heads_and_originals(self):
        for seed_length, length, kept in [(30, 25, True), (30, 24, True), (30, 23.9, False),
                                          (180, 40, False), (180, 60, True)]:
            self.assertEqual(bool(self.eligible(item(2, length=length), seeds=[item(1, length=seed_length)])[0]), kept)
        self.assertTrue(self.eligible(item(2, plex_ratingkey=None))[0])
        self.assertEqual(self.eligible(item(2, plex_ratingkey=None), plex=True)[1]["not_plex_linked"], 1)
        self.assertEqual(self.eligible(item(2), top_styles={2: "Non-Music---Speech"})[1]["non_music"], 1)
        self.assertTrue(self.eligible(item(2), top_styles={2: "Rock"})[0])
        self.assertTrue(self.eligible(item(2), top_styles={})[0])
        self.assertEqual(self.eligible(item(1))[1]["in_playlist"], 1)
        self.assertEqual(self.eligible(item(2), text={})[1]["no_vector"], 1)

    def test_duplicates_conservative_exact(self):
        original = item(1, artist="Band", title="Song", mb_trackid="same")
        self.assertTrue(duplicate(item(2, mb_trackid="same"), original))
        for title in ("Song (Live)", "Song - 2011 Remaster", " SONG [Demo] ", "Song (Remastered 2020)"):
            self.assertTrue(duplicate(item(2, artist="band", title=title, mb_trackid=""), original))
            self.assertFalse(duplicate(item(2, artist="band", title=title, mb_trackid="different"), original))
        self.assertTrue(duplicate(item(2, artist="band", title="Song", mb_trackid="other"), {**original, "mb_trackid": ""}))
        for title in ("Song Two", "Song (Part II)", "Song - Another Story", "Songbird", "Song-Live"):
            self.assertFalse(duplicate(item(2, artist="Band", title=title, mb_trackid=""), original))
        self.assertEqual(normalize("A (Love) - Story"), "a (love) - story")

    def test_empty_brackets_through_duplicates_and_filters(self):
        for suffix in ("()", "[]", "( )", "[ ]"):
            self.assertEqual(normalize(f"Song {suffix}"), f"song {suffix}")
            for field in ("title", "artist"):
                for missing_side in ("candidate", "original"):
                    original, candidate = item(1), item(2)
                    original.update(artist="Band", title="Song")
                    candidate.update(artist="Band", title="Song")
                    original[field] += " " + suffix
                    candidate[field] += " " + suffix
                    (candidate if missing_side == "candidate" else original)["mb_trackid"] = ""
                    with self.subTest(suffix=suffix, field=field, missing_side=missing_side):
                        self.assertTrue(duplicate(candidate, original))
                        self.assertEqual(self.eligible(candidate, seeds=[original])[1]["version_duplicate"], 1)
                        candidate[field] = "Different " + suffix
                        self.assertFalse(duplicate(candidate, original))
                        self.assertTrue(self.eligible(candidate, seeds=[original])[0])
        self.assertEqual(normalize("Song () (Live)"), "song ()")


class ClustersAndRanking(unittest.TestCase):
    def test_blobs_and_determinism(self):
        vectors = {i: np.array([1., 0.]) if i < 40 else np.array([0., 1.]) for i in range(60)}
        expected = [tuple(range(40)), tuple(range(40, 60))]
        self.assertEqual(cluster_seeds(range(60), vectors, distance_threshold=0.1), expected)
        self.assertEqual(cluster_seeds(reversed(range(60)), vectors, distance_threshold=0.1), expected)
        self.assertEqual(cluster_seeds(range(40), vectors, distance_threshold=0.1), [tuple(range(40))])

    def test_singletons_below_and_at_eight(self):
        vectors = {i: direction(8, i) for i in range(8)}
        self.assertEqual(len(cluster_seeds(range(7), vectors, distance_threshold=0)), 7)
        clusters = cluster_seeds(range(8), vectors, distance_threshold=0)
        self.assertTrue(all(len(c) > 1 for c in clusters))
        self.assertEqual(clusters, cluster_seeds(reversed(range(8)), vectors, distance_threshold=0))
        vectors = {i: np.array([1., 0.]) for i in range(7)}
        vectors[7] = np.array([0., 1.])
        self.assertEqual(cluster_seeds(range(8), vectors, distance_threshold=.1), [tuple(range(8))])

    def test_allocation(self):
        self.assertEqual(allocate_shares([tuple(range(40)), tuple(range(40, 60))], 15), [10, 5])
        self.assertEqual(allocate_shares([(1, 2, 3), (4, 5), (6,)], 2), [1, 1, 0])
        self.assertEqual(allocate_shares([tuple(range(100)), (101,), (102,)], 4), [2, 1, 1])
        self.assertEqual(allocate_shares([(1, 2), (3, 4), (5, 6)], 5), [2, 2, 1])

    def test_support_and_ties(self):
        vectors = {1: np.array([1., 0.]), 2: np.array([0., 1.]),
                   3: np.array([1., 1.]) / np.sqrt(2), 4: np.array([1., 0.]),
                   5: np.array([1., 0.])}
        ranked = rank_cluster([item(5), item(4), item(3)], [2, 1], vectors, k=3)
        self.assertEqual([r["item_id"] for r in ranked], [3, 4, 5])
        self.assertAlmostEqual(ranked[0]["support"], 1 / np.sqrt(2))
        self.assertEqual(ranked[0]["nearest_seed_id"], 1)
        top_one = rank_cluster([item(5), item(4), item(3)], [2, 1], vectors, k=1)
        self.assertEqual([r["item_id"] for r in top_one], [4, 3])
        self.assertAlmostEqual(top_one[1]["support"], 1 / (2 * np.sqrt(2)))
        # Same support, greater max single-seed cosine wins before item ID.
        v = {1: np.array([1., 0.]), 2: np.array([0., 1.]),
             3: np.array([.5, .5]), 4: np.array([1., 0.])}
        self.assertEqual([r["item_id"] for r in rank_cluster([item(3), item(4)], [1, 2], v, k=2)], [4, 3])

    def test_steering_pool_zero_constant_and_fresh(self):
        ranked = [{"item_id": i, "support": 1 - i / 100, "max_similarity": .9, "nearest_seed_id": 99} for i in range(1, 22)]
        tracks = {i: item(i, plex_viewcount=int(i != 10)) for i in range(1, 22)}
        texts = {i: np.array([float(i), 0]) for i in tracks}
        zero = rerank_pool(ranked, 1, tracks, text_vectors=texts, steer_vector=np.array([1., 0]), weight=0)
        self.assertEqual(zero, ranked[:10])
        steered = rerank_pool(ranked, 1, tracks, text_vectors=texts, steer_vector=np.array([1., 0]), weight=1)
        self.assertEqual(steered[0]["item_id"], 10)
        self.assertEqual({r["item_id"] for r in steered}, set(range(1, 11)))
        self.assertEqual(zscores([2., 2.]).tolist(), [0., 0.])
        constant = rerank_pool(ranked, 1, tracks, text_vectors={i: np.ones(2) for i in tracks}, steer_vector=np.ones(2), weight=1)
        self.assertEqual([r["item_id"] for r in constant], list(range(1, 11)))
        fresh = rerank_pool(ranked, 1, tracks, fresh=True)
        self.assertEqual({r["item_id"] for r in fresh}, set(range(1, 11)))

    def test_global_cap_fallback_duplicates_and_shortfall(self):
        tracks = {i: item(i, artist="same" if i < 4 else f"a{i}") for i in range(1, 8)}
        tracks[2]["albumartist"] = " SAME "
        row = lambda i: {"item_id": i}
        pools = [[row(1), row(2), row(3)], [row(1), row(4), row(5), row(6)], [row(7)]]
        selected, capped = select(pools, [2, 1, 1], [(11, 12, 13), (14, 15), (16,)], tracks, max_per_artist=1)
        self.assertEqual([(i, r["item_id"]) for i, r in selected], [(0, 1), (1, 4), (1, 5), (2, 7)])
        self.assertEqual(capped, 2)
        self.assertEqual(len({r["item_id"] for _, r in selected}), 4)

    def test_fresh_bonus_changes_close_order_only_inside_pool(self):
        scores = [.9, .899] + [.1] * 9
        ranked = [{"item_id": i, "support": score, "max_similarity": score, "nearest_seed_id": 99}
                  for i, score in enumerate(scores, 1)]
        tracks = {i: item(i, plex_viewcount=0 if i in (2, 11) else 1) for i in range(1, 12)}
        plain = rerank_pool(ranked, 1, tracks)
        fresh = rerank_pool(ranked, 1, tracks, fresh=True)
        self.assertEqual([row["item_id"] for row in plain[:2]], [1, 2])
        self.assertEqual([row["item_id"] for row in fresh[:2]], [2, 1])
        self.assertEqual({row["item_id"] for row in fresh}, set(range(1, 11)))


class Integrated(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / "store.sqlite3"
        self.models = model_ids()
        self.tracks = []
        with Store(self.path) as store:
            for i in range(1, 8):
                path = self.root / f"{i}.wav"
                path.write_bytes(b"synthetic audio")
                self.tracks.append(item(i, path=str(path)))
                heads = {"discogs400": {"labels": ["Jazz", "Non-Music---Speech"], "scores": [.9, .1]},
                         "moodtheme": {"labels": ["calm"], "scores": [.8]}}
                store.put(i, fingerprint(path), self.models["style"], direction(1280), np.zeros(1280), heads)
                if i != 3:
                    store.put(i, fingerprint(path), self.models["text"], direction(512), np.zeros(512))

    def run_mix(self, **kwargs):
        return extend(self.tracks, [1], store=self.path, cluster_threshold=.1, n=3, **kwargs).to_dict()

    def test_shape_readonly_invariants_and_existing_artists(self):
        db_before = self.path.read_bytes()
        self.tracks[0]["artist"] = self.tracks[1]["artist"] = "same existing artist"
        before = copy.deepcopy(self.tracks)
        proposal = self.run_mix()
        self.assertIn(2, [r["item_id"] for r in proposal["proposal"]])
        self.assertEqual(before, self.tracks)
        self.assertEqual(db_before, self.path.read_bytes())
        self.assertEqual(proposal["schema"], "beets-mix.proposal.v1")
        self.assertEqual(proposal["models"], {"style": self.models["style"], "text": None})
        self.assertEqual(proposal["clusters"][0]["top_styles"], ["Jazz", "Non-Music---Speech"])
        self.assertEqual(proposal["clusters"][0]["top_moods"], ["calm"])
        self.assertEqual(proposal["seed"]["with_vectors"], 1)
        self.assertEqual(proposal["excluded_counts"]["in_playlist"], 1)
        for row in proposal["proposal"]:
            self.assertEqual(set(row), {"n", "item_id", "plex_ratingkey", "artist", "title", "album", "year", "cluster", "support", "nearest_seed"})
            self.assertEqual(row["nearest_seed"], {"item_id": 1, "title": "song 1"})
        self.assertGreaterEqual(proposal["elapsed_ms"], 0)
        json.dumps(proposal, allow_nan=False)
        with Store(self.path) as store:
            with self.assertRaisesRegex(ValueError, "query_only"):
                extend(self.tracks, [1], store=store, cluster_threshold=.1)
        with Store(self.path, readonly=True) as store:
            store.db.execute("PRAGMA query_only=ON")
            self.assertEqual(extend(self.tracks, [1], store=store, cluster_threshold=.1).to_dict()["models"], proposal["models"])
            with self.assertRaises(Exception):
                store.db.execute("DELETE FROM vectors")

    def test_integrated_weight_zero_and_missing_heads(self):
        tracks = [t for t in self.tracks if t["id"] != 3]
        plain = extend(tracks, [1], store=self.path, cluster_threshold=.1).to_dict()
        zero = extend(tracks, [1], store=self.path, cluster_threshold=.1,
                      steer_vector=direction(512), text_model_id=self.models["text"], steer_weight=0).to_dict()
        self.assertEqual(plain["proposal"], zero["proposal"])
        with Store(self.path) as store:
            store.db.execute("UPDATE vectors SET heads=? WHERE model=?", (b"", self.models["style"]))
            store.db.commit()
        result = extend(tracks, [1], store=self.path, cluster_threshold=.1).to_dict()
        self.assertEqual(result["clusters"][0]["top_styles"], [])
        self.assertEqual(result["proposal"], plain["proposal"])

    def test_missing_text_still_excluded_with_zero_weight(self):
        plain = self.run_mix()
        zero = self.run_mix(steer_vector=direction(512), text_model_id=self.models["text"], steer_weight=0)
        self.assertIn(3, [row["item_id"] for row in plain["proposal"]])
        self.assertNotIn(3, [row["item_id"] for row in zero["proposal"]])
        self.assertEqual(zero["excluded_counts"]["no_vector"], 1)
        common = [t for t in self.tracks if t["id"] != 3]
        unsteered_common = extend(common, [1], store=self.path, cluster_threshold=.1, n=3).to_dict()
        self.assertEqual(zero["proposal"], unsteered_common["proposal"])

    def test_production_heads_retained_only_for_usable_seeds(self):
        path = self.root / "production-heads.sqlite3"
        labels = ["Non-Music---Speech", "Jazz"] + [f"ZStyle{i:03}" for i in range(398)]
        with Store(path) as store:
            for track in self.tracks:
                i = track["id"]
                scores = [.1, .9] + [0.] * 398
                if i == 3:
                    scores[0] = .9  # Equal tops: Jazz wins by label, not insertion order.
                if i == 4:
                    scores[:2] = [.9, .1]
                store.put(i, fingerprint(track["path"]), self.models["style"], direction(1280), np.zeros(1280),
                          {"discogs400": {"labels": labels, "scores": scores},
                           "moodtheme": {"labels": ["calm", "happy"], "scores": [.8, .2]}})
            store.db.execute("UPDATE vectors SET heads=? WHERE item_id=6", (b"bad",))
            store.db.execute("UPDATE vectors SET heads=? WHERE item_id=7", (b"",))
            store.db.commit()
        with Store(path, readonly=True) as store:
            heads, top_styles = load_head_metadata(store, self.tracks, self.models["style"], [1, 2])
        self.assertEqual(set(heads), {1, 2})
        self.assertEqual(sum(len(h["discogs400"]) for h in heads.values()), 2 * 400)
        self.assertEqual(len(top_styles), len(self.tracks))
        self.assertTrue(all(isinstance(label, str) for label in top_styles.values()))
        self.assertEqual(top_styles[3], "Jazz")
        self.assertEqual(top_styles[4], "Non-Music---Speech")
        self.assertEqual(top_styles[6], "")
        self.assertEqual(top_styles[7], "")
        with patch("beets_mix.api.load_head_metadata", wraps=load_head_metadata) as reader:
            result = extend(self.tracks, [1, 2, 999], store=path, cluster_threshold=.1).to_dict()
        self.assertEqual(reader.call_args.args[3], [1, 2])
        self.assertEqual(result["clusters"][0]["top_styles"], ["Jazz", "Non-Music---Speech"])
        self.assertEqual(result["clusters"][0]["top_moods"], ["calm", "happy"])
        self.assertEqual(result["excluded_counts"]["non_music"], 1)
        self.assertEqual([row["item_id"] for row in result["proposal"]], [3, 5, 6, 7])

    def test_metadata_rejected_before_store_work(self):
        invalid = (Path("playlist"), float("nan"), float("inf"), [], {}, {"value"}, object(), True)
        cases = []
        for value in invalid:
            cases.extend([{"target_metadata": {"playlist": value}}, {"seed_metadata": {"source": value}},
                          {"seed_metadata": {"unresolved": [{"title": value}]}}])
        for value in (Path("key"), float("nan"), 1.5, [], {}, True):
            cases.extend([{"target_metadata": {"plex_ratingkey": value}},
                          {"seed_metadata": {"plex_ratingkey": value}},
                          {"seed_metadata": {"unresolved": [{"plex_ratingkey": value}]}}])
        cases.extend([{"target_metadata": []}, {"seed_metadata": []},
                      {"seed_metadata": {"unresolved": None}}, {"seed_metadata": {"unresolved": [None]}},
                      {"seed_metadata": {"unresolved": [{"unknown": "x"}]}},
                      {"target_metadata": {"plex": 1}}, {"seed_metadata": {"playlist": None}}])
        for kwargs in cases:
            with self.subTest(kwargs=kwargs), patch("beets_mix.api.Store") as opener:
                with self.assertRaises(ValueError):
                    self.run_mix(**kwargs)
                opener.assert_not_called()

    def test_metadata_strict_json_and_owned_inputs(self):
        seed = {"source": "plex", "playlist": "fixture", "plex_ratingkey": 123,
                "unresolved": [{"plex_ratingkey": "456", "title": "unresolved"}, {"plex_ratingkey": None}]}
        target = {"plex": True, "playlist": "fixture", "plex_ratingkey": "123"}
        original_tracks, original_seed, original_target = copy.deepcopy((self.tracks, seed, target))
        proposal = extend(self.tracks, [1], store=self.path, cluster_threshold=.1,
                          seed_metadata=seed, target_metadata=target)
        baseline = proposal.to_dict()
        json.dumps(baseline, allow_nan=False)
        self.assertEqual((self.tracks, seed, target), (original_tracks, original_seed, original_target))
        seed["unresolved"][0]["title"] = "changed"
        seed["unresolved"].append({"title": "extra"})
        seed["source"] = "changed"
        target["playlist"] = "changed"
        self.tracks[1]["title"] = "changed"
        self.assertEqual(proposal.to_dict(), baseline)
        emitted = proposal.to_dict()
        emitted["seed"]["unresolved"][0]["title"] = "changed copy"
        self.assertEqual(proposal.to_dict(), baseline)
        json.dumps(proposal.to_dict(), allow_nan=False)

    def test_tiny_steering_vector_rejected_before_store_work(self):
        with patch("beets_mix.api.Store") as opener, self.assertRaises(ValueError):
            self.run_mix(steer_vector=direction(512) * 1e-20, text_model_id=self.models["text"])
        opener.assert_not_called()
        result = self.run_mix(steer_vector=direction(512) * 1e-10, text_model_id=self.models["text"])
        json.dumps(result, allow_nan=False)

    def test_stale_missing_text_seed_losses_and_all_original_exclusions(self):
        Path(self.tracks[1]["path"]).write_bytes(b"changed size")
        Path(self.tracks[6]["path"]).unlink()
        proposal = extend(self.tracks, [1, 7, 999], store=self.path, cluster_threshold=.1,
                          playlist_tracks=[self.tracks[0], self.tracks[6]]).to_dict()
        self.assertEqual(proposal["seed"]["losses"], [{"item_id": 7, "reason": "no_vector"}, {"item_id": 999, "reason": "unresolved"}])
        self.assertEqual(proposal["excluded_counts"]["no_vector"], 1)
        self.assertEqual(proposal["excluded_counts"]["in_playlist"], 2)
        self.assertIn(3, [r["item_id"] for r in proposal["proposal"]])
        steered = self.run_mix(steer_vector=direction(512), text_model_id=self.models["text"], steer="calm")
        self.assertNotIn(3, [r["item_id"] for r in steered["proposal"]])
        self.assertEqual(steered["excluded_counts"]["no_vector"], 3)
        # Seeds do not need text and are never filtered for rating/length/link.
        self.tracks[2].update(plex_userrating=4, length=30, plex_ratingkey=None, plex_skipcount=9)
        result = extend(self.tracks, [3], store=self.path, cluster_threshold=.1,
                        steer_vector=direction(512), text_model_id=self.models["text"], target_metadata={"plex": True}).to_dict()
        self.assertEqual(result["seed"]["with_vectors"], 1)

    def test_existing_playlist_artist_does_not_consume_cap(self):
        for track in self.tracks:
            track["artist"] = "same artist"
        result = extend(self.tracks, [1, 2, 3, 4, 5], store=self.path,
                        cluster_threshold=.1, n=2).to_dict()
        self.assertEqual([r["item_id"] for r in result["proposal"]], [6, 7])

    def test_adaptive_floor_uses_only_usable_seeds_and_text_identity(self):
        self.tracks[1]["length"] = 10
        Path(self.tracks[1]["path"]).write_bytes(b"stale shorter seed")
        self.tracks[2]["length"] = 40
        result = extend(self.tracks, [1, 2], store=self.path, cluster_threshold=.1).to_dict()
        self.assertEqual(result["excluded_counts"]["too_short"], 1)
        self.assertEqual(result["seed"]["losses"], [{"item_id": 2, "reason": "no_vector"}])
        result = self.run_mix(steer_vector=direction(512), text_model_id="text:" + "0" * 64)
        self.assertEqual(result["proposal"], [])
        self.assertEqual(result["models"]["text"], "text:" + "0" * 64)

    def test_dimensions_zero_nonfinite_and_invalid_heads(self):
        with Store(self.path) as store:
            for i, value in [(2, direction(4)), (3, np.zeros(1280))]:
                store.put(i, fingerprint(self.tracks[i - 1]["path"]), self.models["style"], value, np.zeros_like(value),
                          {"discogs400": {"labels": ["Jazz", "Non-Music---Speech"], "scores": [.9, .1]},
                           "moodtheme": {"labels": ["calm"], "scores": [.8]}})
            store.db.execute("UPDATE vectors SET mean=? WHERE item_id=4 AND model=?", (np.full(1280, np.nan, dtype="<f2").tobytes(), self.models["style"]))
            store.db.execute("UPDATE vectors SET heads=? WHERE item_id=5 AND model=?", (b"bad", self.models["style"]))
            store.db.commit()
        proposal = self.run_mix()
        self.assertEqual(proposal["excluded_counts"]["no_vector"], 3)
        self.assertIn(5, [r["item_id"] for r in proposal["proposal"]])
        for value in (np.zeros(512), np.full(512, np.nan), np.ones(511)):
            with self.assertRaises(ValueError):
                self.run_mix(steer_vector=value, text_model_id=self.models["text"])
        with self.assertRaises(ValueError):
            normalized(np.full(512, np.inf), 512)

    def test_models_arguments_no_seeds_and_target(self):
        for kwargs in ({"k": 0}, {"max_per_artist": 0}, {"steer_weight": -1}, {"steer_weight": float("nan")},
                       {"fresh": 1}, {"style_model_id": "style:wrong"}, {"steer_vector": direction(512)},
                       {"text_model_id": self.models["text"]}, {"target_metadata": {"plex": "yes"}}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.run_mix(**kwargs)
        for n, threshold in [(0, .1), (True, .1), (1, -1), (1, 2.1), (1, float("nan"))]:
            with self.assertRaises(ValueError):
                extend(self.tracks, [1], store=self.path, n=n, cluster_threshold=threshold)
        with self.assertRaises(TypeError):
            extend(self.tracks, [1], store=self.path)
        with self.assertRaisesRegex(ValueError, "No usable"):
            extend(self.tracks, [999], store=self.path, cluster_threshold=.1)
        with self.assertRaisesRegex(ValueError, "No usable"):
            extend(self.tracks, [1], store=self.path, cluster_threshold=.1, style_model_id="style:" + "0" * 64)
        with self.assertRaisesRegex(ValueError, "Incomplete"):
            extend([{"id": 1}], [1], store=self.path, cluster_threshold=.1)
        self.tracks[1]["plex_ratingkey"] = None
        result = self.run_mix(target_metadata={"plex": True, "playlist": "fixture"})
        self.assertEqual(result["excluded_counts"]["not_plex_linked"], 1)


if __name__ == "__main__":
    unittest.main()
