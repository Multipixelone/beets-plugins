"""Read current album embeddings and statistics without modifying either database."""

import json
import logging
import math
import os
import subprocess
import tempfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from time import perf_counter

import numpy as np
from beets.dbcore.query import NumericQuery

from .covers import CoverCache, MIP_SIZES, source_path
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


LOSSLESS_FORMATS = {name.casefold() for name in ("FLAC", "ALAC", "WAV", "AIFF", "APE", "WavPack")}


def positive_number(value):
    try:
        number = float(value or 0)
    except (ValueError, TypeError, OverflowError):
        return None
    return number if math.isfinite(number) and number > 0 else None


def utc_timestamp(value):
    value = positive_number(value)
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")
    except (ValueError, OverflowError, OSError):
        return None


def file_size(item, directory):
    # Item.filesize swallows stat failures and returns zero. Keep the success
    # signal so a missing file differs from a successfully statted empty file.
    path = os.path.join(os.fsdecode(directory), os.fsdecode(item.path))
    try:
        return os.stat(path).st_size
    except OSError:
        return None


def dominant(counter):
    return min(counter, key=lambda value: (-counter[value], value)) if counter else None


class AlbumStatistics:
    def __init__(self):
        self.tracks = 0
        self.formats = Counter()
        self.lossless = True
        self.bitrates = 0.0
        self.bitrate_count = 0
        self.samplerates = Counter()
        self.bitdepths = Counter()
        self.size = 0
        self.sized_tracks = 0
        self.summed_plays = 0.0

    def add(self, item, format, size, play_count):
        self.tracks += 1
        if format:
            self.formats[format] += 1
        self.lossless = self.lossless and bool(format and format.casefold() in LOSSLESS_FORMATS)
        bitrate = positive_number(item.get("bitrate"))
        if bitrate is not None:
            self.bitrates += bitrate
            self.bitrate_count += 1
        for field, counts in (("samplerate", self.samplerates), ("bitdepth", self.bitdepths)):
            value = positive_number(item.get(field))
            if value is not None and int(value) > 0:
                counts[int(value)] += 1
        if size is not None:
            self.size += size
            self.sized_tracks += 1
        self.summed_plays += play_count

    def export(self):
        format = dominant(self.formats)
        if format is not None and self.formats[format] * 10 < self.tracks * 9:
            format = "Mixed"
        return {"format": format, "formats": dict(sorted(self.formats.items())),
                "lossless": bool(self.tracks and self.lossless),
                "bitrate_kbps": round(self.bitrates / self.bitrate_count / 1000) if self.bitrate_count else None,
                "samplerate_hz": dominant(self.samplerates), "bitdepth": dominant(self.bitdepths),
                "size_bytes": self.size if self.sized_tracks else None}


class LibraryStatistics:
    """Share selected-album processing with a bounded scan of remaining items."""
    def __init__(self, lib):
        started = perf_counter()
        self.lib = lib
        with lib.transaction() as tx:
            self.albums = {row["id"]: AlbumStatistics() for row in tx.query("SELECT id FROM albums")}
            self.maximum = tx.query("SELECT MAX(id) AS maximum FROM items")[0]["maximum"] or 0
        self.processed = set()
        self.tracks = self.size = self.missing = 0
        self.duration = self.listened = 0.0
        self.formats = {}
        self.elapsed = perf_counter() - started

    def consume(self, item):
        format = str(item.get("format") or "").strip() or None
        size = file_size(item, self.lib.directory)
        play_count = plays(item)
        length = positive_number(item.get("length")) or 0.0
        self.tracks += 1
        self.size += size or 0
        self.missing += size is None
        self.duration += length
        self.listened += length * play_count
        if format:
            counts = self.formats.setdefault(format, {"albums": 0, "tracks": 0, "size_bytes": 0})
            counts["tracks"] += 1
            counts["size_bytes"] += size or 0
        stats = self.albums.get(item.album_id)
        if stats is not None:
            stats.add(item, format, size, play_count)

    def consume_album(self, album_id, items):
        started = perf_counter()
        for item in items:
            self.consume(item)
            self.processed.add(item.id)
        self.elapsed += perf_counter() - started
        return self.albums[album_id]

    def finish(self):
        started = perf_counter()
        for first in range(0, self.maximum + 1, 512):
            # Results materializes rows and flex fields. Limit both to a page,
            # then release its database transaction before touching NAS files.
            items = list(self.lib.items(NumericQuery("id", f"{first}..{first + 511}")))
            for item in items:
                if item.id not in self.processed:
                    self.consume(item)
        lossless = 0
        for stats in self.albums.values():
            quality = stats.export()
            lossless += quality["lossless"]
            format = quality["format"]
            if format:
                self.formats.setdefault(format, {"albums": 0, "tracks": 0, "size_bytes": 0})["albums"] += 1
        result = {"albums": len(self.albums), "tracks": self.tracks, "size_bytes": self.size,
                  "duration_seconds": self.duration, "listened_seconds_estimate": self.listened,
                  "lossless_albums": lossless, "formats": dict(sorted(self.formats.items())),
                  "missing_files": self.missing,
                  "computed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
        self.elapsed += perf_counter() - started
        logging.getLogger(__name__).info("Library totals: %d albums, %d tracks, %d missing files in %.3f seconds",
                                         len(self.albums), self.tracks, self.missing, self.elapsed)
        return result


def release_metadata(album):
    result = {field: str(album.get(field) or "").strip() or None
              for field in ("albumtype", "label", "country", "mb_albumid")}
    year = positive_number(album.get("original_year"))
    result["original_year"] = int(year) if year is not None and int(year) > 0 else None
    return result


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
        library = LibraryStatistics(lib)
        # Only attempt embedding pooling for albums which could have vectors;
        # library totals include the remaining albums and standalone tracks.
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
            statistics = library.consume_album(album_id, items)
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
            summed = statistics.summed_plays
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
                           "added": utc_timestamp(album.get("added")),
                           **statistics.export(), "release": release_metadata(album),
                           "vector": quantize_vector(vector), "cover": None, "cover_large": None,
                           "text_vector": quantize_vector(text_vector) if text_vector is not None else None,
                           "text_embedded_tracks": text[0][0]['embedded_tracks'] if text_vector is not None else 0,
                           "essentia": aggregate_essentia(items)})
        library_totals = library.finish()
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
              "text_vector_encoding": "int8-base64", "text_vector_dimension": 512,
              "vector_encoding": "int8-base64", "vector_dimension": dimension or 0,
              "sound_encoding": "catalog-pairs-v1", "essentia_fields": list(ESSENTIA_FIELDS),
              "labels": labels,
              "library": library_totals,
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
                variants = {str(size): cache.cover(source if album["cover"] else None, size=size)
                            for size in MIP_SIZES}
                variants.update({"256": album["cover"], "512": album["cover_large"]})
                album["cover_variants"] = {size: name for size, name in variants.items() if name}
            result["cover_atlases"] = cache.overview(albums)
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
