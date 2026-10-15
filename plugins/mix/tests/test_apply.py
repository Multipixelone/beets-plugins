"""Pure API tests against the fixed validating-client seams, no PlexAPI/IO."""

from collections import Counter
import copy
import json
from types import SimpleNamespace
import traceback
import unittest

from beets_mix import ApplyResult, apply
from beets_mix.plex import PlexError


SECRET = "sentinel-private-transport-response-token"


def identities():
    return [{"id": i, "plex_ratingkey": str(i * 10)} for i in range(1, 5)]


class FakeClient:
    """Validates through errors; transport-specific object checks have own tests."""

    def __init__(self, present=()):
        self.title, self.key, self.server = "Target", "500", object()
        self.keys = list(present)
        self.events = []
        self.failures = {}
        self.playlist_error = self.append_error = self.post_error = None
        self.initial_override = self.post_override = None
        self.concurrent = []
        self.partial = False
        self.return_none = set()
        self.append_hook = None

    def snapshot(self):
        return SimpleNamespace(title=self.title, plex_ratingkey=self.key,
            entries=tuple({"plex_ratingkey": key, "title": "entry"} for key in self.keys), _handle=object())

    def playlist(self, title):
        self.events.append(("playlist", title))
        if self.playlist_error:
            raise self.playlist_error
        if title != self.title:
            raise PlexError("playlist_not_found")
        return self.initial_override or self.snapshot()

    def track(self, key):
        self.events.append(("track", key))
        if key in self.failures:
            raise self.failures[key]
        if key in self.return_none:
            return None
        return SimpleNamespace(ratingKey=key, type="track", listType="audio", _server=self.server)

    def append(self, snapshot, tracks):
        self.events.append(("append", tuple(track.ratingKey for track in tracks)))
        if self.append_hook:
            self.append_hook(snapshot, tracks)
        if self.append_error:
            raise self.append_error
        self.keys.extend(track.ratingKey for track in (tracks[:1] if self.partial else tracks))
        self.keys.extend(self.concurrent)

    def playlist_by_key(self, key, *, expected_title):
        self.events.append(("playlist_by_key", key, expected_title))
        if self.post_error:
            raise self.post_error
        if key != self.key or expected_title != self.title:
            raise PlexError("invalid_playlist")
        return self.post_override or self.snapshot()


class Apply(unittest.TestCase):
    def assert_safe(self, error):
        self.assertNotIn(SECRET, str(error))
        self.assertNotIn(SECRET, "".join(traceback.format_exception(error)))
        self.assertTrue(error.__suppress_context__)

    def test_logical_validation_precedes_all_client_io(self):
        cases = [(identities(), []), (identities(), [True]), (identities(), [0]), (identities(), [-1]),
                 (identities(), [1.]), (identities(), ["1"]), (None, [1]),
                 ([{"id": 1}], [1]), ([{"id": True, "plex_ratingkey": "10"}], [1]),
                 ([{"id": 0, "plex_ratingkey": None}], [1]),
                 ([{"id": 1, "plex_ratingkey": "10"}, {"id": 1, "plex_ratingkey": "20"}], [1])]
        for rows, ids in cases:
            client = FakeClient()
            with self.subTest(rows=rows, ids=ids), self.assertRaises(ValueError):
                apply(rows, ids, client=client, plex_playlist="Target")
            self.assertEqual(client.events, [])
        for title in (None, "", "  ", True, "bad\x00title"):
            client = FakeClient()
            with self.assertRaises(ValueError):
                apply(identities(), [1], client=client, plex_playlist=title)
            self.assertEqual(client.events, [])

    def test_ordered_dedup_once_append_owned_inputs_and_result(self):
        rows = identities()
        rows[0]["plex_ratingkey"] = "0010"
        rows[0]["ignored_history"] = {"invalid": "not an engine snapshot"}
        original = copy.deepcopy(rows)
        ids = [3, 2, 3, 1, 2]
        client = FakeClient()
        result = apply(rows, ids, client=client, plex_playlist="Target")
        self.assertIsInstance(result, ApplyResult)
        data = result.to_dict()
        self.assertEqual(set(data), {"schema", "playlist", "plex_ratingkey", "added", "already_present", "refused", "playlist_tracks_after"})
        self.assertEqual(data, {"schema": "beets-mix.apply.v1", "playlist": "Target", "plex_ratingkey": "500",
                               "added": [3, 2, 1], "already_present": [], "refused": [], "playlist_tracks_after": 3})
        self.assertEqual(client.events, [("playlist", "Target"), ("track", "30"), ("track", "20"), ("track", "10"),
                                         ("append", ("30", "20", "10")), ("playlist_by_key", "500", "Target")])
        self.assertEqual(rows, original)
        self.assertEqual(ids, [3, 2, 3, 1, 2])
        rows[0]["plex_ratingkey"] = "changed"
        data["added"].append(999)
        self.assertEqual(result.to_dict()["added"], [3, 2, 1])
        json.dumps(result.to_dict(), allow_nan=False)

    def test_initial_target_refusals_and_malformed_entries_write_nothing(self):
        for code in ("playlist_not_found", "playlist_ambiguous", "smart_playlist", "wrong_playlist_type", "wrong_server"):
            client = FakeClient()
            client.playlist_error = PlexError(code)
            with self.subTest(code=code), self.assertRaises(PlexError) as raised:
                apply(identities(), [1], client=client, plex_playlist="Target")
            self.assertEqual(raised.exception.code, code)
            self.assertEqual(client.events, [("playlist", "Target")])
        for title, key, entries in (("Wrong", "500", ()), ("Target", None, ()),
                                     ("Target", "500", ({"plex_ratingkey": None},)),
                                     ("Target", "500", ({"plex_ratingkey": "/path"},)),
                                     ("Target", "500", (None,)), ("Target", "500", "not entries")):
            client = FakeClient()
            client.initial_override = SimpleNamespace(title=title, plex_ratingkey=key, entries=entries)
            with self.assertRaises(PlexError) as raised:
                apply(identities(), [1], client=client, plex_playlist="Target")
            self.assertEqual(raised.exception.code, "invalid_playlist")
            self.assertEqual(client.events, [("playlist", "Target")])

    def test_global_collisions_missing_unlinked_and_noop(self):
        rows = [{"id": 1, "plex_ratingkey": "010"}, {"id": 2, "plex_ratingkey": "10"},
                {"id": 3, "plex_ratingkey": "0"}, {"id": 4, "plex_ratingkey": "/library/metadata/4"},
                {"id": 5, "plex_ratingkey": -1}, {"id": 6, "plex_ratingkey": True},
                {"id": 7, "plex_ratingkey": "bad"}, {"id": 8, "plex_ratingkey": None}]
        client = FakeClient(["10", "10"])
        data = apply(rows, [1, 99, 3, 4, 5, 6, 7, 8], client=client, plex_playlist="Target").to_dict()
        self.assertEqual(data["refused"], [{"item_id": 1, "reason": "ambiguous_plex_link"},
            {"item_id": 99, "reason": "item_not_found"}] +
            [{"item_id": i, "reason": "not_plex_linked"} for i in range(3, 9)])
        self.assertEqual(data["playlist_tracks_after"], 2)
        self.assertEqual(data["added"], [])
        self.assertEqual(client.events, [("playlist", "Target")])
        client = FakeClient(["10", "10", "20"])
        data = apply(identities(), [2, 1, 2], client=client, plex_playlist="Target").to_dict()
        self.assertEqual(data["already_present"], [2, 1])
        self.assertEqual(data["playlist_tracks_after"], 3)
        self.assertEqual(client.events, [("playlist", "Target")])

    def test_all_fetches_precede_write_and_refusals_do_not_abort_valid_ids(self):
        for failure, reason in ((PlexError("wrong_server"), "wrong_server"),
                                (PlexError("wrong_media_type"), "wrong_media_type"),
                                (PlexError("track_identity_mismatch"), "track_identity_mismatch"),
                                (RuntimeError(SECRET), "plex_track_unavailable"),
                                (PlexError("read_failed"), "plex_track_unavailable")):
            client = FakeClient()
            client.failures["20"] = failure
            data = apply(identities(), [1, 2, 3], client=client, plex_playlist="Target").to_dict()
            self.assertEqual(data["added"], [1, 3])
            self.assertEqual(data["refused"], [{"item_id": 2, "reason": reason}])
            self.assertEqual(client.events[1:5], [("track", "10"), ("track", "20"), ("track", "30"), ("append", ("10", "30"))])
            self.assertNotIn(SECRET, json.dumps(data))
        client = FakeClient()
        client.return_none = {"10"}
        data = apply(identities(), [1], client=client, plex_playlist="Target").to_dict()
        self.assertEqual(data["refused"], [{"item_id": 1, "reason": "plex_track_unavailable"}])
        self.assertFalse(any(event[0] == "append" for event in client.events))

    def test_repeat_skips_fresh_keys_and_by_key_read_observes_actual_count(self):
        client = FakeClient(["40", "40"])
        client.concurrent = ["900", "901"]
        data = apply(identities(), [2, 1], client=client, plex_playlist="Target").to_dict()
        self.assertEqual(data["playlist_tracks_after"], 6)
        self.assertEqual(data["added"], [2, 1])
        repeat = apply(identities(), [2, 1], client=client, plex_playlist="Target").to_dict()
        self.assertEqual(repeat["already_present"], [2, 1])
        self.assertEqual(repeat["added"], [])
        self.assertEqual(Counter(event[0] for event in client.events), {"playlist": 2, "track": 2, "append": 1, "playlist_by_key": 1})
        self.assertEqual(client.events[-1], ("playlist", "Target"))

    def test_write_and_postread_failures_and_interruptions_are_unknown_without_retry(self):
        for boundary in ("append_error", "post_error"):
            for error in (RuntimeError(SECRET), PlexError("read_failed"), KeyboardInterrupt(), SystemExit(143)):
                client = FakeClient()
                setattr(client, boundary, error)
                if boundary == "append_error":
                    # A server may have mutated before a timeout/error arrives.
                    client.append_hook = lambda snapshot, tracks: client.keys.append(tracks[0].ratingKey)
                with self.subTest(boundary=boundary, error=type(error)), self.assertRaises(PlexError) as raised:
                    apply(identities(), [1, 2], client=client, plex_playlist="Target")
                self.assertEqual(raised.exception.code, "write_outcome_unknown")
                self.assert_safe(raised.exception)
                self.assertEqual(sum(event[0] == "append" for event in client.events), 1)
                self.assertLessEqual(sum(event[0] == "playlist_by_key" for event in client.events), 1)

    def test_partial_unchanged_wrong_key_and_wrong_title_observations_are_unknown(self):
        for variant in ("partial", "unchanged", "wrong_key", "wrong_title", "invalid_entry"):
            client = FakeClient(["40"])
            if variant == "partial":
                client.partial = True
            else:
                fresh = client.snapshot()
                if variant == "wrong_key":
                    fresh.plex_ratingkey = "501"
                elif variant == "wrong_title":
                    fresh.title = "Other"
                elif variant == "invalid_entry":
                    fresh.entries = ({"plex_ratingkey": None},)
                client.post_override = fresh
            with self.subTest(variant=variant), self.assertRaises(PlexError) as raised:
                apply(identities(), [1, 2], client=client, plex_playlist="Target")
            self.assertEqual(raised.exception.code, "write_outcome_unknown")
            self.assertEqual(sum(event[0] == "append" for event in client.events), 1)
            self.assertEqual(client.events[-1], ("playlist_by_key", "500", "Target"))

    def test_owned_initial_counters_not_cached_or_mutated_handle_entries(self):
        client = FakeClient(["40", "40"])
        def mutate_cached(snapshot, tracks):
            snapshot.entries = ({"plex_ratingkey": "10"},)  # Not a fresh observation.
        client.append_hook = mutate_cached
        data = apply(identities(), [1], client=client, plex_playlist="Target").to_dict()
        self.assertEqual(data["added"], [1])
        self.assertEqual(data["playlist_tracks_after"], 3)
        self.assertEqual(client.events[-1], ("playlist_by_key", "500", "Target"))

    def test_initial_untrusted_exception_strings_are_sanitized(self):
        for error in (RuntimeError(SECRET), PlexError("playlist_ambiguous")):
            if isinstance(error, PlexError):
                error.args = (SECRET,)
            client = FakeClient()
            client.playlist_error = error
            with self.assertRaises(PlexError) as raised:
                apply(identities(), [1], client=client, plex_playlist="Target")
            self.assert_safe(raised.exception)
            self.assertEqual(client.events, [("playlist", "Target")])


if __name__ == "__main__":
    unittest.main()
