"""Dev-only, offline hold-out evaluation. No adapters, inference, or persistence."""

import argparse
from collections.abc import Mapping
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import sys

import numpy as np
from beets_embed.retrieval import unit
from beets_embed.store import Store, model_ids

from . import defaults as d
from .api import _eligible_candidates, _prepared_proposal, snapshots
from .filters import filter_candidates
from .rank import positive_integer
from .vectors import load_head_metadata, load_vectors, validate_model

METRICS = ("track_recall", "album_recall", "eligible_track_recall")


def _rng(seed, playlist, trial, stream):
    payload = json.dumps([seed, playlist, trial, stream], ensure_ascii=True, separators=(",", ":"))
    digest = hashlib.sha256(payload.encode("ascii")).digest()
    return np.random.default_rng(int.from_bytes(digest, "big"))


def make_split(usable, *, seed, playlist, trial):
    ids = sorted(set(usable))
    count = max(2, math.ceil(.2 * len(ids)))
    if len(ids) - count < 1:
        return None
    hidden = sorted(map(int, _rng(seed, playlist, trial, "split").choice(ids, count, replace=False)))
    hidden_set = set(hidden)
    return [i for i in ids if i not in hidden_set], hidden


def centroid_rank(eligible_ids, training, vectors):
    ids = sorted(eligible_ids)
    mean = np.mean(np.stack([vectors[i] for i in sorted(training)]), axis=0)
    if not np.any(mean):
        return ids
    query = unit(mean)
    return sorted(ids, key=lambda i: (-float(vectors[i] @ query), i))


def random_rank(eligible_ids, *, seed, playlist, trial):
    # One uniform permutation: stable prefixes across N and every grid point.
    return list(map(int, _rng(seed, playlist, trial, "random").permutation(sorted(eligible_ids))))


def recall(recommended, hidden, eligible_hidden, albums):
    hits = set(recommended) & set(hidden)
    hidden_albums = {albums[i] for i in hidden}
    recovered = {albums[i] for i in recommended} & hidden_albums
    return {"track_hits": len(hits), "track_recall": len(hits) / len(hidden),
            "album_hits": len(recovered), "album_denominator": len(hidden_albums),
            "album_recall": len(recovered) / len(hidden_albums),
            "eligible_track_recall": len(hits & set(eligible_hidden)) / len(eligible_hidden) if eligible_hidden else None,
            "eligible_track_recall_null_reason": None if eligible_hidden else "no_eligible_hidden_tracks"}


def _mean(values):
    valid = [v for v in values if v is not None]
    return {"mean": sum(valid) / len(valid) if valid else None,
            "valid": len(valid), "null": len(values) - len(valid)}


def aggregate(playlists, configurations, ns):
    """Trial means per playlist, then equal-weight playlist macro means."""
    summaries = []
    for configuration in configurations:
        for n in ns:
            for method in ("mix", "centroid", "random"):
                per_playlist = []
                for playlist in playlists:
                    rows = [row for trial in playlist["trials"] if trial["status"] == "ok"
                            for row in trial["results"] if row["configuration"] == configuration and row["n"] == n and row["method"] == method]
                    per_playlist.append({"playlist": playlist["name"], "trials": len(rows),
                        "skipped_trials": len(playlist["trials"]) - len(rows),
                        **{metric: _mean([row[metric] for row in rows]) for metric in METRICS},
                        "recommendation_count": _mean([row["recommendation_count"] for row in rows])})
                summaries.append({"configuration": configuration, "n": n, "method": method,
                    "per_playlist": per_playlist,
                    "macro": {metric: _mean([p[metric]["mean"] for p in per_playlist])
                              for metric in (*METRICS, "recommendation_count")}})
    return summaries


def best_observed(summary, configurations):
    def objective(config):
        values = []
        for n, metric in ((15, "track_recall"), (15, "album_recall"), (50, "track_recall"), (50, "album_recall")):
            row = next((s for s in summary if s["configuration"] == config and s["n"] == n and s["method"] == "mix"), None)
            value = row["macro"][metric]["mean"] if row else None
            if value is None:
                return None
            values.append(value)
        return (*values, -config["cluster_threshold"], -config["k"])
    evaluated = [(objective(config), config) for config in configurations]
    valid = [(score, config) for score, config in evaluated if score is not None]
    return {"status": "exploratory_only", "configuration": max(valid, key=lambda pair: pair[0])[1] if valid else None,
            "null_reason": None if valid else "objective_requires_valid_mix_metrics_at_15_and_50",
            "objective": ["macro_track@15", "macro_album@15", "macro_track@50", "macro_album@50", "smaller_threshold", "smaller_k"]}


def evaluate(data, *, store, thresholds, ks, trials=20, seed=0, ns=(15, 50), style_model_id=None):
    """Evaluate explicit snapshots/playlist IDs; prepare Store data once per run."""
    positive_integer(trials, "trials")
    if isinstance(seed, bool) or not isinstance(seed, int) or seed < 0:
        raise ValueError("seed must be a nonnegative integer")
    thresholds, ks, ns = list(thresholds), list(ks), list(ns)
    if not thresholds or not ks or not ns:
        raise ValueError("thresholds, ks, and ns must be nonempty explicit grids")
    for threshold in thresholds:
        if isinstance(threshold, bool) or not isinstance(threshold, (int, float)) or not math.isfinite(threshold) or not 0 <= threshold <= 2:
            raise ValueError("thresholds must be finite in [0, 2]")
    for k in ks:
        positive_integer(k, "k")
    for n in ns:
        positive_integer(n, "n")
    thresholds, ks, ns = sorted(set(thresholds)), sorted(set(ks)), sorted(set(ns))
    if not isinstance(data, Mapping) or set(data) != {"items", "playlists"}:
        raise ValueError("input requires only items and playlists")
    if not isinstance(data["items"], list) or any(not isinstance(row, Mapping) for row in data["items"]):
        raise ValueError("items must be a list of complete snapshot mappings")
    tracks = snapshots(data["items"])
    albums = {}
    for row in data["items"]:
        album_id = row.get("album_id")
        if album_id is not None:
            positive_integer(album_id, "album_id")
        albums[row["id"]] = ("album", album_id) if album_id is not None else ("item", row["id"])
    if not isinstance(data["playlists"], Mapping) or any(not isinstance(name, str) for name in data["playlists"]):
        raise ValueError("playlists must map string names to item ID lists")
    playlist_ids = {}
    for name, ids in data["playlists"].items():
        if not isinstance(ids, list):
            raise ValueError("playlist IDs must be lists")
        for item_id in ids:
            positive_integer(item_id, "playlist item ID")
        playlist_ids[name] = sorted(set(ids))
    model = model_ids()["style"] if style_model_id is None else style_model_id
    validate_model(model, "style")
    owned = not isinstance(store, Store)
    if owned:
        store = Store(store, readonly=True)
    elif store.db.execute("PRAGMA query_only").fetchone()[0] != 1:
        raise ValueError("Supplied Store requires PRAGMA query_only=ON")
    try:
        vectors = load_vectors(store, list(tracks.values()), model, "style")
        _, top_styles = load_head_metadata(store, [tracks[i] for i in sorted(vectors)], model, [])
    finally:
        if owned:
            store.close()
    configurations = [{"cluster_threshold": threshold, "k": k} for threshold in thresholds for k in ks]
    reports = []
    for name, ids in sorted(playlist_ids.items()):
        usable = [i for i in ids if i in vectors]
        report = {"name": name, "original_ids": ids, "original_count": len(ids),
                  "resolved_count": sum(i in tracks for i in ids), "usable_count": len(usable),
                  "unresolved_count": sum(i not in tracks for i in ids),
                  "no_vector_count": sum(i in tracks and i not in vectors for i in ids),
                  "unresolved_ids": [i for i in ids if i not in tracks],
                  "no_vector_ids": [i for i in ids if i in tracks and i not in vectors], "trials": []}
        for trial in range(trials):
            split = make_split(usable, seed=seed, playlist=name, trial=trial)
            if split is None:
                report["trials"].append({"trial": trial, "status": "skipped", "reason": "insufficient_usable_seeds", "results": []})
                continue
            training, hidden = split
            originals = {i: tracks[i] for i in ids if i in tracks and i not in hidden}
            eligible, exclusions = _eligible_candidates(tracks, originals, training, vectors, top_styles)
            eligible_ids = [row["id"] for row in eligible]
            eligible_hidden = sorted(set(hidden) & set(eligible_ids))
            # Diagnostic only: apply the same normal filters to hidden candidates.
            _, hidden_counts = filter_candidates([tracks[i] for i in hidden], playlist_tracks=list(originals.values()),
                vectors=vectors, top_styles=top_styles, shortest_seed_length=min(tracks[i]["length"] for i in training))
            centroid = centroid_rank(eligible_ids, training, vectors)
            random = random_rank(eligible_ids, seed=seed, playlist=name, trial=trial)
            results = []
            for config in configurations:
                for n in ns:
                    selected, _, _, capped = _prepared_proposal(tracks, training, vectors, eligible,
                        cluster_threshold=config["cluster_threshold"], k=config["k"], n=n, fresh=False)
                    for method, recommended in (("mix", [row["item_id"] for _, row in selected]),
                                                ("centroid", centroid[:n]), ("random", random[:n])):
                        results.append({"configuration": dict(config), "n": n, "method": method,
                            "constraints": "mix_cap_and_fixed_pools" if method == "mix" else "uncapped_baseline",
                            "recommendation_ids": recommended, "recommendation_count": len(recommended),
                            "artist_cap_count": capped if method == "mix" else None,
                            **recall(recommended, hidden, eligible_hidden, albums)})
            report["trials"].append({"trial": trial, "status": "ok", "training_ids": training,
                "hidden_ids": hidden, "remaining_original_ids": sorted(originals),
                "hidden_count": len(hidden), "eligible_ids": eligible_ids, "eligible_count": len(eligible),
                "eligible_hidden_ids": eligible_hidden, "eligible_hidden_count": len(eligible_hidden),
                "hidden_filtered_count": len(hidden) - len(eligible_hidden),
                "hidden_filtered_counts": hidden_counts, "excluded_counts": exclusions, "results": results})
        report["skipped_trials"] = sum(t["status"] == "skipped" for t in report["trials"])
        reports.append(report)
    summary = aggregate(reports, configurations, ns)
    result = {"schema": "beets-mix.evaluation.v1", "models": {"style": model},
        "inputs": {"item_count": len(tracks), "available_style_count": len(vectors), "playlist_count": len(reports)},
        "protocol": {"trials": trials, "seed": seed, "holdout_fraction": .2, "minimum_hidden": 2,
            "ns": ns, "thresholds": thresholds, "ks": ks,
            "rng": "sha256(JSON[seed,playlist,trial,stream]); numpy default_rng; sorted IDs",
            "numpy_version": np.__version__,
            "random": "uniform permutation without replacement; fixed prefixes across N/grid",
            "eligibility": "shared phase1 filters; training-only floor; remaining originals include unavailable tracks; hidden tracks ordinary candidates",
            "baselines": "canonical uncapped centroid/random; Mix retains proposal artist cap and fixed pools",
            "track_denominator": "all hidden IDs", "eligible_recall": "diagnostic; null if no eligible hidden IDs",
            "album_denominator": "unique hidden album keys; positive album_id else unique item ID",
            "aggregation": "trial mean within playlist, then equal-weight playlist macro; nulls excluded with counts",
            "mix_max_per_artist": d.MAX_PER_ARTIST, "mix_pool_multiple": d.POOL_MULTIPLE,
            "steering": False, "fresh": False},
        "playlists": reports, "summary": summary, "best_observed": best_observed(summary, configurations),
        "skipped_trials": sum(t["status"] == "skipped" for p in reports for t in p["trials"])}
    json.dumps(result, allow_nan=False)
    return result


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's usual message may contain user-provided paths/values.
        self.exit(2, "evaluation error: invalid command-line arguments; use --help\n")


def _reject_nonfinite_json(value):
    raise ValueError("nonfinite JSON")


def main(argv=None):
    parser = _Parser(description="Offline exploratory Mix hold-out evaluation; no tuned defaults or adapters")
    parser.add_argument("--input", required=True, help="JSON snapshot/playlist input")
    parser.add_argument("--store", required=True, help="read-only embedding store")
    parser.add_argument("--thresholds", type=float, nargs="+", required=True)
    parser.add_argument("--ks", type=int, nargs="+", required=True)
    parser.add_argument("--trials", type=int, default=20)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--ns", type=int, nargs="+", default=[15, 50])
    parser.add_argument("--style-model-id")
    args = parser.parse_args(argv)
    try:
        data = json.loads(Path(args.input).read_text(), parse_constant=_reject_nonfinite_json)
        result = evaluate(data, store=args.store, thresholds=args.thresholds, ks=args.ks,
                          trials=args.trials, seed=args.seed, ns=args.ns, style_model_id=args.style_model_id)
        print(json.dumps(result, allow_nan=False, sort_keys=True))
    except (ValueError, TypeError, KeyError, AttributeError, OSError, sqlite3.Error, OverflowError):
        print("evaluation error: invalid input, arguments, or unavailable embedding store", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
