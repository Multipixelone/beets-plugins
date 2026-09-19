import sys
from datetime import datetime, timezone
from email.utils import format_datetime
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from beetsplug.harmony.errors import CredentialsUnavailable, MalformedResponse, RateLimitExceeded, ServiceUnavailable
from beetsplug.harmony.spotify_api import SpotifyClient, parse_album_reference, redact_diagnostic


ALBUM_ID = "0123456789ABCDEFGHIJKL"


class Response:
    def __init__(self, status, payload=None, headers=None, json_error=False):
        self.status_code = status
        self.payload = payload
        self.headers = headers or {}
        self.json_error = json_error

    def json(self):
        if self.json_error:
            raise ValueError("bad JSON")
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


def token(value="token", expiry=3600):
    return Response(200, {"access_token": value, "expires_in": expiry})


def artist(name="Artist"):
    return [{"id": "artist-id", "name": name}]


def track(number=1):
    return {
        "id": "track-{0}".format(number),
        "name": "Track {0}".format(number),
        "artists": artist(),
        "disc_number": 1,
        "track_number": number,
        "duration_ms": 1000,
    }


def album(items=None, total=None):
    items = items if items is not None else []
    return {
        "id": ALBUM_ID,
        "name": "Album",
        "artists": artist(),
        "total_tracks": total if total is not None else len(items),
        "tracks": {"items": items, "total": total if total is not None else len(items)},
    }


class SpotifyClientTest(unittest.TestCase):
    def test_token_is_cached_and_search_is_bounded(self):
        session = Session([token(), Response(200, {"albums": {"items": [album()]}}), Response(200, {"albums": {"items": []}})])
        client = SpotifyClient(session, environ={"SPOTIFY_CLIENT_ID": "id", "SPOTIFY_CLIENT_SECRET": "secret"})
        self.assertEqual(1, len(client.search_albums("Album", limit=500)))
        client.search_albums("Other")
        self.assertEqual(3, len(session.calls))
        self.assertEqual(50, session.calls[1][2]["params"]["limit"])

    def test_missing_credentials_warns_once_and_fails_open(self):
        warnings = []
        client = SpotifyClient(Session([]), environ={}, warning=warnings.append)
        with self.assertRaises(CredentialsUnavailable):
            client.search_albums("Album")
        with self.assertRaises(CredentialsUnavailable):
            client.search_albums("Album")
        self.assertEqual(1, len(warnings))

    def test_401_refreshes_once(self):
        session = Session([token("old"), Response(401, {}), token("new"), Response(200, {"albums": {"items": []}})])
        client = SpotifyClient(session, environ={"SPOTIFY_CLIENT_ID": "id", "SPOTIFY_CLIENT_SECRET": "secret"})
        self.assertEqual((), client.search_albums("Album"))
        self.assertEqual("Bearer old", session.calls[1][2]["headers"]["Authorization"])
        self.assertEqual("Bearer new", session.calls[3][2]["headers"]["Authorization"])

    def test_429_honours_retry_after_once(self):
        sleeps = []
        session = Session([token(), Response(429, {}, {"Retry-After": "3"}), Response(200, {"albums": {"items": []}})])
        client = SpotifyClient(session, environ={"SPOTIFY_CLIENT_ID": "id", "SPOTIFY_CLIENT_SECRET": "secret"}, sleeper=sleeps.append)
        client.search_albums("Album")
        self.assertEqual([3.0], sleeps)

    def test_429_token_resource_repeated_and_oversized_waits_are_bounded(self):
        sleeps = []
        session = Session([Response(429, {}, {"Retry-After": "2"}), token(), Response(200, {"albums": {"items": []}})])
        client = SpotifyClient(session, environ={"SPOTIFY_CLIENT_ID": "id", "SPOTIFY_CLIENT_SECRET": "secret"}, sleeper=sleeps.append)
        client.search_albums("Album")
        self.assertEqual([2.0], sleeps)

        session = Session([token(), Response(429, {}, {"Retry-After": "1"}), Response(429, {}, {"Retry-After": "1"})])
        client = SpotifyClient(session, environ={"SPOTIFY_CLIENT_ID": "id", "SPOTIFY_CLIENT_SECRET": "secret"}, sleeper=lambda _seconds: None)
        with self.assertRaises(RateLimitExceeded):
            client.search_albums("Album")
        client = SpotifyClient(Session([token(), Response(429, {}, {"Retry-After": "61"})]), environ={"SPOTIFY_CLIENT_ID": "id", "SPOTIFY_CLIENT_SECRET": "secret"}, sleeper=lambda _seconds: self.fail("must not sleep"))
        with self.assertRaises(RateLimitExceeded):
            client.search_albums("Album")

    def test_http_date_retry_after_uses_the_injected_clock(self):
        retry_after = format_datetime(datetime.fromtimestamp(103, timezone.utc), usegmt=True)
        client = SpotifyClient(Session([]), clock=lambda: 100.0)

        self.assertEqual(3.0, client._retry_after(Response(429, {}, {"Retry-After": retry_after})))

    def test_album_track_pagination_and_relinked_track(self):
        first = track(1)
        first["linked_from"] = {"id": "original"}
        first["is_playable"] = False
        session = Session([token(), Response(200, album([first], total=2)), Response(200, {"items": [track(2)]})])
        client = SpotifyClient(session, environ={"SPOTIFY_CLIENT_ID": "id", "SPOTIFY_CLIENT_SECRET": "secret"})
        result = client.get_album(ALBUM_ID)
        self.assertEqual(2, result.track_count)
        self.assertFalse(result.tracks[0].available)
        self.assertEqual("original", result.tracks[0].linked_from_id)
        self.assertFalse(result.tracks[0].automatic_match_eligible)
        self.assertIsNotNone(result.tracks[0].automatic_match_reason)
        self.assertEqual(50, session.calls[2][2]["params"]["limit"])

    def test_optional_detail_enrichment_absorbs_forbidden_response(self):
        session = Session([token(), Response(200, album([track()], total=1)), Response(403, {})])
        client = SpotifyClient(session, environ={"SPOTIFY_CLIENT_ID": "id", "SPOTIFY_CLIENT_SECRET": "secret"})
        result = client.get_album(ALBUM_ID, enrich_track_details=True)
        self.assertIsNone(result.tracks[0].isrc)

    def test_declared_track_totals_and_pagination_bounds_are_validated(self):
        inconsistent = album([track()], total=1)
        inconsistent["total_tracks"] = 2
        client = SpotifyClient(Session([token(), Response(200, inconsistent)]), environ={"SPOTIFY_CLIENT_ID": "id", "SPOTIFY_CLIENT_SECRET": "secret"})
        with self.assertRaises(MalformedResponse):
            client.get_album(ALBUM_ID)

        overfull = album([track(1), track(2)], total=1)
        client = SpotifyClient(Session([token(), Response(200, overfull)]), environ={"SPOTIFY_CLIENT_ID": "id", "SPOTIFY_CLIENT_SECRET": "secret"})
        with self.assertRaises(MalformedResponse):
            client.get_album(ALBUM_ID)

        paged = album([], total=3)
        client = SpotifyClient(
            Session([token(), Response(200, paged), Response(200, {"items": [track(1)], "total": 3})]),
            environ={"SPOTIFY_CLIENT_ID": "id", "SPOTIFY_CLIENT_SECRET": "secret"}, max_track_pages=1,
        )
        with self.assertRaises(MalformedResponse):
            client.get_album(ALBUM_ID)

    def test_timeout_and_malformed_json_are_nonfatal_typed_errors(self):
        client = SpotifyClient(Session([TimeoutError()]), environ={"SPOTIFY_CLIENT_ID": "id", "SPOTIFY_CLIENT_SECRET": "secret"})
        with self.assertRaises(ServiceUnavailable):
            client.search_albums("Album")
        client = SpotifyClient(Session([token(), Response(200, json_error=True)]), environ={"SPOTIFY_CLIENT_ID": "id", "SPOTIFY_CLIENT_SECRET": "secret"})
        with self.assertRaises(MalformedResponse):
            client.search_albums("Album")

    def test_exact_reference_parsing_and_redaction(self):
        self.assertEqual(ALBUM_ID, parse_album_reference("https://open.spotify.com/album/{0}?si=x".format(ALBUM_ID)))
        self.assertEqual(ALBUM_ID, parse_album_reference("spotify:album:" + ALBUM_ID))
        with self.assertRaises(Exception):
            parse_album_reference("https://example.test/album/" + ALBUM_ID)
        diagnostic = redact_diagnostic("Authorization: Bearer abc client_secret=top-secret")
        self.assertNotIn("abc", diagnostic)
        self.assertNotIn("top-secret", diagnostic)
        structured = redact_diagnostic({"status": 401, "Authorization": "Basic abc", "token": "secret"})
        self.assertIn("status=401", structured)
        self.assertNotIn("abc", structured)
        self.assertNotIn("secret", structured)
