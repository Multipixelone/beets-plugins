"""Exact cosine search in bounded chunks; no approximate-index maintenance."""

import heapq
from collections import defaultdict

import numpy as np

from .store import fingerprint


def unit(vector):
    vector = np.asarray(vector, dtype="f4")
    norm = np.linalg.norm(vector, axis=-1, keepdims=True)
    return vector / np.maximum(norm, 1e-12)


def available(store, tracks, model):
    for track in tracks:
        try:
            content = fingerprint(track["path"])
        except OSError:
            continue
        vector = store.vector(track["id"], content, model)
        if vector is not None:
            yield track, vector


def album_key(track):
    # Standalone tracks must not collapse into one imaginary album.
    return ("album", track["album_id"]) if track["album_id"] else ("track", track["id"])


def album_vectors(store, tracks, model):
    totals = defaultdict(int)
    sums, metadata, counts = {}, {}, defaultdict(int)
    for track in tracks:
        totals[album_key(track)] += 1
    for track, vector in available(store, tracks, model):
        key = album_key(track)
        if key not in sums:
            sums[key] = np.zeros_like(vector)
            metadata[key] = dict(track)
        sums[key] += vector
        counts[key] += 1
    for key, vector in sums.items():
        info = metadata[key]
        info.update(embedded_tracks=counts[key], total_tracks=totals[key])
        yield info, vector / counts[key]


def rank(candidates, query, top_k=20, exclude=()):
    query = unit(query)
    excluded = set(exclude)
    best, chunk = [], []

    def consume():
        if not chunk:
            return
        scores = unit(np.stack([v for _, v in chunk])) @ query
        for (info, _), score in zip(chunk, scores):
            entry = (float(score), -info["id"], dict(info, score=float(score)))
            if len(best) < top_k:
                heapq.heappush(best, entry)
            elif entry[:2] > best[0][:2]:
                heapq.heapreplace(best, entry)
        chunk.clear()

    for info, vector in candidates:
        if album_key(info) in excluded:
            continue
        chunk.append((info, vector))
        if len(chunk) == 512:
            consume()
    consume()
    return [info for _, _, info in sorted(best, key=lambda e: e[:2], reverse=True)]


def similar(store, tracks, model, seed_ids, top_k):
    # First average each seed album's selected tracks, then give albums equal weight.
    seed_tracks = [t for t in tracks if t["id"] in seed_ids]
    seeds = list(album_vectors(store, seed_tracks, model))
    if not seeds:
        raise ValueError("No current style embeddings for the selected seeds")
    query = np.mean([unit(vector) for _, vector in seeds], axis=0)
    return rank(album_vectors(store, tracks, model), query, top_k,
                exclude=[album_key(t) for t in seed_tracks])
