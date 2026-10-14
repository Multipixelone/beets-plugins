"""Exact embed availability and defensive vector/head loading."""

import re

import numpy as np
from beets_embed.retrieval import available, unit
from beets_embed.store import fingerprint

from .defaults import DIMENSIONS


def validate_model(model, family):
    if not isinstance(model, str) or not re.fullmatch(f"{family}:[0-9a-f]{{64}}", model):
        raise ValueError(f"Expected digest-qualified {family} model ID")


def normalized(vector, dimension, *, minimum_norm=0.0):
    vector = np.asarray(vector, dtype="f4")
    norm = np.linalg.norm(vector.astype("f8"))
    if vector.shape != (dimension,) or not np.isfinite(vector).all() or not np.isfinite(norm) or norm <= 0 or norm < minimum_norm:
        raise ValueError("Invalid vector dimension, finiteness, or norm")
    result = unit(vector.copy())
    if not np.isfinite(result).all() or not np.any(result):
        raise ValueError("Invalid normalized vector")
    return result


def load_vectors(store, tracks, model, family):
    validate_model(model, family)
    result = {}
    for track in tracks:
        try:
            for info, vector in available(store, [track], model):
                result[info["id"]] = normalized(vector, DIMENSIONS[family])
        except (ValueError, TypeError):
            continue
    return result


def load_heads(store, track, model, *, names=("discogs400", "moodtheme")):
    try:
        heads = store.heads(track["id"], fingerprint(track["path"]), model)
    except (OSError, ValueError, TypeError, KeyError):
        return {}
    result = {}
    for name in names:
        head = heads.get(name, {})
        labels = head.get("labels", [])
        try:
            scores = np.asarray(head.get("scores", []), dtype="f8")
            if labels and scores.shape == (len(labels),) and np.isfinite(scores).all() and np.all((scores >= 0) & (scores <= 1)):
                result[name] = dict(zip(labels, map(float, scores)))
        except (TypeError, ValueError):
            continue
    return result


def load_head_metadata(store, tracks, model, seed_ids):
    """Retain full distributions only for usable seeds, one label otherwise."""
    seed_ids = set(seed_ids)
    seed_heads, top_styles = {}, {}
    for track in tracks:
        item_id = track["id"]
        names = ("discogs400", "moodtheme") if item_id in seed_ids else ("discogs400",)
        heads = load_heads(store, track, model, names=names)
        styles = heads.get("discogs400", {})
        top_styles[item_id] = min(styles, key=lambda label: (-styles[label], label)) if styles else ""
        if item_id in seed_ids:
            seed_heads[item_id] = heads
    return seed_heads, top_styles
