"""Read current album embeddings and statistics without modifying either database."""

import json
import math
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .retrieval import album_vectors
from .store import Store


def protect_output(output, *inputs):
    target = Path(output).expanduser().absolute()
    for source in inputs:
        source = Path(source).expanduser().absolute()
        for protected in (source, *(Path(str(source) + suffix) for suffix in ("-wal", "-shm", "-journal"))):
            if target.resolve() == protected.resolve() or (
                    target.exists() and protected.exists() and os.path.samefile(target, protected)):
                raise ValueError("Output must not overwrite an input database or SQLite sidecar")
    return target


def plays(item):
    value = item.get("lastfm_play_count")
    if value is None or value == "":
        value = item.get("play_count", 0)
    try:
        count = float(value or 0)
    except (ValueError, TypeError):
        return 0
    return count if math.isfinite(count) and count >= 0 else 0


def export_albums(lib, selected_ids, store_path, model, output):
    """Queries choose albums; pooling and play statistics always use whole albums."""
    target = protect_output(output, lib.path, store_path)
    selected_ids = set(selected_ids) - {None, 0}
    albums = []
    dimension = None
    with Store(store_path, readonly=True) as store:
        # Only hydrate albums which could have vectors. An almost empty store
        # should not stat or fetch flex attributes for the entire music library.
        item_ids = [row[0] for row in store.db.execute(
            "SELECT DISTINCT item_id FROM vectors WHERE model=?", (model,))]
        candidates = set()
        for first in range(0, len(item_ids), 512):
            ids = item_ids[first:first + 512]
            with lib.transaction() as tx:
                rows = tx.query("SELECT DISTINCT album_id FROM items WHERE id IN (" +
                                ",".join("?" for _ in ids) + ")", ids)
            candidates.update(row["album_id"] for row in rows)
        for album_id in sorted(selected_ids & candidates):
            album = lib.get_album(album_id)
            if album is None:
                continue
            items = list(album.items())
            tracks = [{"id": item.id, "album_id": album_id,
                       "path": os.path.normpath(os.path.join(os.fsdecode(lib.directory),
                                                            os.fsdecode(item.path)))}
                      for item in items]
            pooled = list(album_vectors(store, tracks, model))
            if not pooled:
                continue
            info, vector = pooled[0]
            vector = np.asarray(vector, dtype="f4")
            if vector.ndim != 1 or not vector.size or not np.isfinite(vector).all() or not np.any(vector):
                raise ValueError(f"Invalid embedding for album {album_id}")
            if dimension is not None and dimension != vector.size:
                raise ValueError("Album vectors have inconsistent dimensions")
            dimension = vector.size
            summed = sum(plays(item) for item in items)
            # Current beets uses a multi-value genres field; older libraries
            # and plugins may still expose genre as a flexible attribute.
            genre = album.get("genre") or album.get("genres") or next(
                (item.get("genre") or item.get("genres") for item in items
                 if item.get("genre") or item.get("genres")), "")
            if isinstance(genre, (list, tuple)):
                genre = "; ".join(genre)
            albums.append({"id": album_id, "album": album.album,
                           "albumartist": album.albumartist, "genre": genre,
                           "year": album.year, "track_count": len(items),
                           "embedded_tracks": info["embedded_tracks"],
                           "summed_plays": summed, "mean_plays": summed / len(items),
                           "vector": vector.tolist()})
    result = {"schema_version": 1, "model_id": model,
              "exported_at": datetime.now(timezone.utc).isoformat(),
              "summary": {"selected_albums": len(selected_ids), "exported_albums": len(albums),
                          "skipped_albums": len(selected_ids) - len(albums)},
              "albums": albums}
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent,
                                         prefix=".album-graph-", delete=False) as out:
            temporary = Path(out.name)
            json.dump(result, out, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            out.write("\n")
        # Recheck after collection, including aliases created while exporting.
        protect_output(target, lib.path, store_path)
        os.replace(temporary, target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return result
