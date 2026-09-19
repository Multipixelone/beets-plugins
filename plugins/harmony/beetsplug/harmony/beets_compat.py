"""Pinned-beets proposal adapter.

This is intentionally the only Harmony module that knows about importer task
internals.  Everything above it deals in immutable source and discovery
evidence; this adapter either installs a fully checked MusicBrainz proposal or
does nothing at all.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Sequence

try:  # Keep Phase 1's pure modules importable before packaging supplies beets.
    import beets
    from beets import config
    from beets.autotag import Recommendation, tag_album
    from beets.autotag.match import AlbumMatch, Proposal
    from beets.importer import ImportTask, SingletonImportTask
    from beets.ui.commands.import_.session import TerminalImportSession
except ModuleNotFoundError:  # pragma: no cover - exercised by pure-module users
    beets = None  # type: ignore[assignment]
    config = None  # type: ignore[assignment]

    class ImportTask:  # type: ignore[no-redef]
        pass

    class SingletonImportTask(ImportTask):  # type: ignore[no-redef]
        pass

    class TerminalImportSession:  # type: ignore[no-redef]
        pass

    class AlbumMatch:  # type: ignore[no-redef]
        pass

    class Proposal:  # type: ignore[no-redef]
        pass

    class Recommendation:  # type: ignore[no-redef]
        pass

    def tag_album(*_args: object, **_kwargs: object) -> object:  # type: ignore[no-redef]
        raise RuntimeError("beets is required for Harmony proposal installation")

from .album import NormalizedAlbum, normalized_credit, snapshot_album, title_identity_key


# This is the release containing commit 63b69fa90656279bd3d41fa87ab68be1f98fdaae.
_PINNED_BEETS_VERSION = "2.13.1"


@dataclass(frozen=True, slots=True)
class TaskEvidence:
    """Immutable evidence retained while network and terminal work happens."""

    source: object
    items: tuple[object, ...]
    paths: tuple[object, ...]
    album: NormalizedAlbum


@dataclass(frozen=True, slots=True)
class ProposalInstallResult:
    """Result of a proposal attempt; failures never change a task."""

    installed: bool
    reason: str
    mbid: str


def eligible_task(session: object, task: object, *, enabled: bool, tty: bool) -> bool:
    """Return whether this exact pinned terminal import can be assisted."""
    if not enabled or not tty:
        return False
    if not isinstance(session, TerminalImportSession):
        return False
    # Exact type excludes sentinel/archive subclasses as well as singletons.
    if type(task) is not ImportTask or isinstance(task, SingletonImportTask):
        return False
    try:
        if not bool(session.config["autotag"]):
            return False
        if config["import"]["quiet"].get(bool):
            return False
    except (AttributeError, KeyError, TypeError, ValueError):
        return False
    return True


def should_offer_choice(task: object) -> bool:
    """Read private recommendation state for the weak-candidate hook only."""
    try:
        candidates = task.candidates
        recommendation = task.rec
    except (AttributeError, KeyError, TypeError, ValueError):
        return False
    return bool(candidates) and isinstance(recommendation, Recommendation) and recommendation <= Recommendation.medium


def should_assist_automatically(task: object) -> bool:
    """Read private candidate state for the zero-candidate hook only."""
    try:
        return task.candidates is not None and len(task.candidates) == 0
    except (AttributeError, KeyError, TypeError, ValueError):
        return False


def capture_task(task: object) -> TaskEvidence | None:
    """Capture the pinned source before any network or user interaction."""
    if type(task) is not ImportTask:
        return None
    try:
        # ``source`` is private task coupling and deliberately stays here.
        source = task.source
        items = tuple(task.items)
        paths = tuple(task.paths)
    except (AttributeError, KeyError, TypeError, ValueError):
        return None
    return TaskEvidence(source=source, items=items, paths=paths, album=snapshot_album(task))


def install_musicbrainz_proposal(
    task: object,
    evidence: TaskEvidence,
    selected_album: object,
    mbid: str,
    *,
    proposal_factory: Callable[..., object] = tag_album,
) -> ProposalInstallResult:
    """Install only a complete, pinned-shape MusicBrainz proposal.

    The calls and all validation happen before the two task assignments.  In
    particular, this never uses ``set_choice``: the existing terminal choice
    loop remains responsible for selection and eventual application.
    """
    if not _supported_runtime() or type(task) is not ImportTask:
        return ProposalInstallResult(False, "unsupported_beets", mbid)
    try:
        proposal = proposal_factory(evidence.source, search_ids=[mbid])
    except Exception:
        return ProposalInstallResult(False, "proposal_lookup_failed", mbid)
    if not _valid_proposal(proposal, evidence, selected_album, mbid):
        return ProposalInstallResult(False, "invalid_musicbrainz_proposal", mbid)

    assert isinstance(proposal, Proposal)
    # These are the sole Harmony assignments to importer proposal state.
    task.candidates = proposal.candidates
    task.rec = proposal.recommendation
    return ProposalInstallResult(True, "installed", mbid)


def _supported_runtime() -> bool:
    """Pin private layout support instead of guessing on newer beets releases."""
    if beets is None or getattr(beets, "__version__", None) != _PINNED_BEETS_VERSION:
        return False
    fields = getattr(AlbumMatch, "__dataclass_fields__", {})
    return (
        getattr(Proposal, "_fields", ()) == ("candidates", "recommendation")
        and {"info", "mapping", "extra_items", "extra_tracks"}.issubset(fields)
        # Pinned ImportTask exposes source as functools.cached_property, not a
        # built-in property, so require only descriptor semantics.
        and hasattr(getattr(ImportTask, "source", None), "__get__")
    )


def _valid_proposal(
    proposal: object, evidence: TaskEvidence, selected_album: object, mbid: str
) -> bool:
    if not isinstance(proposal, Proposal) or not isinstance(proposal.recommendation, Recommendation):
        return False
    candidates: Sequence[object] = proposal.candidates
    if len(candidates) != 1 or not isinstance(candidates[0], AlbumMatch):
        return False
    match = candidates[0]
    info = match.info
    if str(getattr(info, "data_source", "")).casefold() != "musicbrainz":
        return False
    if getattr(info, "album_id", None) != mbid:
        return False
    if match.extra_items or match.extra_tracks or not _complete_mapping(match, evidence.items):
        return False
    return _proposal_agrees_with_evidence(info, evidence.album, selected_album)


def _complete_mapping(match: AlbumMatch, expected_items: tuple[object, ...]) -> bool:
    mapping = match.mapping
    if len(mapping) != len(expected_items):
        return False
    return {id(item) for item in mapping} == {id(item) for item in expected_items}


def _proposal_agrees_with_evidence(info: object, source: NormalizedAlbum, selected: object) -> bool:
    """Avoid installing a proposal that disagrees with immutable evidence."""
    info_title = title_identity_key(getattr(info, "album", None))
    source_artist = source.album_artist_key
    selected_title = title_identity_key(getattr(selected, "title", None))
    selected_artist = normalized_credit(getattr(selected, "artists", None))
    info_artist = normalized_credit(getattr(info, "artist", None))
    return (
        bool(info_title)
        and info_title == source.title_key == selected_title
        and bool(info_artist)
        and info_artist == source_artist == selected_artist
    )
