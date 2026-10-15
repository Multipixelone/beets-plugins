"""Proposal and explicit-ID apply APIs; no beets UI or PlexAPI imports."""

from dataclasses import dataclass
from collections.abc import Mapping
import math
from pathlib import Path
from time import perf_counter

from beets_embed.store import Store, model_ids

from .apply import ApplyResult, apply

from . import defaults as d
from .cluster import cluster_seeds
from .filters import filter_candidates
from .rank import (_candidate_matrix, _rank_cluster_ks, allocate_shares,
                   positive_integer, rerank_pool, select)
from .vectors import load_head_metadata, load_vectors, normalized, validate_model

FIELDS = ("id", "path", "artist", "albumartist", "title", "album", "year", "length",
          "mb_trackid", "plex_ratingkey", "plex_userrating", "plex_skipcount", "plex_viewcount")


@dataclass
class Proposal:
    """JSON-ready v1 payload; to_dict returns the proposal data, not a handle."""

    data: dict[str, object]

    def to_dict(self):
        from copy import deepcopy
        return deepcopy(self.data)


def snapshots(items):
    result = {}
    for item in items:
        missing = set(FIELDS) - item.keys()
        if missing:
            raise ValueError(f"Incomplete item snapshot: {sorted(missing)}")
        item_id = item["id"]
        positive_integer(item_id, "item id")
        if item_id in result:
            raise ValueError(f"Duplicate snapshot item ID: {item_id}")
        for field in ("artist", "albumartist", "title", "album", "mb_trackid"):
            if not isinstance(item[field], str):
                raise ValueError(f"{field} must be a string (empty means absent)")
        if not isinstance(item["path"], (str, bytes, Path)):
            raise ValueError("path must be a filesystem path")
        if item["year"] is not None and (isinstance(item["year"], bool) or not isinstance(item["year"], int)):
            raise ValueError("year must be an integer or null")
        if item["plex_ratingkey"] is not None and (isinstance(item["plex_ratingkey"], bool) or not isinstance(item["plex_ratingkey"], (str, int))):
            raise ValueError("plex_ratingkey must be a string, integer, or null")
        for field in ("length", "plex_userrating", "plex_skipcount", "plex_viewcount"):
            value = item[field]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                raise ValueError(f"{field} must be finite and nonnegative")
        if item["plex_userrating"] > 10:
            raise ValueError("plex_userrating must be in [0, 10]")
        result[item_id] = {field: item[field] for field in FIELDS}
    return result


def summary(seed_ids, heads, name):
    totals, counts = {}, {}
    for item_id in seed_ids:
        for label, score in heads.get(item_id, {}).get(name, {}).items():
            totals[label] = totals.get(label, 0) + score
            counts[label] = counts.get(label, 0) + 1
    return sorted(totals, key=lambda label: (-totals[label] / counts[label], label))[:d.HEAD_SUMMARY_LIMIT]


def plex_key(value, name):
    if value is not None and (isinstance(value, bool) or not isinstance(value, (str, int))):
        raise ValueError(f"{name} must be a string, integer, or null")


def metadata(value, *, seed):
    """Validate the small adapter vocabulary and own all nested input rows."""
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise ValueError("metadata must be a mapping or null")
    allowed = {"source", "playlist", "plex_ratingkey", "unresolved"} if seed else {"plex", "playlist", "plex_ratingkey"}
    if set(value) - allowed:
        raise ValueError("Unknown metadata field")
    result = dict(value)
    for name in ("source", "playlist"):
        if name in result and not isinstance(result[name], str):
            raise ValueError(f"metadata {name} must be a string")
    if "plex_ratingkey" in result:
        plex_key(result["plex_ratingkey"], "metadata plex_ratingkey")
    if "plex" in result and not isinstance(result["plex"], bool):
        raise ValueError("target metadata plex flag must be boolean")
    if "unresolved" in result:
        if not isinstance(result["unresolved"], list):
            raise ValueError("unresolved must be a list of playlist-key/title mappings")
        rows = []
        for row in result["unresolved"]:
            if not isinstance(row, Mapping) or set(row) - {"plex_ratingkey", "title"}:
                raise ValueError("unresolved entries must be playlist-key/title mappings")
            if "title" in row and not isinstance(row["title"], str):
                raise ValueError("unresolved title must be a string")
            if "plex_ratingkey" in row:
                plex_key(row["plex_ratingkey"], "unresolved plex_ratingkey")
            rows.append(dict(row))
        result["unresolved"] = rows
    return result


def _eligible_candidates(tracks, originals, usable, style, top_styles, *, text=None, plex_target=False):
    return filter_candidates(list(tracks.values()), playlist_tracks=list(originals.values()),
        vectors=style, text_vectors=text, top_styles=top_styles, plex_target=plex_target,
        shortest_seed_length=min(tracks[i]["length"] for i in usable))


def _rank_threshold(prepared, usable, style, *, cluster_threshold, ks):
    """Retain scalar rankings for one threshold; one cluster's arrays at a time."""
    clusters = cluster_seeds(usable, style, distance_threshold=cluster_threshold)
    rankings = {k: [] for k in ks}
    for ids in clusters:
        per_k = _rank_cluster_ks(prepared, ids, style, ks)
        for k in ks:
            rankings[k].append(per_k[k])
    return clusters, rankings


def _select_ranked(tracks, clusters, ranked, *, n, text=None, steer_vector=None,
                   steer_weight=d.STEER_WEIGHT, fresh=d.FRESH, max_per_artist=d.MAX_PER_ARTIST):
    """Fresh N-dependent allocation, calibrated pools, cap and rollover state."""
    shares = allocate_shares(clusters, n)
    pools = [rerank_pool(rows, share, tracks,
                       text_vectors=text, steer_vector=steer_vector, weight=steer_weight, fresh=fresh)
             for rows, share in zip(ranked, shares)]
    selected, capped = select(pools, shares, clusters, tracks, max_per_artist=max_per_artist)
    return selected, shares, capped


def _prepared_proposal(tracks, usable, style, eligible, *, cluster_threshold, n, k,
                       text=None, steer_vector=None, steer_weight=d.STEER_WEIGHT,
                       fresh=d.FRESH, max_per_artist=d.MAX_PER_ARTIST):
    """Single-configuration wrapper around the same trial/grid kernel."""
    prepared = _candidate_matrix(eligible, style)
    clusters, rankings = _rank_threshold(prepared, usable, style, cluster_threshold=cluster_threshold, ks=[k])
    selected, shares, capped = _select_ranked(tracks, clusters, rankings[k], n=n,
        text=text, steer_vector=steer_vector, steer_weight=steer_weight,
        fresh=fresh, max_per_artist=max_per_artist)
    return selected, clusters, shares, capped


def extend(items, seed_item_ids, *, store, cluster_threshold, n=d.N, k=d.K,
           playlist_tracks=None, seed_metadata=None, target_metadata=None,
           style_model_id=None, steer_vector=None, text_model_id=None,
           steer=None, steer_weight=d.STEER_WEIGHT, fresh=d.FRESH,
           max_per_artist=d.MAX_PER_ARTIST):
    """Propose from the full library snapshot, excluding all original tracks.

    A path is opened read-only. A supplied Store must have query_only enabled;
    upstream Store exposes no readonly attribute, so unverifiable handles are
    conservatively rejected rather than probed with any write operation.
    """
    start = perf_counter()
    for value, name in ((n, "n"), (k, "k"), (max_per_artist, "max_per_artist")):
        positive_integer(value, name)
    for value, name, high in ((cluster_threshold, "cluster_threshold", 2), (steer_weight, "steer_weight", 1)):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= high:
            raise ValueError(f"{name} must be finite and in [0, {high}]")
    if not isinstance(fresh, bool):
        raise ValueError("fresh must be boolean")
    if steer is not None and (not isinstance(steer, str) or steer_vector is None):
        raise ValueError("steer is a descriptive string for a supplied steering vector")
    style_model_id = model_ids()["style"] if style_model_id is None else style_model_id
    validate_model(style_model_id, "style")
    if steer_vector is not None:
        validate_model(text_model_id, "text")
        steer_vector = normalized(steer_vector, d.DIMENSIONS["text"], minimum_norm=d.STEERING_MIN_NORM)
    elif text_model_id is not None:
        raise ValueError("text_model_id requires a steering vector")
    tracks = snapshots(items)
    seeds = list(seed_item_ids)
    for item_id in seeds:
        positive_integer(item_id, "seed item id")
    seeds = sorted(set(seeds))
    originals = snapshots(playlist_tracks) if playlist_tracks is not None else {}
    for item_id in seeds:
        if item_id in tracks:
            originals.setdefault(item_id, tracks[item_id])
    target = metadata(target_metadata, seed=False)
    seed_info = metadata(seed_metadata, seed=True)
    owned = not isinstance(store, Store)
    if owned:
        store = Store(store, readonly=True)
    elif store.db.execute("PRAGMA query_only").fetchone()[0] != 1:
        raise ValueError("Supplied Store requires PRAGMA query_only=ON (no readonly attribute is exposed)")
    try:
        style = load_vectors(store, list(tracks.values()), style_model_id, "style")
        usable = [i for i in seeds if i in style]
        losses = [{"item_id": i, "reason": "unresolved" if i not in tracks else "no_vector"} for i in seeds if i not in style]
        if not usable:
            raise ValueError("No usable seed style vectors")
        text = load_vectors(store, list(tracks.values()), text_model_id, "text") if steer_vector is not None else None
        heads, top_styles = load_head_metadata(store, [tracks[i] for i in sorted(style)], style_model_id, usable)
    finally:
        if owned:
            store.close()
    eligible, counts = _eligible_candidates(tracks, originals, usable, style, top_styles,
                                          text=text, plex_target=target.get("plex", False))
    selected, clusters, shares, counts["artist_cap"] = _prepared_proposal(
        tracks, usable, style, eligible, cluster_threshold=cluster_threshold, n=n, k=k,
        text=text, steer_vector=steer_vector, steer_weight=steer_weight,
        fresh=fresh, max_per_artist=max_per_artist)
    rows = []
    for index, (cluster_id, row) in enumerate(selected, 1):
        track = tracks[row["item_id"]]
        nearest = tracks[row["nearest_seed_id"]]
        rows.append({"n": index, "item_id": track["id"],
                     **{field: track[field] for field in ("plex_ratingkey", "artist", "title", "album", "year")},
                     "cluster": cluster_id, "support": row["support"],
                     "nearest_seed": {"item_id": nearest["id"], "title": nearest["title"]}})
    params = {"n": n, "k": k, "cluster_threshold": cluster_threshold, "steer": steer,
              "steer_weight": steer_weight, "fresh": fresh, "max_per_artist": max_per_artist,
              "fresh_bonus": d.FRESH_BONUS, "pool_multiple": d.POOL_MULTIPLE,
              "skip_min": d.SKIP_MIN, "low_rating_max": d.LOW_RATING_MAX,
              "length_max_floor": d.LENGTH_MAX_FLOOR, "length_seed_ratio": d.LENGTH_SEED_RATIO,
              "singleton_merge_min": d.SINGLETON_MERGE_MIN,
              "head_summary_limit": d.HEAD_SUMMARY_LIMIT, "zscore_epsilon": d.ZSCORE_EPSILON,
              "steering_min_norm": d.STEERING_MIN_NORM}
    return Proposal({"schema": "beets-mix.proposal.v1",
        "seed": {"source": "supplied", **seed_info,
                 "tracks": len(set(originals) | set(seeds)) + len(seed_info.get("unresolved", [])),
                 "resolved": sum(i in tracks for i in seeds), "with_vectors": len(usable), "losses": losses,
                 "unresolved": seed_info.get("unresolved", [])},
        "target": target,
        "clusters": [{"id": i, "size": len(ids), "share": shares[i], "seed_item_ids": list(ids),
                      "selected": sum(cluster_id == i for cluster_id, _ in selected),
                      "top_styles": summary(ids, heads, "discogs400"),
                      "top_moods": summary(ids, heads, "moodtheme")}
                     for i, ids in enumerate(clusters)],
        "proposal": rows, "excluded_counts": counts, "params": params,
        "models": {"style": style_model_id, "text": text_model_id},
        "elapsed_ms": round((perf_counter() - start) * 1000, 3)})
