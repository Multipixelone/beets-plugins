"""Strict, provider-neutral candidate matching for Harmony discovery."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import Enum
from typing import Any, Protocol, runtime_checkable

from .album import (
    NormalizedAlbum,
    edition_markers,
    normalized_credit,
    normalized_text,
    title_identity_key,
)


# These remain deliberately internal v1 tuning values, as specified in DESIGN.
_MIN_DURATION_COVERAGE = 0.80
_MAX_DURATION_DELTA_SECONDS = 3.0
_RUNNER_UP_MARGIN = 3.0


@runtime_checkable
class CandidateTrackProtocol(Protocol):
    """The small track shape required from a discovery provider."""

    disc_number: int | None
    track_number: int | None
    title: str
    artists: Sequence[object]
    duration: float | None
    automatic_match_eligible: bool
    automatic_match_reason: AutomaticMatchIneligibility | None


@runtime_checkable
class CandidateAlbumProtocol(Protocol):
    """Provider-neutral release shape; no Spotify imports belong here."""

    id: str
    title: str
    artists: Sequence[object]
    tracks: Sequence[CandidateTrackProtocol]


class AutomaticMatchIneligibility(str, Enum):
    """Bounded provider evidence for declining automatic selection."""

    PROVIDER_RESTRICTION = "provider_restriction"


@dataclass(frozen=True, slots=True)
class CandidateTrack:
    """Convenient immutable implementation of :class:`CandidateTrackProtocol`."""

    disc_number: int | None
    track_number: int | None
    title: str
    artists: tuple[str, ...]
    duration_seconds: float | None
    automatic_match_eligible: bool = True
    automatic_match_reason: AutomaticMatchIneligibility | None = None

    @property
    def duration(self) -> float | None:
        """Expose the provider duration at the matching boundary."""
        return self.duration_seconds


@dataclass(frozen=True, slots=True)
class CandidateAlbum:
    """Convenient immutable candidate model for clients and unit tests."""

    id: str
    title: str
    artists: tuple[str, ...]
    tracks: tuple[CandidateTrack, ...]
    year: int | None = None
    album_type: str | None = None
    medium_hints: frozenset[str] = frozenset({"digital"})


class ReasonCode(str, Enum):
    ACCEPTED = "accepted"
    SPARSE_METADATA = "sparse_metadata"
    PATH_DERIVED_METADATA = "path_derived_metadata"
    PHYSICAL_MEDIUM = "physical_medium"
    MEDIUM_CONFLICT = "medium_conflict"
    ALBUM_ARTIST_MISMATCH = "album_artist_mismatch"
    ALBUM_TITLE_MISMATCH = "album_title_mismatch"
    TRACK_COUNT_MISMATCH = "track_count_mismatch"
    TRACK_TITLE_MISMATCH = "track_title_mismatch"
    DURATION_COVERAGE = "duration_coverage"
    CANDIDATE_DURATION_MISSING = "candidate_duration_missing"
    DURATION_MISMATCH = "duration_mismatch"
    DISC_STRUCTURE_MISMATCH = "disc_structure_mismatch"
    EDITION_CONFLICT = "edition_conflict"
    VARIOUS_ARTISTS_CREDIT_MISMATCH = "various_artists_credit_mismatch"
    AMBIGUOUS_RUNNER_UP = "ambiguous_runner_up"
    SOURCE_METADATA_CONFLICT = "source_metadata_conflict"
    UNAVAILABLE_OR_RELINKED_TRACK = "unavailable_or_relinked_track"


@dataclass(frozen=True, slots=True)
class MatchReason:
    """A stable code plus text suitable for a prompt or verbose logging."""

    code: ReasonCode
    message: str
    details: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True, slots=True)
class CandidateEvaluation:
    candidate: CandidateAlbumProtocol
    accepted_hard_gates: bool
    score: float | None
    reasons: tuple[MatchReason, ...]


@dataclass(frozen=True, slots=True)
class MatchResult:
    """Selection outcome with complete, deterministic candidate diagnostics."""

    selected: CandidateAlbumProtocol | None
    evaluations: tuple[CandidateEvaluation, ...]
    reasons: tuple[MatchReason, ...]

    @property
    def is_exact_match(self) -> bool:
        return self.selected is not None

    @property
    def is_ambiguous(self) -> bool:
        return any(reason.code is ReasonCode.AMBIGUOUS_RUNNER_UP for reason in self.reasons)


def match_candidates(
    album: NormalizedAlbum, candidates: Sequence[CandidateAlbumProtocol]
) -> MatchResult:
    """Select a candidate only when every hard gate and separation rule passes."""
    evaluations = tuple(_evaluate(album, candidate) for candidate in candidates)
    passing = sorted(
        (evaluation for evaluation in evaluations if evaluation.accepted_hard_gates),
        key=lambda evaluation: evaluation.score if evaluation.score is not None else -1.0,
        reverse=True,
    )
    if not passing:
        return MatchResult(None, evaluations, _outcome_reasons(evaluations))

    winner = passing[0]
    if len(passing) > 1:
        runner_up = passing[1]
        assert winner.score is not None and runner_up.score is not None
        if winner.score - runner_up.score < _RUNNER_UP_MARGIN:
            reason = _reason(
                ReasonCode.AMBIGUOUS_RUNNER_UP,
                "Automatic selection refused: the closest candidate is similarly plausible.",
                winner=_candidate_id(winner.candidate),
                runner_up=_candidate_id(runner_up.candidate),
                score_gap=f"{winner.score - runner_up.score:.2f}",
            )
            return MatchResult(None, evaluations, (reason,))

    accepted = _reason(
        ReasonCode.ACCEPTED,
        "Exact Match: all available edition evidence agrees and the candidate is separated from rivals.",
        candidate=_candidate_id(winner.candidate),
        score=f"{winner.score:.2f}" if winner.score is not None else "0.00",
    )
    return MatchResult(winner.candidate, evaluations, (accepted,))


def _evaluate(album: NormalizedAlbum, candidate: CandidateAlbumProtocol) -> CandidateEvaluation:
    reasons: list[MatchReason] = []
    if album.path_derived:
        reasons.append(_reason(ReasonCode.PATH_DERIVED_METADATA, "Automatic selection refused: source metadata is path-derived."))
    elif album.is_sparse:
        reasons.append(_reason(ReasonCode.SPARSE_METADATA, "Automatic selection refused: source metadata is too sparse."))
    if "physical" in album.medium_hints:
        reasons.append(_reason(ReasonCode.PHYSICAL_MEDIUM, "Automatic selection requires confirmation for a physical source edition."))
    if album.conflicting_fields:
        reasons.append(_reason(ReasonCode.SOURCE_METADATA_CONFLICT, "Automatic selection refused: source album metadata conflicts across items.", fields=", ".join(sorted(album.conflicting_fields))))

    candidate_artist = normalized_credit(_field(candidate, "artists", "album_artist", "albumartist"))
    candidate_title = title_identity_key(_field(candidate, "title", "name"))
    if album.album_artist_key != candidate_artist:
        reasons.append(_reason(ReasonCode.ALBUM_ARTIST_MISMATCH, "Album artist credits do not agree.", local=" / ".join(album.album_artist_key), candidate=" / ".join(candidate_artist)))
    if album.title_key != candidate_title:
        reasons.append(_reason(ReasonCode.ALBUM_TITLE_MISMATCH, "Album titles do not agree.", local=album.title_key, candidate=candidate_title))

    candidate_mediums = _medium_hints(_field(candidate, "medium_hints", "media", "medium"))
    if "digital" in album.medium_hints and "physical" in candidate_mediums:
        reasons.append(_reason(ReasonCode.MEDIUM_CONFLICT, "Digital source evidence conflicts with the candidate medium."))

    local_markers = album.edition_markers
    candidate_markers = _candidate_markers(candidate)
    if local_markers != candidate_markers:
        reasons.append(_reason(ReasonCode.EDITION_CONFLICT, "Edition markers do not agree.", local=", ".join(sorted(local_markers)) or "original/unspecified", candidate=", ".join(sorted(candidate_markers)) or "original/unspecified"))

    candidate_tracks = tuple(_field(candidate, "tracks") or ())
    if len(album.tracks) != len(candidate_tracks):
        reasons.append(_reason(ReasonCode.TRACK_COUNT_MISMATCH, "Ordered track counts do not agree.", local=str(len(album.tracks)), candidate=str(len(candidate_tracks))))
        return CandidateEvaluation(candidate, False, None, tuple(reasons))

    coverage = album.duration_coverage
    if coverage < _MIN_DURATION_COVERAGE:
        reasons.append(_reason(ReasonCode.DURATION_COVERAGE, "Known local durations are below the required 80% coverage.", coverage=f"{coverage:.0%}"))

    for index, (local, remote) in enumerate(zip(album.tracks, candidate_tracks), start=1):
        if _field(remote, "automatic_match_eligible") is not True:
            reason = _field(remote, "automatic_match_reason")
            details = {"track": str(index)}
            if isinstance(reason, AutomaticMatchIneligibility):
                details["provider_reason"] = reason.value
            reasons.append(_reason(
                ReasonCode.UNAVAILABLE_OR_RELINKED_TRACK,
                "Candidate contains a track ineligible for automatic selection and requires confirmation.",
                **details,
            ))
        remote_title = normalized_text(_field(remote, "title", "name"))
        if local.title_key != remote_title:
            reasons.append(_reason(ReasonCode.TRACK_TITLE_MISMATCH, "Ordered track titles do not agree.", track=str(index), local=local.title_key, candidate=remote_title))
        if album.is_various_artists:
            remote_credit = normalized_credit(_field(remote, "artists", "artist", "artist_credit"))
            if local.artist_keys != remote_credit:
                reasons.append(_reason(ReasonCode.VARIOUS_ARTISTS_CREDIT_MISMATCH, "Various Artists track credits do not agree.", track=str(index), local=" / ".join(local.artist_keys), candidate=" / ".join(remote_credit)))
        if local.duration_seconds is not None:
            remote_duration = _candidate_seconds(remote)
            if remote_duration is None:
                reasons.append(_reason(ReasonCode.CANDIDATE_DURATION_MISSING, "Candidate lacks a duration for a known local track.", track=str(index)))
            elif abs(local.duration_seconds - remote_duration) > _MAX_DURATION_DELTA_SECONDS:
                reasons.append(_reason(ReasonCode.DURATION_MISMATCH, "Track durations differ by more than three seconds.", track=str(index), local=f"{local.duration_seconds:.2f}", candidate=f"{remote_duration:.2f}"))

    if not _disc_structure_agrees(album, candidate_tracks):
        reasons.append(_reason(ReasonCode.DISC_STRUCTURE_MISMATCH, "Disc structure does not agree."))
    if reasons:
        return CandidateEvaluation(candidate, False, None, tuple(reasons))
    return CandidateEvaluation(candidate, True, _soft_score(album, candidate), ())


def _disc_structure_agrees(album: NormalizedAlbum, tracks: Sequence[object]) -> bool:
    local_discs = album.disc_sequence
    remote_discs = tuple(_number(_field(track, "disc_number", "disc")) or 1 for track in tracks)
    # A multi-disc candidate is an edition conflict even when the local tagger
    # omitted disc numbers; it cannot be silently selected as a one-disc issue.
    return local_discs == remote_discs


def _candidate_markers(candidate: object) -> frozenset[str]:
    values: list[object] = [_field(candidate, "title", "name")]
    values.extend(_field(track, "title", "name") for track in tuple(_field(candidate, "tracks") or ()))
    return frozenset().union(*(edition_markers(value) for value in values))


def _soft_score(album: NormalizedAlbum, candidate: object) -> float:
    """Rank only hard-gate survivors; it can never resolve a conflict."""
    score = album.duration_coverage * 10.0
    candidate_year = _number(_field(candidate, "year", "date", "release_year", "release_date"))
    if album.year and candidate_year:
        difference = abs(album.year - candidate_year)
        score += 8.0 if difference == 0 else 4.0 if difference == 1 else 0.0
    local_type = " ".join(sorted(album.medium_hints))
    candidate_type = normalized_text(_field(candidate, "album_type", "type"))
    if local_type and candidate_type and local_type in candidate_type:
        score += 2.0
    if normalized_text(album.title) == normalized_text(_field(candidate, "title", "name")):
        score += 2.0
    if normalized_credit(album.album_artist) == normalized_credit(_field(candidate, "artists", "album_artist", "albumartist")):
        score += 2.0
    return score


def _outcome_reasons(evaluations: Sequence[CandidateEvaluation]) -> tuple[MatchReason, ...]:
    for evaluation in evaluations:
        if evaluation.reasons:
            return evaluation.reasons
    return ()


def _reason(code: ReasonCode, message: str, **details: str) -> MatchReason:
    return MatchReason(code, message, tuple(sorted(details.items())))


def _field(subject: object, *names: str) -> Any:
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


def _candidate_seconds(track: object) -> float | None:
    seconds = _field(track, "duration_seconds", "duration", "length")
    if isinstance(seconds, (int, float)) and not isinstance(seconds, bool) and seconds > 0:
        return float(seconds)
    milliseconds = _field(track, "duration_ms")
    if isinstance(milliseconds, (int, float)) and not isinstance(milliseconds, bool) and milliseconds > 0:
        return float(milliseconds) / 1000.0
    return None


def _number(value: object) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = int(value)
    except (TypeError, ValueError):
        import re

        match = re.search(r"\d+", str(value))
        if match is None:
            return None
        number = int(match.group())
    return number if number > 0 else None


def _medium_hints(value: object) -> frozenset[str]:
    if value is None:
        return frozenset()
    values = (value,) if isinstance(value, str) else tuple(value)
    hints: set[str] = set()
    for entry in values:
        text = normalized_text(entry)
        if any(word in text.split() for word in ("cd", "vinyl", "lp", "sacd", "hdcd", "cassette", "physical", "blu", "dvd")):
            hints.add("physical")
        if any(word in text for word in ("digital", "file", "download", "stream")):
            hints.add("digital")
    return frozenset(hints)


def _candidate_id(candidate: object) -> str:
    value = _field(candidate, "id", "uri", "url")
    return str(value) if value is not None else "unknown candidate"
