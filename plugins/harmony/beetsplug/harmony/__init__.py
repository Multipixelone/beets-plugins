"""Interactive, fail-open Harmony assistance for a pinned beets importer."""

from __future__ import annotations

from collections.abc import Callable, Sequence
import re
import sys
from weakref import WeakKeyDictionary

try:  # Preserve importability of Phase 1's pure modules outside the runtime.
    from beets import plugins
    from beets.util import PromptChoice
except ModuleNotFoundError:  # pragma: no cover - packaging always supplies beets
    class _UnavailablePlugin:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            raise RuntimeError("beets is required to load the Harmony plugin")

    class _Plugins:
        BeetsPlugin = _UnavailablePlugin

    plugins = _Plugins()  # type: ignore[assignment]

    class PromptChoice:  # type: ignore[no-redef]
        def __init__(self, short: str, long: str, callback: object) -> None:
            self.short, self.long, self.callback = short, long, callback

from . import beets_compat
from .album import NormalizedAlbum, normalized_credit, title_identity_key
from .errors import HarmonyError, InvalidReference, LookupAmbiguous
from .handoff import TerminalHandoff, osc52_copy
from .matching import CandidateEvaluation, MatchReason, match_candidates
from .musicbrainz import MusicBrainzClient, MusicBrainzRelease, release_has_spotify_url
from .spotify_api import SpotifyAlbum, SpotifyClient


_MBID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)
_MAX_SEARCH_RESULTS = 10
_MAX_INTERACTIONS = 12


class HarmonyPlugin(plugins.BeetsPlugin):
    """Assist one interactive album task without taking ownership of import."""

    def __init__(
        self,
        *,
        spotify_factory: Callable[[str, Callable[[str], None]], SpotifyClient] | None = None,
        musicbrainz_factory: Callable[[], MusicBrainzClient] | None = None,
        handoff_factory: Callable[[Callable[[str], None]], TerminalHandoff] | None = None,
        input_func: Callable[[str], str] = input,
        output: Callable[[str], None] | None = None,
        tty: Callable[[], bool] | None = None,
        copy_mbid: Callable[[str], None] | None = None,
    ) -> None:
        super().__init__()
        self.config.add(
            {
                "enabled": True,
                "spotify_market": "US",
                "poll_timeout": 120,
                "osc52": True,
                "qr": True,
            }
        )
        self._spotify_factory = spotify_factory or (
            lambda market, warning: SpotifyClient(market=market, warning=warning)
        )
        self._musicbrainz_factory = musicbrainz_factory or MusicBrainzClient
        self._handoff_factory = handoff_factory or (lambda warning: TerminalHandoff(warning=warning))
        self._input = input_func
        self._output = output or (lambda message: print(message))
        self._tty = tty or _stdio_tty
        self._copy_mbid = copy_mbid or _copy_mbid_to_terminal
        self._credential_warned: WeakKeyDictionary[object, bool] = WeakKeyDictionary()
        # A session can deliberately opt out of weak references (for example,
        # a slots-only terminal wrapper). Import interaction is serial, so one
        # bounded strong fallback preserves per-session once semantics without
        # retaining a history of completed sessions.
        self._nonweak_warning_session: object | None = None
        self._nonweak_warning_emitted = False
        self.register_listener("before_choose_candidate", self._before_choose_candidate)
        self.register_listener("import_task_before_choice", self._before_choice)

    def _before_choose_candidate(self, session: object, task: object) -> list[PromptChoice]:
        if not self._eligible(session, task) or not beets_compat.should_offer_choice(task):
            return []
        return [PromptChoice("h", "Harmony seed", self._prompt_harmony)]

    def _before_choice(self, session: object, task: object) -> None:
        if self._eligible(session, task) and beets_compat.should_assist_automatically(task):
            self._run_fail_open(session, task)
        return None

    def _prompt_harmony(self, session: object, task: object) -> None:
        self._run_fail_open(session, task)
        # Returning None makes the existing beets choice loop resume.
        return None

    def _eligible(self, session: object, task: object) -> bool:
        return beets_compat.eligible_task(
            session, task, enabled=self.config["enabled"].get(bool), tty=self._tty()
        )

    def _run_fail_open(self, session: object, task: object) -> None:
        try:
            self._assist(session, task)
        except HarmonyError as exc:
            self._warn("Harmony unavailable: {0}".format(exc))
        except Exception as exc:
            # This is the final hook boundary. Do not catch BaseException.
            self._warn("Harmony unavailable ({0}); continuing with beets.".format(type(exc).__name__))

    def _assist(self, session: object, task: object) -> None:
        evidence = beets_compat.capture_task(task)
        if evidence is None:
            return
        spotify = self._spotify_factory(self.config["spotify_market"].as_str(), self._session_warning(session))
        selected = self._select_spotify(spotify, evidence.album)
        if selected is None:
            return

        musicbrainz = self._musicbrainz_factory()
        validator = lambda release: _release_agrees(release, evidence.album, selected)
        try:
            linked = musicbrainz.find_linked_release(selected.url, validator)
        except LookupAmbiguous:
            self._manual_mbid(task, evidence, selected)
            return
        if linked is not None:
            self._install_or_fallback(task, evidence, selected, linked.id)
            return

        handoff = self._handoff_factory(self._warn)
        handoff.present(selected.url, osc52=self.config["osc52"].get(bool), qr=self.config["qr"].get(bool))
        answer = self._input(
            "Submit the release in MusicBrainz. [Enter] submitted; [c] cancel: "
        ).strip().casefold()
        if answer == "c":
            return
        try:
            found = musicbrainz.poll_for_submitted_release(
                selected.url, validator, poll_timeout=self.config["poll_timeout"].get(int)
            )
            if found is not None:
                self._install_or_fallback(task, evidence, selected, found.id)
                return
            indexed = musicbrainz.search_indexed_releases(
                artist=evidence.album.album_artist or None,
                title=evidence.album.title or None,
                date=str(evidence.album.year) if evidence.album.year else None,
            )
            valid = musicbrainz.validated_indexed_releases(indexed, validator)
        except LookupAmbiguous:
            self._manual_mbid(task, evidence, selected)
            return
        if len(valid) == 1:
            self._install_or_fallback(task, evidence, selected, valid[0].id)
            return
        self._manual_mbid(task, evidence, selected)

    def _select_spotify(
        self, spotify: SpotifyClient, source: NormalizedAlbum
    ) -> SpotifyAlbum | None:
        query = "{0} {1}".format(source.album_artist, source.title).strip()
        for _ in range(_MAX_INTERACTIONS):
            candidates = tuple(
                spotify.get_album(candidate.id)
                for candidate in spotify.search_albums(query, limit=_MAX_SEARCH_RESULTS)
            )
            result = match_candidates(source, candidates)
            if isinstance(result.selected, SpotifyAlbum):
                return result.selected
            selected, query = self._choose_candidate(spotify, candidates, result.evaluations, query)
            if selected is not None:
                return selected
            if query is None:
                return None
        self._warn("Harmony candidate selection limit reached; continuing with beets.")
        return None

    def _choose_candidate(
        self,
        spotify: SpotifyClient,
        candidates: Sequence[SpotifyAlbum],
        evaluations: Sequence[CandidateEvaluation],
        query: str,
    ) -> tuple[SpotifyAlbum | None, str | None]:
        self._output("Harmony Spotify candidates:")
        for number, candidate in enumerate(candidates, 1):
            reasons = _reasons_for(candidate, evaluations)
            summary = "; ".join(reason.message for reason in reasons[:2]) or "requires confirmation"
            self._output("  {0}. {1} — {2}".format(number, candidate.title, summary))
        answer = self._input("[number] select, [e]dit, [u]rl, [d]etails, [c]ancel: ").strip()
        if answer.casefold() == "c":
            return None, None
        if answer.casefold() == "e":
            edited = self._input("Spotify search query ([c] cancel): ").strip()
            return None, None if edited.casefold() == "c" else edited or query
        if answer.casefold() == "u":
            reference = self._input("Spotify album URL or ID ([c] cancel): ").strip()
            if reference.casefold() == "c":
                return None, query
            try:
                return spotify.get_album(reference), query
            except InvalidReference as exc:
                self._warn(str(exc))
                return None, query
        if answer.casefold() == "d":
            for candidate, evaluation in zip(candidates, evaluations):
                self._output(
                    candidate.title
                    + ": "
                    + "; ".join(reason.message for reason in evaluation.reasons)
                )
            return None, query
        try:
            index = int(answer)
        except ValueError:
            self._warn("Enter a candidate number, e, u, d, or c.")
            return None, query
        return (candidates[index - 1], query) if 1 <= index <= len(candidates) else (None, query)

    def _manual_mbid(self, task: object, evidence: beets_compat.TaskEvidence, selected: SpotifyAlbum) -> None:
        value = self._input("MusicBrainz release MBID ([c] cancel): ").strip()
        if value.casefold() == "c":
            return
        if not _MBID.fullmatch(value):
            self._warn("No valid MusicBrainz release MBID entered; continuing with beets.")
            return
        self._install_or_fallback(task, evidence, selected, value)

    def _install_or_fallback(
        self,
        task: object,
        evidence: beets_compat.TaskEvidence,
        selected: SpotifyAlbum,
        mbid: str,
    ) -> None:
        outcome = beets_compat.install_musicbrainz_proposal(task, evidence, selected, mbid)
        if outcome.installed:
            self._output("Harmony found MusicBrainz release {0}; returning to beets.".format(mbid))
            return
        if self.config["osc52"].get(bool):
            try:
                self._copy_mbid(mbid)
            except Exception as exc:
                self._warn("Could not copy MusicBrainz MBID ({0}).".format(type(exc).__name__))
        self._output("Harmony found MusicBrainz release {0}. Press i in beets and paste the MBID.".format(mbid))

    def _session_warning(self, session: object) -> Callable[[str], None]:
        def warning(message: str) -> None:
            try:
                warned = self._credential_warned.get(session, False)
                if not warned:
                    self._credential_warned[session] = True
                    self._warn(message)
            except TypeError:
                if session is not self._nonweak_warning_session:
                    self._nonweak_warning_session = session
                    self._nonweak_warning_emitted = False
                if not self._nonweak_warning_emitted:
                    self._nonweak_warning_emitted = True
                    self._warn(message)
        return warning

    def _warn(self, message: str) -> None:
        self._log.warning(message)


def _reasons_for(
    candidate: object, evaluations: Sequence[CandidateEvaluation]
) -> tuple[MatchReason, ...]:
    for evaluation in evaluations:
        if evaluation.candidate is candidate:
            return evaluation.reasons
    return ()


def _release_agrees(release: MusicBrainzRelease, source: NormalizedAlbum, selected: SpotifyAlbum) -> bool:
    """Require URL, release identity, and source/Spotify identity agreement."""
    if not release_has_spotify_url(release, selected.url):
        return False
    return (
        title_identity_key(release.title) == title_identity_key(selected.title) == source.title_key
        and normalized_credit(release.artist) == normalized_credit(selected.artists) == source.album_artist_key
    )


def _stdio_tty() -> bool:
    return bool(
        getattr(sys.stdin, "isatty", lambda: False)()
        and getattr(sys.stdout, "isatty", lambda: False)()
    )


def _copy_mbid_to_terminal(mbid: str) -> None:
    target = getattr(sys.stdout, "buffer", None)
    if target is None:
        raise OSError("stdout has no byte stream")
    target.write(osc52_copy(mbid))
    target.flush()
