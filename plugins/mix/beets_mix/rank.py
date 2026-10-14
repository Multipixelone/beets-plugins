"""Exact seed support, neighbourhood-only reranking, global greedy selection."""

from collections import Counter

import numpy as np

from . import defaults as d
from .filters import artist_key


def positive_integer(value, name):
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"{name} must be a positive integer")


def allocate_shares(clusters, n):
    positive_integer(n, "n")
    if not clusters:
        return []
    order = sorted(range(len(clusters)), key=lambda i: (-len(clusters[i]), clusters[i]))
    if len(clusters) > n:
        return [int(i in order[:n]) for i in range(len(clusters))]
    # Proportional quotas; reserve the minimum for under-quota strands, then
    # apportion remaining seats proportionally among the remaining strands.
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


def zscores(values):
    values = np.asarray(values, dtype="f8")
    std = values.std()
    return (values - values.mean()) / std if std > d.ZSCORE_EPSILON else np.zeros_like(values)


def rank_cluster(candidates, seed_ids, vectors, *, k=d.K):
    positive_integer(k, "k")
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


def rerank_pool(ranked, share, tracks, *, text_vectors=None, steer_vector=None,
                weight=d.STEER_WEIGHT, fresh=d.FRESH):
    if isinstance(weight, bool) or not isinstance(weight, (int, float)) or not np.isfinite(weight) or not 0 <= weight <= 1:
        raise ValueError("weight must be finite and in [0, 1]")
    if steer_vector is not None and text_vectors is None:
        raise ValueError("Steering requires candidate text vectors")
    pool = [dict(row) for row in ranked[:d.POOL_MULTIPLE * share]]
    if not pool or (not fresh and (steer_vector is None or weight == 0)):
        return pool
    support = zscores([row["support"] for row in pool])
    if steer_vector is not None and weight != 0:
        assert text_vectors is not None
        text = zscores([float(text_vectors[row["item_id"]] @ steer_vector) for row in pool])
        scores = (1 - weight) * support + weight * text
    else:
        scores = support
    for row, score in zip(pool, scores):
        row["rank_score"] = float(score + (d.FRESH_BONUS if fresh and tracks[row["item_id"]]["plex_viewcount"] == 0 else 0))
    return sorted(pool, key=lambda r: (-r["rank_score"], -r["support"], -r["max_similarity"], r["item_id"]))


def select(pools, shares, clusters, tracks, *, max_per_artist=d.MAX_PER_ARTIST):
    positive_integer(max_per_artist, "max_per_artist")
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
            artist = artist_key(tracks[item_id])
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
    # Preserve every original share first. Roll shortages cyclically to the
    # next-largest strand, then wrap; never steal another strand's allocation.
    for source, missing in shortfalls:
        position = order.index(source)
        recipients = order[position + 1:] + order[:position]
        for i in recipients:
            if not missing:
                break
            missing -= fill(i, missing)
    return [(i, row) for i in order for row in picked[i]], len(capped - used)
