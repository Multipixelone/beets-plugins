"""Small, incremental artwork cache. Original artwork is opened only for reading."""

import hashlib
import json
import logging
import os
import re
import stat
import tempfile
import warnings
from pathlib import Path

from PIL import Image, ImageOps

LOG = logging.getLogger(__name__)
COVER_NAME = re.compile(r"cover-[0-9a-f]{64}\.jpg\Z")
RECIPE = "jpeg-contain-rgb-10151c-q85-v2"
THUMBNAIL_SIZE = 256
CARD_SIZE = 512
JPEG_QUALITY = 85
MANIFEST = ".album-graph-covers.json"


def source_path(artpath, directory):
    if not artpath:
        return None
    return Path(os.fsdecode(directory)) / os.fsdecode(artpath)


def identity(path):
    info = path.stat()
    if not stat.S_ISREG(info.st_mode):
        raise OSError("Artwork is not a regular file")
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


def atomic_write(target, write):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix=".cover-", delete=False) as out:
            temporary = Path(out.name)
            os.fchmod(out.fileno(), 0o640)
            write(out)
        os.replace(temporary, target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


class CoverCache:
    def __init__(self, directory, sources, protected):
        self.directory = Path(directory).expanduser().resolve()
        self.protected_paths = set()
        self.protected_inodes = set()
        for path in [*sources, *protected]:
            if path is None:
                continue
            path = Path(os.fsdecode(path)).expanduser()
            try:
                self.protected_paths.add(path.resolve())
                info = path.stat()
                self.protected_inodes.add((info.st_dev, info.st_ino))
            except OSError:
                # An unreadable source will be counted by cover(), not fail cache setup.
                self.protected_paths.add(path.absolute())
        self.used = set()
        self.created = set()
        self.previous = set()
        self.stats = dict(covers_enabled=True, covers_available=0, covers_missing=0,
                          covers_generated=0, covers_reused=0, covers_pruned=0,
                          covers_large_available=0, covers_large_missing=0,
                          covers_large_generated=0, covers_large_reused=0)
        self.guard(self.directory / MANIFEST)
        self.directory.mkdir(mode=0o750, parents=True, exist_ok=True)
        manifest = self.directory / MANIFEST
        if manifest.is_symlink():
            raise ValueError("Cover manifest must not be a symlink")
        if manifest.exists():
            # A bad manifest must never turn into a directory-wide deletion.
            try:
                value = json.loads(manifest.read_text())
                if value.get("version") != 1 or not isinstance(value.get("files"), list):
                    raise ValueError("Invalid cover cache manifest")
                self.previous = {name for name in value["files"]
                                 if isinstance(name, str) and COVER_NAME.fullmatch(name)}
            except (OSError, ValueError, AttributeError) as exc:
                LOG.warning("Cannot read cover cache manifest; preserving existing files: %s", exc)

    def guard(self, target):
        if target.is_symlink():
            raise ValueError("Cover outputs must not be symlinks")
        resolved = target.resolve()
        if resolved in self.protected_paths:
            raise ValueError("Cover output aliases original artwork or an input database")
        if target.exists():
            info = target.stat()
            if (info.st_dev, info.st_ino) in self.protected_inodes:
                raise ValueError("Cover output aliases original artwork or an input database")

    def cover(self, source, *, large=False):
        size = CARD_SIZE if large else THUMBNAIL_SIZE
        prefix = "covers_large" if large else "covers"
        if source is None:
            self.stats[f"{prefix}_missing"] += 1
            return None
        try:
            source = source.resolve()
            before = identity(source)
            key = json.dumps([str(source), before, f"{RECIPE}-{size}"], separators=(",", ":")).encode()
            name = f"cover-{hashlib.sha256(key).hexdigest()}.jpg"
            target = self.directory / name
            self.guard(target)
            # Check read access even when a cached thumbnail already exists.
            with source.open("rb") as original:
                if target.is_file() and target.stat().st_size:
                    self.stats[f"{prefix}_reused"] += 1
                else:
                    with warnings.catch_warnings():
                        warnings.simplefilter("error", Image.DecompressionBombWarning)
                        with Image.open(original) as image:
                            # JPEG draft decoding avoids decoding full-sized scans.
                            image.draft("RGB", (size * 2, size * 2))
                            image = ImageOps.exif_transpose(image)
                            image.thumbnail((size, size), Image.Resampling.LANCZOS)
                            canvas = Image.new("RGB", (size, size), (16, 21, 28))
                            rgba = image.convert("RGBA")
                            canvas.paste(rgba, ((size - image.width) // 2, (size - image.height) // 2), rgba)
                            if identity(source) != before:
                                raise OSError("Artwork changed during thumbnail generation")
                            def write(out):
                                canvas.save(out, "JPEG", quality=JPEG_QUALITY)
                                if identity(source) != before:
                                    raise OSError("Artwork changed during thumbnail encoding")
                                self.guard(target)
                            atomic_write(target, write)
                    self.created.add(name)
                    self.stats[f"{prefix}_generated"] += 1
            self.used.add(name)
            self.stats[f"{prefix}_available"] += 1
            return name
        except (OSError, ValueError, SyntaxError, Image.DecompressionBombError,
                Image.DecompressionBombWarning) as exc:
            LOG.warning("Cannot thumbnail artwork %s: %s", source, exc)
            self.stats[f"{prefix}_missing"] += 1
            return None

    def finish(self):
        """Called only after the JSON is published. Delete only recorded cache files."""
        retained = set()
        for name in self.previous - self.used:
            target = self.directory / name
            try:
                self.guard(target)
                if target.is_file():
                    target.unlink()
                    self.stats["covers_pruned"] += 1
            except (OSError, ValueError) as exc:
                retained.add(name)
                LOG.warning("Cannot prune thumbnail %s: %s", name, exc)
        manifest = self.directory / MANIFEST
        self.guard(manifest)
        payload = {"version": 1, "files": sorted(self.used | retained)}
        atomic_write(manifest, lambda out: out.write(json.dumps(payload).encode()))

    def abort(self):
        # Preserve the cache referenced by the last successful export.
        for name in self.created - self.previous:
            target = self.directory / name
            try:
                self.guard(target)
                target.unlink(missing_ok=True)
            except (OSError, ValueError):
                pass
