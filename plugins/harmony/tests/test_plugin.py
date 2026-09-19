from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from beets.autotag import AlbumInfo, Recommendation, TrackInfo
from beets.autotag.distance import Distance
from beets.autotag.match import AlbumMatch, Proposal
from beets.importer import ImportTask
from beets.library import Item
from beets.ui.commands.import_ import session as terminal_session

from beetsplug.harmony import HarmonyPlugin
from beetsplug.harmony import beets_compat
from beetsplug.harmony.album import NormalizedAlbum
from beetsplug.harmony.errors import ServiceUnavailable
from beetsplug.harmony.spotify_api import SpotifyAlbum, SpotifyArtist


class View:
    def __init__(self, value):
        self.value = value

    def get(self, _type=None):
        return self.value

    def as_str(self):
        return str(self.value)


class PluginHarness(HarmonyPlugin):
    """Avoid beets global setup while exercising the hook/workflow boundary."""

    def __init__(self, *, inputs=(), spotify=None, musicbrainz=None):
        self.config = {key: View(value) for key, value in {
            "enabled": True, "spotify_market": "US", "poll_timeout": 1,
            "osc52": False, "qr": False,
        }.items()}
        self._input_values = iter(inputs)
        self._input = lambda _prompt: next(self._input_values)
        self._output_lines = []
        self._output = self._output_lines.append
        self._warnings = []
        self._log = SimpleNamespace(warning=self._warnings.append)
        self._spotify_factory = lambda _market, _warning: spotify
        self._musicbrainz_factory = lambda: musicbrainz
        self._handoff_factory = lambda _warning: SimpleNamespace(present=lambda *_args, **_kwargs: None)
        self._tty = lambda: True
        self._copy_mbid = lambda _mbid: None
        from weakref import WeakKeyDictionary
        self._credential_warned = WeakKeyDictionary()
        self._nonweak_warning_session = None
        self._nonweak_warning_emitted = False


class MutableTask:
    def __init__(self):
        self.items = [SimpleNamespace(path=b"one")]
        self.paths = [b"one"]
        self.candidates = []
        self.rec = "original-rec"
        self.match = "original-match"

    def ledger(self):
        return (tuple(self.items), tuple(self.paths), self.candidates, self.rec, self.match)


def evidence():
    album = NormalizedAlbum(
        "Artist", ("artist",), "Album", "album", frozenset(), None,
        frozenset({"digital"}), (), frozenset(), False, True, False,
    )
    return beets_compat.TaskEvidence(object(), (), (), album)


def spotify_album():
    artist = SpotifyArtist("artist", "Artist")
    return SpotifyAlbum("0123456789ABCDEFGHIJKL", "Album", (artist,), None, "album", 0)


def pinned_task() -> tuple[ImportTask, list[Item]]:
    items = [
        Item(
            path=b"/music/track.flac",
            album="Album",
            albumartist="Artist",
            artist="Artist",
            title="Track",
            track=1,
            disc=1,
            length=180.0,
        )
    ]
    return ImportTask(None, [b"/music"], items), items


def pinned_match(items: list[Item], mbid: str) -> AlbumMatch:
    track = TrackInfo(title="Track", artist="Artist", index=1, medium=1, length=180.0)
    info = AlbumInfo(
        [track],
        album_id=mbid,
        album="Album",
        artist="Artist",
        data_source="MusicBrainz",
    )
    return AlbumMatch(Distance(), info, {items[0]: track})


class PluginHookTest(unittest.TestCase):
    def test_auto_no_candidate_and_medium_prompt_hooks(self):
        plugin = PluginHarness()
        session, task = object(), MutableTask()
        plugin._eligible = Mock(return_value=True)
        plugin._run_fail_open = Mock()
        with patch.object(beets_compat, "should_assist_automatically", return_value=True):
            self.assertIsNone(plugin._before_choice(session, task))
        plugin._run_fail_open.assert_called_once_with(session, task)
        with patch.object(beets_compat, "should_offer_choice", return_value=True):
            choices = plugin._before_choose_candidate(session, task)
        self.assertEqual([("h", "Harmony seed")], [(choice.short, choice.long) for choice in choices])

    def test_strong_singleton_quiet_nontty_and_autotag_off_are_noops(self):
        plugin = PluginHarness()
        plugin._eligible = Mock(return_value=False)
        task = MutableTask()
        for label in ("strong", "singleton", "quiet", "non-tty", "autotag-off"):
            with self.subTest(label=label), patch.object(beets_compat, "should_offer_choice") as offered:
                self.assertEqual([], plugin._before_choose_candidate(object(), task))
                offered.assert_not_called()

    def test_cancel_and_service_failure_preserve_the_mutation_ledger(self):
        task = MutableTask()
        before = task.ledger()
        spotify = SimpleNamespace(search_albums=lambda *_args, **_kwargs: (spotify_album(),), get_album=lambda _id: spotify_album())
        plugin = PluginHarness(inputs=("c",), spotify=spotify)
        with patch.object(beets_compat, "capture_task", return_value=evidence()):
            plugin._assist(object(), task)
        self.assertEqual(before, task.ledger())

        failed = PluginHarness(spotify=SimpleNamespace(search_albums=lambda *_args, **_kwargs: (_ for _ in ()).throw(ServiceUnavailable("down"))))
        with patch.object(beets_compat, "capture_task", return_value=evidence()):
            failed._run_fail_open(object(), task)
        self.assertEqual(before, task.ledger())
        self.assertTrue(failed._warnings)

    def test_ctrl_c_propagates_and_sequential_tasks_do_not_share_workflow_state(self):
        task = MutableTask()
        plugin = PluginHarness(inputs=(), spotify=SimpleNamespace())
        plugin._assist = Mock(side_effect=KeyboardInterrupt())
        with self.assertRaises(KeyboardInterrupt):
            plugin._run_fail_open(object(), task)

        first, second = MutableTask(), MutableTask()
        before_first, before_second = first.ledger(), second.ledger()
        cancel = PluginHarness(inputs=("c", "c"), spotify=SimpleNamespace(search_albums=lambda *_args, **_kwargs: (spotify_album(),), get_album=lambda _id: spotify_album()))
        with patch.object(beets_compat, "capture_task", return_value=evidence()):
            cancel._assist(object(), first)
            cancel._assist(object(), second)
        self.assertEqual(before_first, first.ledger())
        self.assertEqual(before_second, second.ledger())

    def test_compatibility_fallback_keeps_task_state_and_instructs_manual_id(self):
        task = MutableTask()
        before = task.ledger()
        plugin = PluginHarness()
        fallback = beets_compat.ProposalInstallResult(False, "unsupported_beets", "12345678-1234-1234-1234-123456789abc")
        with patch.object(beets_compat, "install_musicbrainz_proposal", return_value=fallback):
            plugin._install_or_fallback(task, evidence(), spotify_album(), fallback.mbid)
        self.assertEqual(before, task.ledger())
        self.assertIn("Press i", plugin._output_lines[-1])

    def test_nonweakref_sessions_warn_once_without_retaining_prior_sessions(self):
        class NonWeakSession:
            __slots__ = ()

        plugin = PluginHarness()
        first = NonWeakSession()
        warning = plugin._session_warning(first)
        warning("credentials unavailable")
        warning("credentials unavailable")
        self.assertEqual(["credentials unavailable"], plugin._warnings)

        second = NonWeakSession()
        plugin._session_warning(second)("credentials unavailable")
        self.assertEqual(["credentials unavailable", "credentials unavailable"], plugin._warnings)
        self.assertIs(plugin._nonweak_warning_session, second)

    def test_real_terminal_choice_loop_resumes_with_installed_proposal(self):
        task, items = pinned_task()
        old_match = pinned_match(items, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
        new_match = pinned_match(items, "12345678-1234-1234-1234-123456789abc")
        proposal = Proposal([new_match], Recommendation.strong)
        task.candidates = [old_match]
        task.rec = Recommendation.medium
        task.match = None

        plugin = HarmonyPlugin(tty=lambda: True)
        plugin._eligible = Mock(return_value=True)
        installed_before_normal_choice = []

        def install_from_callback(_session, callback_task):
            evidence = beets_compat.capture_task(callback_task)
            assert evidence is not None
            result = beets_compat.install_musicbrainz_proposal(
                callback_task,
                evidence,
                spotify_album(),
                "12345678-1234-1234-1234-123456789abc",
                proposal_factory=lambda *_args, **_kwargs: proposal,
            )
            self.assertTrue(result.installed)
            installed_before_normal_choice.append(callback_task.match)

        plugin._assist = install_from_callback
        callback_results = []
        original_callback = plugin._prompt_harmony

        def callback(session, callback_task):
            result = original_callback(session, callback_task)
            callback_results.append(result)
            return result

        plugin._prompt_harmony = callback
        session = object.__new__(terminal_session.TerminalImportSession)
        session.log_choice = lambda *_args: None

        def send(event, **kwargs):
            if event == "before_choose_candidate":
                return [plugin._before_choose_candidate(kwargs["session"], kwargs["task"])]
            return []

        with patch.object(terminal_session.plugins, "send", side_effect=send), patch.object(
            terminal_session.ui, "input_options", return_value="h"
        ), patch.object(terminal_session.ui, "print_"), patch.object(
            terminal_session, "show_change"
        ):
            task.choose_match(session)

        self.assertEqual([None], callback_results)
        self.assertEqual([None], installed_before_normal_choice)
        self.assertIs(task.candidates, proposal.candidates)
        self.assertIs(task.rec, Recommendation.strong)
        self.assertIs(task.match, new_match, "normal beets selection resumes after Harmony returns None")
        task.apply_metadata()
        self.assertEqual(
            "12345678-1234-1234-1234-123456789abc",
            items[0].mb_albumid,
            "normal beets application, not Harmony, writes proposal metadata",
        )
