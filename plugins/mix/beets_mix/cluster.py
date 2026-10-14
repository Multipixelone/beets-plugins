"""Small seed sets: deterministic average-linkage cosine clustering."""

import numpy as np

from .defaults import SINGLETON_MERGE_MIN


def cluster_seeds(seed_ids, vectors, *, distance_threshold):
    if not np.isfinite(distance_threshold) or not 0 <= distance_threshold <= 2:
        raise ValueError("cluster_threshold must be finite and in [0, 2]")
    ids = sorted(set(seed_ids))
    if not ids:
        return []
    matrix = np.stack([vectors[i] for i in ids])
    distances = np.clip(1 - matrix @ matrix.T, 0, 2)
    positions = {item_id: i for i, item_id in enumerate(ids)}
    clusters = [(i,) for i in ids]

    def distance(a, b):
        return float(distances[np.ix_([positions[i] for i in a], [positions[i] for i in b])].mean())

    while len(clusters) > 1:
        best = min((distance(a, b), a, b) for x, a in enumerate(clusters) for b in clusters[x + 1:])
        if best[0] > distance_threshold:
            break
        _, a, b = best
        clusters.remove(a)
        clusters.remove(b)
        clusters.append(tuple(sorted(a + b)))
        clusters.sort()
    if len(ids) >= SINGLETON_MERGE_MIN:
        # Smallest-ID singleton first; nearest average-linkage target, then IDs.
        # If all are singleton, the first pair becomes a non-singleton target.
        while len(clusters) > 1 and any(len(c) == 1 for c in clusters):
            a = min(c for c in clusters if len(c) == 1)
            b = min((c for c in clusters if c != a), key=lambda c: (distance(a, c), c))
            clusters.remove(a)
            clusters.remove(b)
            clusters.append(tuple(sorted(a + b)))
            clusters.sort()
    return sorted(clusters, key=lambda c: (-len(c), c))
