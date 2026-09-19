import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from beetsplug.harmony.errors import DeadlineExceeded, LookupAmbiguous, MalformedResponse, ServiceUnavailable
from beetsplug.harmony.musicbrainz import MusicBrainzClient, canonical_spotify_url

ALBUM_ID = "0123456789ABCDEFGHIJKL"
SPOTIFY_URL = "https://open.spotify.com/album/" + ALBUM_ID


class Response:
    def __init__(self, status, payload=None, json_error=False):
        self.status_code = status
        self.payload = payload
        self.json_error = json_error

    def json(self):
        if self.json_error:
            raise ValueError("bad")
        return self.payload


class Session:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response


def related(*ids):
    return {"relations": [{"release": {"id": value}} for value in ids]}


def release(mbid, title="Release", url=SPOTIFY_URL):
    return {"id": mbid, "title": title, "artist-credit": [{"name": "Artist"}], "relations": [{"url": {"resource": url}}]}


class Clock:
    def __init__(self):
        self.value = 0.0
        self.sleeps = []

    def __call__(self):
        return self.value

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.value += seconds


class TimedSession(Session):
    def __init__(self, responses, clock, advance):
        super().__init__(responses)
        self.clock = clock
        self.advance = advance

    def request(self, method, url, **kwargs):
        response = super().request(method, url, **kwargs)
        self.clock.value += self.advance
        return response


class MusicBrainzClientTest(unittest.TestCase):
    def test_exact_url_lookup_fetches_and_validates_one_release(self):
        session = Session([Response(200, related("one")), Response(200, release("one"))])
        client = MusicBrainzClient(session, min_interval=0)
        found = client.find_linked_release("spotify:album:" + ALBUM_ID, lambda item: item.title == "Release")
        self.assertEqual("one", found.id)
        self.assertEqual(SPOTIFY_URL, session.calls[0][2]["params"]["resource"])
        self.assertIn("User-Agent", session.calls[0][2]["headers"])

    def test_multiple_or_no_validated_related_releases_are_not_selected(self):
        session = Session([Response(200, related("one", "two")), Response(200, release("one")), Response(200, release("two"))])
        client = MusicBrainzClient(session, min_interval=0)
        with self.assertRaises(LookupAmbiguous):
            client.find_linked_release(SPOTIFY_URL, lambda _item: True)
        session = Session([Response(200, related("one")), Response(200, release("one", "wrong"))])
        client = MusicBrainzClient(session, min_interval=0)
        self.assertIsNone(client.find_linked_release(SPOTIFY_URL, lambda item: item.title == "Release"))

    def test_real_relationship_shape_deduplicates_and_404_is_only_url_absence(self):
        payload = {
            "relations": [
                {"release": {"id": "one"}},
                {"release": {"id": "one"}},
                {"url": {"id": "unrelated"}},
            ]
        }
        client = MusicBrainzClient(Session([Response(200, payload)]), min_interval=0)
        self.assertEqual(("one",), client.related_release_ids(SPOTIFY_URL))
        client = MusicBrainzClient(Session([Response(404, {})]), min_interval=0)
        self.assertEqual((), client.related_release_ids(SPOTIFY_URL))
        with self.assertRaises(ServiceUnavailable):
            MusicBrainzClient(Session([Response(404, {})]), min_interval=0).get_release("one")

    def test_deadline_covers_rate_wait_network_and_all_candidate_hydration(self):
        clock = Clock()
        client = MusicBrainzClient(Session([Response(200, related()), Response(200, related())]), clock=clock, sleeper=clock.sleep, min_interval=1)
        client.related_release_ids(SPOTIFY_URL)
        with self.assertRaises(DeadlineExceeded):
            client.related_release_ids(SPOTIFY_URL, deadline=0.5)
        self.assertEqual(1, len(client._session.calls))

        clock = Clock()
        session = TimedSession([Response(200, related("one", "two")), Response(200, release("one"))], clock, 1.0)
        client = MusicBrainzClient(session, clock=clock, sleeper=clock.sleep, min_interval=0)
        with self.assertRaises(DeadlineExceeded):
            client.find_linked_release(SPOTIFY_URL, lambda _item: True, deadline=1.5)
        self.assertEqual(2, len(session.calls))

    def test_artist_credit_joinphrases_are_preserved(self):
        payload = release("one")
        payload["artist-credit"] = [
            {"name": "Artist A", "joinphrase": " & "},
            {"name": "Artist B", "joinphrase": " feat. "},
            {"name": "Artist C"},
        ]
        client = MusicBrainzClient(Session([Response(200, payload)]), min_interval=0)
        self.assertEqual("Artist A & Artist B feat. Artist C", client.get_release("one").artist)

    def test_poll_uses_absolute_offsets_and_stops_at_deadline(self):
        clock = Clock()
        session = Session([Response(200, related()), Response(200, related("one")), Response(200, release("one"))])
        client = MusicBrainzClient(session, clock=clock, sleeper=clock.sleep, min_interval=0)
        found = client.poll_for_submitted_release(SPOTIFY_URL, lambda _item: True, poll_timeout=5)
        self.assertEqual("one", found.id)
        self.assertEqual([2.0], clock.sleeps)
        session = Session([])
        client = MusicBrainzClient(session, clock=Clock(), sleeper=lambda _value: None, min_interval=0)
        self.assertIsNone(client.poll_for_submitted_release(SPOTIFY_URL, lambda _item: True, poll_timeout=0))
        self.assertEqual([], session.calls)

    def test_rate_spacing_and_protocol_errors(self):
        clock = Clock()
        session = Session([Response(200, related()), Response(200, related())])
        client = MusicBrainzClient(session, clock=clock, sleeper=clock.sleep, min_interval=1)
        client.related_release_ids(SPOTIFY_URL)
        client.related_release_ids(SPOTIFY_URL)
        self.assertEqual([1.0], clock.sleeps)
        with self.assertRaises(ServiceUnavailable):
            MusicBrainzClient(Session([Response(503, {})]), min_interval=0).related_release_ids(SPOTIFY_URL)
        with self.assertRaises(MalformedResponse):
            MusicBrainzClient(Session([Response(200, {"relations": "bad"})]), min_interval=0).related_release_ids(SPOTIFY_URL)

    def test_indexed_results_are_returned_for_validation_not_rank_selected(self):
        session = Session([Response(200, {"count": 2, "offset": 0, "releases": [{"id": "first"}, {"id": "second"}]}), Response(200, release("first", "wrong")), Response(200, release("second", "right"))])
        client = MusicBrainzClient(session, min_interval=0)
        candidates = client.search_indexed_releases(barcode="123", artist="Artist", title="Title")
        valid = client.validated_indexed_releases(candidates, lambda item: item.title == "right")
        self.assertEqual(["first", "second"], [item.id for item in candidates])
        self.assertEqual(["second"], [item.id for item in valid])

    def test_indexed_search_deadline_prevents_partial_hydration(self):
        clock = Clock()
        session = TimedSession(
            [
                Response(200, {"count": 2, "offset": 0, "releases": [{"id": "first"}, {"id": "second"}]}),
                Response(200, release("first")),
            ],
            clock,
            0.6,
        )
        client = MusicBrainzClient(session, clock=clock, sleeper=clock.sleep, min_interval=0)

        with self.assertRaises(DeadlineExceeded):
            client.search_indexed_releases(barcode="123", deadline=1.0)

        self.assertEqual(2, len(session.calls))
        self.assertEqual(0.4, session.calls[1][2]["timeout"])

    def test_indexed_search_deadline_stops_before_rate_limited_hydration(self):
        clock = Clock()
        session = Session([Response(200, {"count": 1, "offset": 0, "releases": [{"id": "first"}]})])
        client = MusicBrainzClient(session, clock=clock, sleeper=clock.sleep, min_interval=1)

        with self.assertRaises(DeadlineExceeded):
            client.search_indexed_releases(barcode="123", deadline=0.5)

        self.assertEqual(1, len(session.calls))

    def test_incomplete_indexed_result_set_cannot_establish_uniqueness(self):
        session = Session([Response(200, {"count": 2, "offset": 0, "releases": [{"id": "first"}]})])
        client = MusicBrainzClient(session, min_interval=0)

        with self.assertRaises(LookupAmbiguous):
            client.search_indexed_releases(barcode="123")

        self.assertEqual(1, len(session.calls))

    def test_indeterminate_indexed_result_envelope_cannot_establish_uniqueness(self):
        for payload in (
            {"offset": 0, "releases": [{"id": "first"}]},
            {"count": 1, "releases": [{"id": "first"}]},
            {"count": 1, "offset": 1, "releases": [{"id": "first"}]},
        ):
            with self.subTest(payload=payload):
                session = Session([Response(200, payload)])
                client = MusicBrainzClient(session, min_interval=0)
                with self.assertRaises(LookupAmbiguous):
                    client.search_indexed_releases(barcode="123")
                self.assertEqual(1, len(session.calls))

    def test_deadline_bounds_requests_without_expanding_configured_timeout(self):
        clock = Clock()
        session = Session([Response(200, related()), Response(200, related())])
        client = MusicBrainzClient(session, clock=clock, sleeper=clock.sleep, timeout=5, min_interval=1)

        client.related_release_ids(SPOTIFY_URL, deadline=10)
        client.related_release_ids(SPOTIFY_URL, deadline=4)

        self.assertEqual(5, session.calls[0][2]["timeout"])
        self.assertEqual(3, session.calls[1][2]["timeout"])

    def test_canonical_spotify_variants_and_malformed_response(self):
        self.assertEqual(SPOTIFY_URL, canonical_spotify_url("https://open.spotify.com/album/{0}?si=x".format(ALBUM_ID)))
        with self.assertRaises(MalformedResponse):
            MusicBrainzClient(Session([Response(200, json_error=True)]), min_interval=0).related_release_ids(SPOTIFY_URL)
