from __future__ import annotations

import sys
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from beets.autotag import AlbumInfo, Recommendation, TrackInfo
from beets.autotag.distance import Distance
from beets.autotag.match import AlbumMatch, Proposal
from beets.importer import ImportTask
from beets.library import Item

from beetsplug.harmony import beets_compat
from beetsplug.harmony.spotify_api import SpotifyAlbum, SpotifyArtist


MBID = "12345678-1234-1234-1234-123456789abc"


def source_items() -> list[Item]:
    return [
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


def selected_album() -> SpotifyAlbum:
    artist = SpotifyArtist("artist", "Artist")
    return SpotifyAlbum("0123456789ABCDEFGHIJKL", "Album", (artist,), None, "album", 1)


def musicbrainz_proposal(items: list[Item], *, mbid: str = MBID) -> Proposal:
    track = TrackInfo(title="Track", artist="Artist", index=1, medium=1, length=180.0)
    info = AlbumInfo(
        [track],
        album_id=mbid,
        album="Album",
        artist="Artist",
        data_source="MusicBrainz",
    )
    match = AlbumMatch(Distance(), info, {items[0]: track})
    return Proposal([match], Recommendation.strong)


class BeetsCompatibilityTest(unittest.TestCase):
    def make_task(self) -> tuple[ImportTask, list[Item]]:
        items = source_items()
        task = ImportTask(None, [b"/music"], items)
        task.candidates = []
        task.rec = Recommendation.none
        task.match = None
        return task, items

    @staticmethod
    def ledger(task: ImportTask) -> tuple[object, object, object, tuple[Item, ...], tuple[bytes, ...]]:
        return task.candidates, task.rec, task.match, tuple(task.items), tuple(task.paths)

    def test_real_pinned_types_install_one_validated_musicbrainz_proposal_after_validation(self):
        task, items = self.make_task()
        evidence = beets_compat.capture_task(task)
        assert evidence is not None
        proposal = musicbrainz_proposal(items)
        original = self.ledger(task)

        def proposal_factory(source, *, search_ids):
            self.assertIs(source, evidence.source)
            self.assertEqual([MBID], search_ids)
            self.assertEqual(original, self.ledger(task), "validation must precede task mutation")
            return proposal

        self.assertTrue(beets_compat._supported_runtime())
        outcome = beets_compat.install_musicbrainz_proposal(
            task, evidence, selected_album(), MBID, proposal_factory=proposal_factory
        )

        self.assertTrue(outcome.installed)
        self.assertEqual("installed", outcome.reason)
        self.assertIs(task.candidates, proposal.candidates)
        self.assertIs(task.rec, Recommendation.strong)
        self.assertIsNone(task.match, "Harmony must not make a beets choice")
        self.assertEqual(tuple(items), tuple(task.items))
        self.assertEqual((b"/music",), tuple(task.paths))

    def test_real_invalid_proposal_and_unknown_version_leave_the_full_ledger_untouched(self):
        task, items = self.make_task()
        evidence = beets_compat.capture_task(task)
        assert evidence is not None
        before = self.ledger(task)
        invalid = Proposal([], Recommendation.none)

        result = beets_compat.install_musicbrainz_proposal(
            task, evidence, selected_album(), MBID, proposal_factory=lambda *_args, **_kwargs: invalid
        )
        self.assertFalse(result.installed)
        self.assertEqual("invalid_musicbrainz_proposal", result.reason)
        self.assertEqual(before, self.ledger(task))

        factory = Mock(return_value=musicbrainz_proposal(items))
        with patch.object(beets_compat.beets, "__version__", "unknown"):
            result = beets_compat.install_musicbrainz_proposal(
                task, evidence, selected_album(), MBID, proposal_factory=factory
            )
        self.assertFalse(result.installed)
        self.assertEqual("unsupported_beets", result.reason)
        factory.assert_not_called()
        self.assertEqual(before, self.ledger(task))
