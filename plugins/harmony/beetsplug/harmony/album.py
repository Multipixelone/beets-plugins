"""Pure, immutable snapshots of the local album being imported.

The importer owns its task and items.  This module deliberately only reads
them, so matching cannot accidentally change tags or importer state.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
import os
import re
import unicodedata
from typing import Any


_FEATURE_SEPARATOR = re.compile(
    r"\s*(?:\bfeat(?:uring)?\.?\b|\bft\.?\b|\band\b|&|;|,)\s*",
    re.IGNORECASE,
)
_WORD = re.compile(r"[^\w]+", re.UNICODE)
_NUMBER = re.compile(r"\d+")
_TIME = re.compile(r"^(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)$")


@dataclass(frozen=True, slots=True)
class NormalizedTrack:
    """Read-only Match Evidence for one local track."""

    disc_number: int | None
    track_number: int | None
    title: str
    title_key: str
    artists: tuple[str, ...]
    artist_keys: tuple[str, ...]
    duration_seconds: float | None
    source_path: str | None
    source_index: int


@dataclass(frozen=True, slots=True)
class NormalizedAlbum:
    """Read-only Match Evidence captured from an album import task."""

    album_artist: str
    album_artist_key: tuple[str, ...]
    title: str
    title_key: str
    edition_markers: frozenset[str]
    year: int | None
    medium_hints: frozenset[str]
    tracks: tuple[NormalizedTrack, ...]
    conflicting_fields: frozenset[str]
    is_various_artists: bool
    is_sparse: bool
    path_derived: bool

    @property
    def known_duration_count(self) -> int:
        return sum(track.duration_seconds is not None for track in self.tracks)

    @property
    def duration_coverage(self) -> float:
        if not self.tracks:
            return 0.0
        return self.known_duration_count / len(self.tracks)

    @property
    def disc_sequence(self) -> tuple[int, ...]:
        """One disc number per ordered track; absent numbers mean disc one."""
        return tuple(track.disc_number or 1 for track in self.tracks)


def normalized_text(value: object) -> str:
    """Return a Unicode-tolerant comparison key without discarding words."""
    if value is None:
        return ""
    text = str(value).strip()
    # NFKD makes composed/decomposed tags comparable and removes only marks;
    # non-Latin letters remain intact.
    text = "".join(
        character
        for character in unicodedata.normalize("NFKD", text)
        if unicodedata.category(character) != "Mn"
    )
    return _WORD.sub(" ", text.casefold()).strip()


def normalized_credit(value: object) -> tuple[str, ...]:
    """Normalize artist-credit spelling and common featured-artist forms."""
    names = _as_strings(value)
    parts: list[str] = []
    for name in names:
        parts.extend(_FEATURE_SEPARATOR.split(name))
    return tuple(part for part in (normalized_text(part) for part in parts) if part)


def edition_markers(value: object) -> frozenset[str]:
    """Extract edition-bearing words while treating an original issue as baseline."""
    text = normalized_text(value)
    markers: set[str] = set()
    if re.search(r"\bdeluxe(?: edition)?\b", text):
        markers.add("deluxe")
    if re.search(r"\b(?:remaster|remastered|remastering)\b", text):
        markers.add("remastered")
    if re.search(r"\bexpanded(?: edition)?\b", text):
        markers.add("expanded")
    if re.search(r"\b(?:bonus|bonus tracks?)\b", text):
        markers.add("bonus")
    if re.search(r"\bclean\b", text):
        markers.add("clean")
    if re.search(r"\bexplicit\b", text):
        markers.add("explicit")
    if re.search(r"\b(?:anniversary|anniversaire)\b", text):
        anniversary = re.search(
            r"\b(?:\d{1,4}(?:st|nd|rd|th)?\s+)?anniversary\b", text
        )
        markers.add(anniversary.group(0) if anniversary else "anniversary")

    regions = {
        "australian", "brazilian", "canadian", "european", "french",
        "german", "international", "japan", "japanese", "korean",
        "uk", "united kingdom", "us", "usa", "us only",
    }
    for region in regions:
        if re.search(r"\b" + re.escape(region) + r"\b", text):
            markers.add("region:" + region)
    return frozenset(markers)


def title_identity_key(value: object) -> str:
    """Compare album names independently from harmless edition spelling.

    ``Original`` is deliberately not an edition word here. It is affirmative
    source evidence, so removing it could turn an original-version title into
    an otherwise indistinguishable candidate.
    """
    text = normalized_text(value)
    text = re.sub(r"\bdeluxe(?: edition)?\b", " ", text)
    text = re.sub(r"\b(?:remaster|remastered|remastering)\b", " ", text)
    text = re.sub(r"\bexpanded(?: edition)?\b", " ", text)
    text = re.sub(r"\b(?:bonus|bonus tracks?|clean|explicit)\b", " ", text)
    text = re.sub(r"\b(?:\d{1,4}(?:st|nd|rd|th)?\s+)?anniversary\b", " ", text)
    for region in (
        "australian", "brazilian", "canadian", "european", "french",
        "german", "international", "japan", "japanese", "korean",
        "united kingdom", "usa", "uk", "us",
    ):
        text = re.sub(r"\b" + re.escape(region) + r"\b", " ", text)
    return " ".join(text.split())


def normalize_album(task: object) -> NormalizedAlbum:
    """Build a snapshot from a beets task or a task-shaped test object.

    Missing and malformed values become absent evidence rather than exceptions.
    Paths are retained for diagnostics only and are never parsed as metadata.
    """
    items = tuple(_task_items(task))
    tracks = tuple(_normalize_track(item, index) for index, item in enumerate(items))
    tracks = _ordered_tracks(tracks)

    album_artist = _first_value(task, items, "albumartist", "album_artist")
    album_title = _first_value(task, items, "album", "albumtitle", "album_title")
    year = _as_number(_first_value(task, items, "year", "date"))
    media_values = _values(task, "media", "medium", "format")
    if not media_values:
        media_values = tuple(value for item in items for value in _values(item, "media", "medium", "format"))

    artist_text = _as_text(album_artist)
    title_text = _as_text(album_title)
    marker_values: list[object] = [album_title]
    marker_values.extend(track.title for track in tracks)
    markers = frozenset().union(*(edition_markers(value) for value in marker_values))
    artist_key = normalized_credit(album_artist)
    title_key = title_identity_key(album_title)
    path_derived = _as_bool(
        _read(task, "path_derived", "metadata_from_path", "is_path_derived")
    )
    conflicts = _conflicting_album_fields(task, items)
    sparse = (
        not artist_key
        or not title_key
        or not tracks
        or any(not track.title_key for track in tracks)
        # Task iteration order may reflect filesystem traversal; without track
        # numbers it is not sufficiently reliable edition evidence.
        or any(track.track_number is None for track in tracks)
        or path_derived
    )
    return NormalizedAlbum(
        album_artist=artist_text,
        album_artist_key=artist_key,
        title=title_text,
        title_key=title_key,
        edition_markers=markers,
        year=year,
        medium_hints=_medium_hints(media_values),
        tracks=tracks,
        conflicting_fields=conflicts,
        is_various_artists=_is_various_artists(artist_key),
        is_sparse=sparse,
        path_derived=path_derived,
    )


# A descriptive alias useful to callers that prefer the domain term.
snapshot_album = normalize_album


def _normalize_track(item: object, index: int) -> NormalizedTrack:
    title = _as_text(_read(item, "title"))
    artist = _read(item, "artist", "artists", "artist_credit")
    path = _read(item, "path")
    if isinstance(path, bytes):
        path = os.fsdecode(path)
    return NormalizedTrack(
        disc_number=_as_number(_read(item, "disc", "disc_number")),
        track_number=_as_number(_read(item, "track", "track_number")),
        title=title,
        title_key=normalized_text(title),
        artists=_as_strings(artist),
        artist_keys=normalized_credit(artist),
        duration_seconds=_as_seconds(_read(item, "length", "duration", "duration_seconds")),
        source_path=str(path) if path else None,
        source_index=index,
    )


def _task_items(task: object) -> Sequence[object]:
    items = _read(task, "items")
    if callable(items):
        try:
            items = items()
        except (TypeError, ValueError):
            items = ()
    if items is None and isinstance(task, Sequence) and not isinstance(task, (str, bytes)):
        items = task
    try:
        return tuple(items or ())
    except TypeError:
        return ()


def _ordered_tracks(tracks: tuple[NormalizedTrack, ...]) -> tuple[NormalizedTrack, ...]:
    """Use explicit disc/track order only when every track supplies it."""
    if tracks and all(track.track_number is not None for track in tracks):
        return tuple(
            sorted(
                tracks,
                key=lambda track: (track.disc_number or 1, track.track_number or 0, track.source_index),
            )
        )
    return tracks


def _read(subject: object, *names: str) -> object | None:
    for name in names:
        if isinstance(subject, Mapping) and name in subject:
            return subject[name]
        try:
            value = getattr(subject, name)
        except (AttributeError, KeyError, TypeError, ValueError):
            value = None
        if value is not None:
            return value
        getter = getattr(subject, "get", None)
        if callable(getter):
            try:
                value = getter(name)
            except (AttributeError, KeyError, TypeError, ValueError):
                value = None
            if value is not None:
                return value
    return None


def _first_value(task: object, items: Sequence[object], *names: str) -> object | None:
    value = _read(task, *names)
    if value not in (None, ""):
        return value
    for item in items:
        value = _read(item, *names)
        if value not in (None, ""):
            return value
    return None


def _values(subject: object, *names: str) -> tuple[object, ...]:
    return tuple(value for name in names if (value := _read(subject, name)) not in (None, ""))


def _as_text(value: object) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _as_strings(value: object) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, Mapping):
        value = value.get("name", value.get("artist", ""))
    if isinstance(value, (str, bytes)):
        return (_as_text(os.fsdecode(value) if isinstance(value, bytes) else value),)
    if isinstance(value, Sequence):
        result: list[str] = []
        for entry in value:
            if isinstance(entry, Mapping):
                entry = entry.get("name", entry.get("artist", ""))
            else:
                entry = _read(entry, "name", "artist") if not isinstance(entry, str) else entry
            text = _as_text(entry)
            if text:
                result.append(text)
        return tuple(result)
    return (_as_text(value),)


def _as_number(value: object) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value) if value > 0 else None
    match = _NUMBER.search(str(value))
    return int(match.group()) if match and int(match.group()) > 0 else None


def _as_seconds(value: object) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, str):
        match = _TIME.match(value.strip())
        if match:
            hours = int(match.group(1) or 0)
            return hours * 3600 + int(match.group(2)) * 60 + float(match.group(3))
        try:
            value = float(value)
        except ValueError:
            return None
    if isinstance(value, (int, float)) and value > 0:
        return float(value)
    return None


def _as_bool(value: object) -> bool:
    return value is True or (isinstance(value, str) and value.casefold() in {"1", "true", "yes"})


def _medium_hints(values: Sequence[object]) -> frozenset[str]:
    hints: set[str] = set()
    for value in values:
        text = normalized_text(value)
        if any(word in text.split() for word in ("cd", "vinyl", "lp", "sacd", "hdcd", "cassette", "physical", "blu", "dvd")):
            hints.add("physical")
        if any(word in text for word in ("digital", "file", "download", "stream")):
            hints.add("digital")
    return frozenset(hints)


def _is_various_artists(credit: tuple[str, ...]) -> bool:
    return credit in {("various artists",), ("va",)}


def _conflicting_album_fields(task: object, items: Sequence[object]) -> frozenset[str]:
    """Retain disagreements instead of silently choosing the first item value."""
    sources = (task,) + tuple(items)
    checks = {
        "album_artist": ("albumartist", "album_artist"),
        "album_title": ("album", "albumtitle", "album_title"),
        "year": ("year", "date"),
        "medium": ("media", "medium", "format"),
    }
    conflicts: set[str] = set()
    for field, names in checks.items():
        values = [_read(source, *names) for source in sources]
        values = [value for value in values if value not in (None, "")]
        if field == "album_artist":
            normalized = {normalized_credit(value) for value in values}
        elif field == "album_title":
            normalized = {normalized_text(value) for value in values}
        elif field == "year":
            normalized = {_as_number(value) for value in values}
        else:
            normalized = {_medium_hints((value,)) for value in values}
        if len(normalized) > 1:
            conflicts.add(field)
    return frozenset(conflicts)
