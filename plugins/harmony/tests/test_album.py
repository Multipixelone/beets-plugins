from __future__ import annotations

from dataclasses import FrozenInstanceError
import unittest

from beetsplug.harmony.album import normalize_album, normalized_credit, title_identity_key


class Item:
    def __init__(self, **fields):
        self.__dict__.update(fields)


class Task:
    def __init__(self, items, **fields):
        self.items = items
        self.__dict__.update(fields)


class AlbumNormalizationTest(unittest.TestCase):
    def test_snapshot_is_immutable_unicode_safe_and_does_not_change_items(self):
        first = Item(
            album="Beyoncé: Déjà Vu (Deluxe Edition)",
            albumartist="Beyoncé feat. JAY-Z",
            title="Déjà Vu", artist="Beyoncé featuring JAY-Z",
            disc="1", track="2/12", length="3:59", path=b"/music/deja.flac",
            media="Digital Media", year="2006-09-04",
        )
        second = Item(title="Suga Mama", artist="Beyoncé", disc=1, track=1, length=206.0)
        album = normalize_album(Task([first, second]))

        self.assertEqual(album.title_key, "beyonce deja vu")
        self.assertEqual(album.album_artist_key, ("beyonce", "jay z"))
        self.assertEqual([track.title for track in album.tracks], ["Suga Mama", "Déjà Vu"])
        self.assertEqual(album.tracks[1].duration_seconds, 239.0)
        self.assertEqual(album.tracks[1].source_path, "/music/deja.flac")
        self.assertEqual(album.edition_markers, frozenset({"deluxe"}))
        self.assertEqual(first.track, "2/12")
        with self.assertRaises(FrozenInstanceError):
            album.title = "changed"  # type: ignore[misc]

    def test_malformed_and_missing_values_become_absent_evidence(self):
        album = normalize_album(Task([Item(title=None, disc="x", track="?", length="nope")]))

        self.assertTrue(album.is_sparse)
        self.assertEqual(album.duration_coverage, 0.0)
        self.assertIsNone(album.tracks[0].disc_number)
        self.assertIsNone(album.tracks[0].track_number)
        self.assertIsNone(album.tracks[0].duration_seconds)

    def test_various_artists_and_path_provenance_are_retained(self):
        album = normalize_album(
            Task(
                [Item(album="Compilation", albumartist="Various Artists", title="Å", artist="東京事変", length=180)],
                metadata_from_path=True,
            )
        )

        self.assertTrue(album.is_various_artists)
        self.assertTrue(album.path_derived)
        self.assertTrue(album.is_sparse)
        self.assertEqual(album.tracks[0].artist_keys, ("東京事変",))

    def test_featured_credit_formats_normalize_to_the_same_credit(self):
        self.assertEqual(
            normalized_credit("Björk feat. ROSALÍA"),
            normalized_credit(["Björk", "ROSALÍA"]),
        )

    def test_conflicting_album_fields_and_lp_are_retained_as_evidence(self):
        album = normalize_album(Task([
            Item(album="Album (Original)", albumartist="Artist", title="One", artist="Artist", track=1, length=180, media="LP"),
            Item(album="Album", albumartist="Other Artist", title="Two", artist="Artist", track=2, length=180, media="LP"),
        ]))

        self.assertEqual("album original", album.title_key)
        self.assertEqual(frozenset({"album_artist", "album_title"}), album.conflicting_fields)
        self.assertIn("physical", album.medium_hints)

    def test_physical_medium_aliases_are_retained(self):
        for medium in ("LP", "SACD", "HDCD"):
            with self.subTest(medium=medium):
                album = normalize_album(Task([
                    Item(album="Album", albumartist="Artist", title="Track", artist="Artist", track=1, length=180, media=medium),
                ]))
                self.assertIn("physical", album.medium_hints)

    def test_title_identity_preserves_original_but_normalizes_harmless_spelling(self):
        self.assertEqual("album original version", title_identity_key("Album (Original Version)"))
        self.assertNotEqual(title_identity_key("Album (Original Version)"), title_identity_key("Album"))
        self.assertEqual("album", title_identity_key("Álbum: Deluxe Edition"))
