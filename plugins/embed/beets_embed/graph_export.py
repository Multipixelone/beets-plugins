"""Read current album embeddings and statistics without modifying either database."""

import json
import logging
import math
import os
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .covers import CoverCache, source_path
from .retrieval import album_vectors
from .store import Store, model_ids
from .sounds import (ESSENTIA_FIELDS, LabelColumns, add_main_labels, aggregate_essentia,
                     compact_sound, pool_heads, quantize_vector)
from .descriptors import add_descriptors, phrase_embeddings, vocabulary


def protect_output(output, *inputs):
    target = Path(output).expanduser().absolute()
    resolved_target = target.resolve()
    for source in inputs:
        source = Path(source).expanduser().absolute()
        for protected in (source, *(Path(str(source) + suffix) for suffix in ("-wal", "-shm", "-journal"))):
            try:
                resolved_source = protected.resolve()
            except OSError:
                resolved_source = protected.absolute()
            try:
                same_file = target.exists() and protected.exists() and os.path.samefile(target, protected)
            except OSError:
                same_file = False
            if resolved_target == resolved_source or same_file:
                raise ValueError("Output must not overwrite an input database, artwork, or SQLite sidecar")
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


def export_albums(lib, selected_ids, store_path, model, output, covers_dir=None,
                  descriptors_file=None, cache_dir=None, worker=None):
    """Queries choose albums; pooling and play statistics always use whole albums."""
    target = protect_output(output, lib.path, store_path)
    selected_ids = set(selected_ids) - {None, 0}
    albums = []
    artwork = []
    heads, text_vectors = [], []
    models = model_ids()
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
            # Layout can be style or text; sound heads always use the current
            # style identity, and CLAP always uses the current text identity.
            heads.append(pool_heads(store, tracks, models['style']))
            text = list(album_vectors(store, tracks, models['text']))
            text_vector = np.asarray(text[0][1], dtype='f4') if text else None
            if text_vector is not None and (text_vector.shape != (512,) or
                    not np.isfinite(text_vector).all() or not np.any(text_vector)):
                text_vector = None
            text_vectors.append(text_vector)
            # Current beets uses a multi-value genres field; older libraries
            # and plugins may still expose genre as a flexible attribute.
            genre = album.get("genre") or album.get("genres") or next(
                (item.get("genre") or item.get("genres") for item in items
                 if item.get("genre") or item.get("genres")), "")
            if isinstance(genre, (list, tuple)):
                genre = "; ".join(genre)
            artwork.append(source_path(album.artpath, lib.directory))
            albums.append({"id": album_id, "album": album.album,
                           "albumartist": album.albumartist, "genre": genre,
                           "year": album.year, "track_count": len(items),
                           "embedded_tracks": info["embedded_tracks"],
                           "summed_plays": summed, "mean_plays": summed / len(items),
                           "vector": quantize_vector(vector), "cover": None, "cover_large": None,
                           "text_embedded_tracks": text[0][0]['embedded_tracks'] if text_vector is not None else 0,
                           "essentia": aggregate_essentia(items)})
    # A JSON output cannot overwrite original artwork either.
    protect_output(target, *(path for path in artwork if path is not None))
    cache = CoverCache(covers_dir, artwork, [lib.path, store_path, target,
                       *(str(path) + suffix for path in (lib.path, store_path)
                         for suffix in ("-wal", "-shm", "-journal"))]) if covers_dir else None
    columns = LabelColumns(len(albums))
    add_main_labels(albums, heads, columns)
    descriptor_summary = {'descriptor_cache': 'unused', 'descriptor_albums': 0}
    if any(vector is not None for vector in text_vectors):
        rows, digest = vocabulary(descriptors_file)
        try:
            embeddings, cache_status = phrase_embeddings(
                rows, digest, models['text'], cache_dir or target.parent / '.album-graph-cache', worker,
                [lib.path, store_path, target, *(path for path in artwork if path is not None),
                 *([descriptors_file] if descriptors_file else [])])
            add_descriptors(albums, text_vectors, rows, embeddings, columns)
            descriptor_summary.update(descriptor_cache=cache_status,
                                      descriptor_albums=sum(vector is not None for vector in text_vectors))
        except (OSError, ValueError, subprocess.SubprocessError) as exc:
            logging.getLogger(__name__).warning('Skipping CLAP descriptors: %s', exc)
            descriptor_summary['descriptor_cache'] = 'unavailable'
    labels = columns.export()
    compact_sound(albums, labels)
    result = {"schema_version": 3, "model_id": model, "text_model_id": models['text'],
              "vector_encoding": "int8-base64", "vector_dimension": dimension or 0,
              "sound_encoding": "catalog-pairs-v1", "essentia_fields": list(ESSENTIA_FIELDS),
              "labels": labels,
              "exported_at": datetime.now(timezone.utc).isoformat(),
              "summary": {"selected_albums": len(selected_ids), "exported_albums": len(albums),
                          "skipped_albums": len(selected_ids) - len(albums),
                          "covers_enabled": bool(cache), "covers_available": 0, "covers_missing": 0,
                          "covers_generated": 0, "covers_reused": 0, "covers_pruned": 0,
                          "covers_large_available": 0, "covers_large_missing": 0,
                          "covers_large_generated": 0, "covers_large_reused": 0,
                          **descriptor_summary},
              "albums": albums}
    try:
        if cache:
            for album, source in zip(albums, artwork):
                album["cover"] = cache.cover(source)
                album["cover_large"] = cache.cover(source if album["cover"] else None, large=True)
            result["summary"].update(cache.stats)
        write_export(result, target, lib.path, store_path, artwork)
    except BaseException:
        if cache:
            cache.abort()
        raise
    if cache:
        try:
            cache.finish()
        except (OSError, ValueError) as exc:
            # Cache maintenance must not invalidate a published export.
            logging.getLogger(__name__).warning("Cannot finish cover cache maintenance: %s", exc)
        if cache.stats["covers_pruned"]:
            result["summary"]["covers_pruned"] = cache.stats["covers_pruned"]
            write_export(result, target, lib.path, store_path, artwork)
    return result


def write_export(result, target, lib_path, store_path, artwork):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent,
                                         prefix=".album-graph-", delete=False) as out:
            temporary = Path(out.name)
            json.dump(result, out, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            out.write("\n")
        protect_output(target, lib_path, store_path, *(path for path in artwork if path is not None))
        os.replace(temporary, target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
