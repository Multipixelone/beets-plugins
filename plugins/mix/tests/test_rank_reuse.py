"""Legacy-exact oracle and resource invariants for bounded K/N reuse.

Numerical/selection bodies below are frozen from 2e9957c rank.py and its
api._prepared_proposal, not imported from the refactored implementation.
Unchanged clustering, snapshot/Store preparation and outer JSON assembly are
deliberately shared; the changed ranking/selection path is independent.
"""

import builtins
from collections import Counter
import copy
import importlib
import json
import unittest
from unittest.mock import patch
import weakref

import numpy as np

from beets_mix import api
from beets_mix.cluster import cluster_seeds
from beets_mix.rank import _candidate_matrix, _rank_cluster_ks, rank_cluster
import test_evaluate as fixtures

evaluation = importlib.import_module("beets_mix.evaluate")


def legacy_rank(candidates, seed_ids, vectors, *, k=100):
    ids = sorted(t["id"] for t in candidates)
    seeds = sorted(seed_ids)
    if not ids or not seeds:
        return []
    matrix = np.stack([vectors[i] for i in ids])
    similarities = matrix @ np.stack([vectors[i] for i in seeds]).T
    support = np.zeros(len(ids), dtype="f8")
    endorsed = np.zeros(len(ids), dtype=bool)
    for column in range(len(seeds)):
        order = sorted(range(len(ids)), key=lambda i: (-float(similarities[i, column]), ids[i]))[:k]
        support[order] += similarities[order, column]
        endorsed[order] = True
    result = []
    for i, item_id in enumerate(ids):
        if endorsed[i]:
            nearest = int(np.argmax(similarities[i]))
            result.append({"item_id": item_id, "support": float(support[i] / len(seeds)),
                           "max_similarity": float(similarities[i, nearest]), "nearest_seed_id": seeds[nearest]})
    return sorted(result, key=lambda r: (-r["support"], -r["max_similarity"], r["item_id"]))


def legacy_allocate(clusters, n):
    if not clusters:
        return []
    order = sorted(range(len(clusters)), key=lambda i: (-len(clusters[i]), clusters[i]))
    if len(clusters) > n:
        return [int(i in order[:n]) for i in range(len(clusters))]
    shares = [0] * len(clusters)
    active, seats = order[:], n
    while active:
        total = sum(len(clusters[i]) for i in active)
        small = [i for i in active if seats * len(clusters[i]) / total < 1]
        if not small:
            quotas = {i: seats * len(clusters[i]) / total for i in active}
            for i in active:
                shares[i] = int(quotas[i])
            remainder = seats - sum(shares[i] for i in active)
            for i in sorted(active, key=lambda i: (-(quotas[i] - shares[i]), order.index(i)))[:remainder]:
                shares[i] += 1
            break
        for i in small:
            shares[i] = 1
            active.remove(i)
            seats -= 1
    return shares


def legacy_zscores(values):
    values = np.asarray(values, dtype="f8")
    std = values.std()
    return (values - values.mean()) / std if std > 1e-8 else np.zeros_like(values)


def legacy_pool(ranked, share, tracks, *, text_vectors=None, steer_vector=None, weight=.3, fresh=False):
    pool = [dict(row) for row in ranked[:10 * share]]
    if not pool or (not fresh and (steer_vector is None or weight == 0)):
        return pool
    support = legacy_zscores([row["support"] for row in pool])
    if steer_vector is not None and weight != 0:
        text = legacy_zscores([float(text_vectors[row["item_id"]] @ steer_vector) for row in pool])
        scores = (1 - weight) * support + weight * text
    else:
        scores = support
    for row, score in zip(pool, scores):
        row["rank_score"] = float(score + (.1 if fresh and tracks[row["item_id"]]["plex_viewcount"] == 0 else 0))
    return sorted(pool, key=lambda r: (-r["rank_score"], -r["support"], -r["max_similarity"], r["item_id"]))


def legacy_select(pools, shares, clusters, tracks, *, max_per_artist=2):
    order = sorted(range(len(clusters)), key=lambda i: (-len(clusters[i]), clusters[i]))
    picked = [[] for _ in clusters]
    used, capped, artists = set(), set(), Counter()
    offsets = [0] * len(clusters)

    def fill(index, count):
        added = 0
        while added < count and offsets[index] < len(pools[index]):
            row = pools[index][offsets[index]]
            offsets[index] += 1
            item_id = row["item_id"]
            if item_id in used:
                continue
            track = tracks[item_id]
            artist = " ".join((track["albumartist"] or track["artist"]).casefold().split())
            if artists[artist] >= max_per_artist:
                capped.add(item_id)
                continue
            picked[index].append(row)
            used.add(item_id)
            artists[artist] += 1
            added += 1
        return added

    shortfalls = []
    for i in order:
        shortfalls.append((i, shares[i] - fill(i, shares[i])))
    for source, missing in shortfalls:
        position = order.index(source)
        recipients = order[position + 1:] + order[:position]
        for i in recipients:
            if not missing:
                break
            missing -= fill(i, missing)
    return [(i, row) for i in order for row in picked[i]], len(capped - used)


def legacy_select_ranked(tracks, clusters, ranked, *, n, text=None, steer_vector=None,
                         steer_weight=.3, fresh=False, max_per_artist=2):
    shares = legacy_allocate(clusters, n)
    pools = [legacy_pool(rows, share, tracks, text_vectors=text, steer_vector=steer_vector,
                         weight=steer_weight, fresh=fresh) for rows, share in zip(ranked, shares)]
    selected, capped = legacy_select(pools, shares, clusters, tracks, max_per_artist=max_per_artist)
    return selected, shares, capped


def legacy_prepared(tracks, usable, style, eligible, *, cluster_threshold, n, k, **options):
    clusters = cluster_seeds(usable, style, distance_threshold=cluster_threshold)
    shares = legacy_allocate(clusters, n)
    # Preserve the original interleaved cluster rank -> pool construction path.
    pools = [legacy_pool(legacy_rank(eligible, ids, style, k=k), share, tracks,
                         text_vectors=options.get("text"), steer_vector=options.get("steer_vector"),
                         weight=options.get("steer_weight", .3), fresh=options.get("fresh", False))
             for ids, share in zip(clusters, shares)]
    selected, capped = legacy_select(pools, shares, clusters, tracks,
                                     max_per_artist=options.get("max_per_artist", 2))
    return selected, clusters, shares, capped


def legacy_threshold(prepared, usable, style, *, cluster_threshold, ks):
    clusters = cluster_seeds(usable, style, distance_threshold=cluster_threshold)
    candidates = [{"id": i} for i in prepared[0]]
    return clusters, {k: [legacy_rank(candidates, ids, style, k=k) for ids in clusters] for k in ks}


def row(i):
    return {"id": i, "artist": f"artist{i}", "albumartist": "", "plex_viewcount": i % 2}


class ExactRanking(unittest.TestCase):
    def compare(self, candidates, seeds, vectors, ks=(1, 50, 100, 200, 999)):
        before = {i: v.copy() for i, v in vectors.items()}
        prepared = _candidate_matrix(candidates, vectors)
        matrix_before = prepared[1].copy() if prepared[1] is not None else None
        ranked = _rank_cluster_ks(prepared, seeds, vectors, ks)
        for k in ks:
            with self.subTest(k=k):
                expected = legacy_rank(candidates, seeds, vectors, k=k)
                self.assertEqual(ranked[k], expected)
                self.assertEqual(rank_cluster(list(reversed(candidates)), list(reversed(seeds)), vectors, k=k), expected)
                for result in ranked[k]:
                    self.assertEqual(set(result), {"item_id", "support", "max_similarity", "nearest_seed_id"})
        for i, original in before.items():
            np.testing.assert_array_equal(vectors[i], original)
        if prepared[1] is not None:
            np.testing.assert_array_equal(prepared[1], matrix_before)
            self.assertTrue(prepared[1].flags.c_contiguous)
            self.assertEqual(prepared[1].dtype, vectors[candidates[0]["id"]].dtype)
        return ranked

    def test_tied_cutoffs_zero_negative_cancelling_and_empty(self):
        vectors = {1: np.array([1., 0.], dtype="f4"), 2: np.array([-1., 0.], dtype="f4")}
        candidates = [row(i) for i in range(10, 231)]
        vectors.update({r["id"]: np.array([1., 0.], dtype="f4") for r in candidates})
        vectors[230] = np.array([0., 1.], dtype="f4")
        ranked = self.compare(candidates, [2, 1], vectors)
        self.assertTrue(all(r["support"] == 0 for r in ranked[999]))
        self.assertEqual(len(ranked[999]), len(candidates))
        negative = self.compare(candidates[:-1], [2], vectors)
        self.assertTrue(all(r["support"] == -1 for r in negative[999]))
        self.assertEqual([r["item_id"] for r in negative[50]], list(range(10, 60)))
        self.compare([], [1], vectors)
        self.compare(candidates, [], vectors)

    def test_production_float32_near_ties_and_nearest_nonendorser(self):
        rng = np.random.default_rng(40)
        vectors = {}
        for i in range(1, 8):
            v = rng.normal(size=1280).astype("f4")
            vectors[i] = v / np.linalg.norm(v)
        for i in range(100, 341):
            v = vectors[1] + rng.normal(scale=1e-6, size=1280).astype("f4")
            vectors[i] = v / np.linalg.norm(v)
        self.compare([row(i) for i in range(100, 341)], [7, 3, 1, 4, 2, 6, 5], vectors)
        v = {1: np.array([1., 0.], dtype="f4"), 2: np.array([0., 1.], dtype="f4"),
             3: np.array([.8, .6], dtype="f4"), 4: np.array([1., 0.], dtype="f4"),
             5: np.array([.5, .5], dtype="f4")}
        ranked = self.compare([row(5), row(4), row(3)], [2, 1], v, ks=(1, 2, 10))
        candidate = next(r for r in ranked[1] if r["item_id"] == 3)
        self.assertEqual(candidate["nearest_seed_id"], 1)  # Seed 1 endorsed only ID 4.
        tie = next(r for r in ranked[10] if r["item_id"] == 5)
        self.assertEqual(tie["nearest_seed_id"], 1)

    def test_selector_legacy_parity_independent_n_caps_and_steering(self):
        clusters = [(1, 2, 3), (4, 5), (6,)]
        tracks = {i: row(i) for i in range(100, 280)}
        for i in range(100, 140):
            tracks[i]["artist"] = "starved"
        tracks[101]["albumartist"] = " STARVED "
        def ranked(ids):
            return [{"item_id": i, "support": 1 - index / 1000,
                     "max_similarity": 1 - index / 1000, "nearest_seed_id": 1}
                    for index, i in enumerate(ids)]
        ranks = [ranked(range(100, 140)), ranked(list(range(100, 103)) + list(range(140, 220))), ranked(range(200, 280))]
        text = {i: np.array([1., i % 3], dtype="f4") for i in tracks}
        original = copy.deepcopy(ranks)
        for options in ({}, {"fresh": True}, {"text": text, "steer_vector": np.array([1., 0.]), "steer_weight": 0},
                        {"text": text, "steer_vector": np.array([0., 1.]), "steer_weight": .3, "fresh": True}):
            for n in (1, 2, 15, 50, 15):
                with self.subTest(n=n, options=list(options)):
                    actual = api._select_ranked(tracks, clusters, ranks, n=n, **options)
                    self.assertEqual(actual, legacy_select_ranked(tracks, clusters, ranks, n=n, **options))
                    self.assertEqual(len({r["item_id"] for _, r in actual[0]}), len(actual[0]))
                    if n == 15:
                        self.assertGreater(actual[2], 0)
                        self.assertGreater(sum(c == 1 for c, _ in actual[0]), actual[1][1])
        self.assertEqual(ranks, original)
        # A separate unstarved pair makes it explicit that 15 is not 50[:15].
        ranks = [ranked(range(140, 200)), ranked(range(200, 260))]
        small = api._select_ranked(tracks, clusters[:2], ranks, n=15)[0]
        large = api._select_ranked(tracks, clusters[:2], ranks, n=50)[0]
        self.assertNotEqual(small, large[:15])

    def test_multicluster_prepared_grid_matches_legacy(self):
        rng = np.random.default_rng(19)
        tracks = {i: row(i) for i in list(range(1, 8)) + list(range(100, 190))}
        vectors = {}
        for i, axis in ((1, 0), (2, 0), (3, 0), (4, 1), (5, 1), (6, 2), (7, 2)):
            vectors[i] = np.eye(1, 1280, k=axis, dtype="f4")[0]
        for i in range(100, 190):
            v = rng.normal(scale=.001, size=1280).astype("f4")
            v[(i - 100) // 30] += 1
            vectors[i] = v / np.linalg.norm(v)
            if i < 130:
                tracks[i]["artist"] = "crowded"
        eligible = [tracks[i] for i in reversed(range(100, 190))]
        ks = [1, 50, 100, 200, 999]
        prepared = _candidate_matrix(eligible, vectors)
        clusters, rankings = api._rank_threshold(prepared, list(reversed(range(1, 8))), vectors,
                                                cluster_threshold=.1, ks=ks)
        self.assertEqual(list(map(len, clusters)), [3, 2, 2])
        for k in ks:
            for n in (1, 15, 50):
                selected, shares, capped = api._select_ranked(tracks, clusters, rankings[k], n=n)
                expected = legacy_prepared(tracks, list(range(1, 8)), vectors, eligible,
                                           cluster_threshold=.1, n=n, k=k)
                self.assertEqual((selected, clusters, shares, capped), expected)
                self.assertEqual(api._prepared_proposal(tracks, list(range(1, 8)), vectors, eligible,
                                                       cluster_threshold=.1, n=n, k=k), expected)


class IntegratedReuse(unittest.TestCase):
    # Reuse only the existing synthetic Store fixture, not its test methods.
    setUp = fixtures.Evaluation.setUp

    def test_complete_public_proposal_legacy_parity(self):
        for fresh, steering in ((False, False), (True, False), (False, True), (True, True)):
            options = {"fresh": fresh}
            if steering:
                # The fixture has style only; add synthetic production-size text.
                from beets_embed.store import Store, fingerprint, model_ids
                with Store(self.store) as store:
                    for item in self.items:
                        v = np.zeros(512, dtype="f4")
                        v[item["id"] % 2] = 1
                        store.put(item["id"], fingerprint(item["path"]), model_ids()["text"], v, np.zeros(512))
                options.update(steer_vector=np.eye(1, 512, dtype="f4")[0], text_model_id=model_ids()["text"])
            for n in (15, 50):
                actual = api.extend(list(reversed(self.items)), [3, 1, 2], store=self.store,
                                    cluster_threshold=.1, n=n, **options).to_dict()
                with patch("beets_mix.api._prepared_proposal", new=legacy_prepared):
                    expected = api.extend(self.items, [1, 2, 3], store=self.store,
                                          cluster_threshold=.1, n=n, **options).to_dict()
                actual.pop("elapsed_ms")
                expected.pop("elapsed_ms")
                self.assertEqual(actual, expected)

    def test_complete_evaluator_legacy_kernel_parity(self):
        from beets_embed.store import Store
        # Below .4 these remain separate strands; at .4 their seeds merge.
        with Store(self.store) as store:
            for i in (4, 5, 6, 8, 10, 12):
                v = np.zeros(1280, dtype="<f2")
                v[:2] = [np.cos(.8), np.sin(.8)]
                store.db.execute("UPDATE vectors SET mean=? WHERE item_id=? AND model=?",
                                 (v.tobytes(), i, self.model))
            store.db.commit()
        kwargs = dict(store=self.store, thresholds=[0, .1, .2, .4], ks=[1, 50, 100, 200], trials=2)
        actual = evaluation.evaluate(self.data, **kwargs)
        with patch("beets_mix.evaluate._rank_threshold", new=legacy_threshold), \
             patch("beets_mix.evaluate._select_ranked", new=legacy_select_ranked):
            expected = evaluation.evaluate(self.data, **kwargs)
        self.assertEqual(actual, expected)
        self.assertEqual(json.dumps(actual, sort_keys=True, allow_nan=False), json.dumps(expected, sort_keys=True, allow_nan=False))

    def test_reuse_counts_array_lifetimes_and_unchanged_preparation(self):
        from beets_embed.store import Store
        with Store(self.store) as store:
            for i in range(4, 14):
                v = np.zeros(1280, dtype="<f2")
                v[1] = 1
                store.db.execute("UPDATE vectors SET mean=? WHERE item_id=? AND model=?",
                                 (v.tobytes(), i, self.model))
            store.db.commit()
        original = copy.deepcopy(self.data)
        candidates, similarities, threshold_rankings, vector_snapshots = [], [], [], []
        counts = Counter()
        real_argmax = np.argmax
        real_stack = np.stack

        class WeakRankings(dict):
            pass

        def threshold_spy(*args, **kwargs):
            self.assertTrue(all(ref() is None for ref in threshold_rankings))
            clusters, rankings = api._rank_threshold(*args, **kwargs)
            retained = WeakRankings(rankings)
            threshold_rankings.append(weakref.ref(retained))
            return clusters, retained

        def candidate_spy(eligible, vectors):
            self.assertTrue(all(ref() is None for ref in candidates))
            before = {i: v.copy() for i, v in vectors.items()}
            vector_snapshots.append((vectors, before))
            counts["population"] = len(eligible)
            prepared = _candidate_matrix(eligible, vectors)
            counts["candidate"] += 1
            candidates.append(weakref.ref(prepared[1]))
            return prepared

        def argmax_spy(values, *args, **kwargs):
            if values.base is not None:
                similarities.append(weakref.ref(values.base))
            return real_argmax(values, *args, **kwargs)

        def rank_spy(*args, **kwargs):
            self.assertTrue(all(ref() is None for ref in similarities))
            counts["cluster_rank"] += 1
            ranked = _rank_cluster_ks(*args, **kwargs)
            self.assertTrue(all(ref() is None for ref in similarities))
            return ranked

        def sorted_spy(values, *args, **kwargs):
            if isinstance(values, range) and len(values) == counts["population"]:
                counts["neighbor_sort"] += 1
            return builtins.sorted(values, *args, **kwargs)

        def stack_spy(values, *args, **kwargs):
            if len(values) == counts["population"]:
                counts["candidate_stack"] += 1
            return real_stack(values, *args, **kwargs)

        from beets_mix.vectors import load_head_metadata, load_vectors
        with patch("beets_mix.evaluate._candidate_matrix", new=candidate_spy), \
             patch("beets_mix.evaluate._rank_threshold", new=threshold_spy), \
             patch("beets_mix.api._rank_cluster_ks", new=rank_spy), \
             patch("beets_mix.rank.np.argmax", new=argmax_spy), \
             patch("beets_mix.rank.np.stack", new=stack_spy), \
             patch("beets_mix.rank.sorted", new=sorted_spy, create=True), \
             patch("beets_mix.evaluate.load_vectors", wraps=load_vectors) as loader, \
             patch("beets_mix.evaluate.load_head_metadata", wraps=load_head_metadata) as head_loader, \
             patch("beets_mix.api.cluster_seeds", wraps=cluster_seeds) as clusterer:
            report = evaluation.evaluate(self.data, store=self.store, thresholds=[0, .1, .2, .4],
                                         ks=[50, 100, 200], trials=2)
        self.assertEqual(loader.call_count, 1)
        self.assertEqual(head_loader.call_count, 1)
        self.assertEqual(counts["candidate"], 2)
        self.assertEqual(counts["candidate_stack"], 2)
        self.assertEqual(clusterer.call_count, 8)  # Four thresholds/trial, not 24.
        self.assertEqual(counts["cluster_rank"], 16)  # Two clusters at each threshold/trial.
        self.assertEqual(counts["neighbor_sort"], 2 * 4 * 4)  # Four training seeds.
        self.assertTrue(all(ref() is None for ref in candidates + similarities + threshold_rankings))
        for vectors, before in vector_snapshots:
            for i, array in before.items():
                np.testing.assert_array_equal(vectors[i], array)
        self.assertEqual(self.data, original)
        # Strict JSON conversion proves no ndarray/view is attached to the report.
        json.dumps(report, allow_nan=False)


if __name__ == "__main__":
    unittest.main()
