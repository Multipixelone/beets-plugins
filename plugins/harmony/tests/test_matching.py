from __future__ import annotations

import unittest

from beetsplug.harmony.album import normalize_album
from beetsplug.harmony.matching import (
    CandidateAlbum,
    CandidateAlbumProtocol,
    CandidateTrackProtocol,
    CandidateTrack,
    AutomaticMatchIneligibility,
    ReasonCode,
    match_candidates,
)
from beetsplug.harmony.spotify_api import SpotifyAlbum, SpotifyArtist, SpotifyTrack


class Item:
    def __init__(self, **fields):
        self.__dict__.update(fields)


class Task:
    def __init__(self, items, **fields):
        self.items = items
        self.__dict__.update(fields)


def local_album(*, count=5, artist="Artist", title="Album", media="Digital Media", durations=None, **task_fields):
    durations = durations if durations is not None else [180.0] * count
    items = [
        Item(album=title, albumartist=artist, title=f"Track {number}", artist=artist,
             disc=1, track=number, length=durations[number - 1], media=media)
        for number in range(1, count + 1)
    ]
    return normalize_album(Task(items, **task_fields))


def candidate_for(album, *, identifier="one", durations=None, title=None, artists=None, tracks=None, **fields):
    if tracks is None:
        durations = durations if durations is not None else [track.duration_seconds for track in album.tracks]
        tracks = tuple(
            CandidateTrack(track.disc_number, track.track_number, track.title, track.artists, duration)
            for track, duration in zip(album.tracks, durations)
        )
    return CandidateAlbum(
        identifier, title if title is not None else album.title,
        tuple(artists if artists is not None else album.album_artist_key), tuple(tracks), **fields
    )


class MatchingTest(unittest.TestCase):
    def test_single_disc_exact_match_is_selected_with_acceptance_reason(self):
        album = local_album()
        candidate = candidate_for(album)

        result = match_candidates(album, [candidate])

        self.assertIs(result.selected, candidate)
        self.assertEqual(result.reasons[0].code, ReasonCode.ACCEPTED)

    def test_duration_coverage_and_three_second_boundaries_are_hard_gates(self):
        below = local_album(durations=[180, 180, 180, None, None])
        at_boundary = local_album(durations=[180, 180, 180, 180, None])
        self.assertIn(
            ReasonCode.DURATION_COVERAGE,
            {reason.code for reason in match_candidates(below, [candidate_for(below)]).evaluations[0].reasons},
        )
        self.assertIsNotNone(match_candidates(at_boundary, [candidate_for(at_boundary)]).selected)

        for delta, accepted in ((2.99, True), (3.0, True), (3.01, False)):
            candidate = candidate_for(at_boundary, durations=[180 + delta, 180, 180, 180, None])
            result = match_candidates(at_boundary, [candidate])
            self.assertEqual(result.selected is not None, accepted, delta)
            if not accepted:
                self.assertIn(ReasonCode.DURATION_MISMATCH, {r.code for r in result.evaluations[0].reasons})

    def test_multidisc_ordering_and_disc_boundary_are_required(self):
        album = local_album(count=4)
        # Use a fresh task to model a real second disc rather than altering a snapshot.
        album = normalize_album(Task([
            Item(album="Album", albumartist="Artist", title="Track 1", artist="Artist", disc=1, track=1, length=180),
            Item(album="Album", albumartist="Artist", title="Track 2", artist="Artist", disc=1, track=2, length=180),
            Item(album="Album", albumartist="Artist", title="Track 3", artist="Artist", disc=2, track=1, length=180),
            Item(album="Album", albumartist="Artist", title="Track 4", artist="Artist", disc=2, track=2, length=180),
        ]))
        exact = candidate_for(album)
        wrong_boundary = candidate_for(
            album, identifier="wrong", tracks=tuple(
                CandidateTrack(1, index, track.title, track.artists, track.duration_seconds)
                for index, track in enumerate(album.tracks, start=1)
            )
        )

        self.assertIs(match_candidates(album, [exact]).selected, exact)
        mismatch = match_candidates(album, [wrong_boundary])
        self.assertIn(ReasonCode.DISC_STRUCTURE_MISMATCH, {r.code for r in mismatch.evaluations[0].reasons})

    def test_various_artists_requires_per_track_credits_and_preserves_non_ascii(self):
        album = normalize_album(Task([
            Item(album="世界", albumartist="Various Artists", title="Árbol", artist="Björk feat. ROSALÍA", disc=1, track=1, length=180),
            Item(album="世界", albumartist="Various Artists", title="東京", artist="東京事変", disc=1, track=2, length=180),
        ]))
        exact = candidate_for(album, artists=("Various Artists",))
        bad_tracks = list(exact.tracks)
        bad_tracks[1] = CandidateTrack(1, 2, "東京", ("Different Artist",), 180)
        wrong_credit = candidate_for(album, identifier="wrong", artists=("Various Artists",), tracks=tuple(bad_tracks))

        self.assertIs(match_candidates(album, [exact]).selected, exact)
        result = match_candidates(album, [wrong_credit])
        self.assertIn(ReasonCode.VARIOUS_ARTISTS_CREDIT_MISMATCH, {r.code for r in result.evaluations[0].reasons})

    def test_edition_markers_and_physical_media_refuse_automatic_selection(self):
        original = local_album(title="Album (Original Version)")
        original_result = match_candidates(original, [candidate_for(original, title="Album")])
        self.assertIn(ReasonCode.ALBUM_TITLE_MISMATCH, {reason.code for reason in original_result.evaluations[0].reasons})

        variants = ("Deluxe", "Remastered", "Expanded", "Clean", "Explicit", "Japanese Edition", "Bonus Tracks")
        for variant in variants:
            with self.subTest(variant=variant):
                album = local_album(title=f"Album ({variant})")
                original = candidate_for(album, title="Album")
                result = match_candidates(album, [original])
                self.assertIn(ReasonCode.EDITION_CONFLICT, {r.code for r in result.evaluations[0].reasons})

        physical = local_album(media="Vinyl")
        result = match_candidates(physical, [candidate_for(physical)])
        self.assertIn(ReasonCode.PHYSICAL_MEDIUM, {r.code for r in result.evaluations[0].reasons})

        for medium in ("SACD", "HDCD"):
            with self.subTest(medium=medium):
                physical = local_album(media=medium)
                result = match_candidates(physical, [candidate_for(physical)])
                self.assertIn(ReasonCode.PHYSICAL_MEDIUM, {r.code for r in result.evaluations[0].reasons})

        digital = local_album()
        for medium in ("physical", "SACD", "HDCD"):
            with self.subTest(candidate_medium=medium):
                physical_candidate = candidate_for(digital, medium_hints=frozenset({medium}))
                result = match_candidates(digital, [physical_candidate])
                self.assertIn(ReasonCode.MEDIUM_CONFLICT, {r.code for r in result.evaluations[0].reasons})

    def test_spotify_unavailable_or_relinked_tracks_require_confirmation(self):
        album = local_album(count=1)
        artist = SpotifyArtist("artist", "Artist")
        for available, linked_from_id in ((False, None), (True, "original")):
            with self.subTest(available=available, linked_from_id=linked_from_id):
                spotify = SpotifyAlbum(
                    "spotify", "Album", (artist,), None, "album", 1,
                    (SpotifyTrack("track", "Track 1", (artist,), 1, 1, 180000,
                                  available=available, linked_from_id=linked_from_id),),
                )
                result = match_candidates(album, [spotify])
                self.assertIsNone(result.selected)
                self.assertIn(ReasonCode.UNAVAILABLE_OR_RELINKED_TRACK, {r.code for r in result.evaluations[0].reasons})

    def test_generic_ineligible_provider_track_requires_confirmation(self):
        album = local_album(count=1)
        candidate = candidate_for(
            album,
            tracks=(CandidateTrack(
                1, 1, "Track 1", ("Artist",), 180.0,
                automatic_match_eligible=False,
                automatic_match_reason=AutomaticMatchIneligibility.PROVIDER_RESTRICTION,
            ),),
        )

        result = match_candidates(album, [candidate])

        self.assertIsNone(result.selected)
        self.assertIn(ReasonCode.UNAVAILABLE_OR_RELINKED_TRACK, {r.code for r in result.evaluations[0].reasons})

    def test_conflicting_source_metadata_cannot_establish_an_exact_match(self):
        album = normalize_album(Task([
            Item(album="Album", albumartist="Artist", title="Track 1", artist="Artist", disc=1, track=1, length=180),
            Item(album="Album", albumartist="Other", title="Track 2", artist="Artist", disc=1, track=2, length=180),
        ]))
        result = match_candidates(album, [candidate_for(album)])
        self.assertIn(ReasonCode.SOURCE_METADATA_CONFLICT, {r.code for r in result.evaluations[0].reasons})

    def test_tied_candidates_are_ambiguous_and_sparse_path_input_is_refused(self):
        album = local_album()
        first = candidate_for(album, identifier="first")
        second = candidate_for(album, identifier="second")
        ambiguous = match_candidates(album, [first, second])
        self.assertIsNone(ambiguous.selected)
        self.assertTrue(ambiguous.is_ambiguous)

        sparse = normalize_album(Task([Item(title="Track", length=180)]))
        sparse_result = match_candidates(sparse, [candidate_for(sparse, artists=(), title="")])
        self.assertIn(ReasonCode.SPARSE_METADATA, {r.code for r in sparse_result.evaluations[0].reasons})

        path_derived = local_album(metadata_from_path=True)
        path_result = match_candidates(path_derived, [candidate_for(path_derived)])
        self.assertIn(ReasonCode.PATH_DERIVED_METADATA, {r.code for r in path_result.evaluations[0].reasons})

    def test_provider_shaped_dtos_satisfy_the_protocol_without_a_matching_import_cycle(self):
        class Artist:
            name = "Artist"

        class ProviderTrack:
            title = "Track 1"
            artists = (Artist(),)
            disc_number = 1
            track_number = 1
            duration = 180.0
            automatic_match_eligible = True
            automatic_match_reason = None

        class ProviderAlbum:
            id = "provider"
            title = "Album"
            artists = (Artist(),)
            tracks = (ProviderTrack(),)

        album = local_album(count=1)

        candidate = ProviderAlbum()
        self.assertIsInstance(ProviderTrack(), CandidateTrackProtocol)
        self.assertIsInstance(candidate, CandidateAlbumProtocol)
        self.assertIs(match_candidates(album, [candidate]).selected, candidate)
