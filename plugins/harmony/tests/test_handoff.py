import base64
import io
import sys
from pathlib import Path
import unittest
from urllib.parse import parse_qsl, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from beetsplug.harmony.handoff import TerminalHandoff, canonical_harmony_url
from beetsplug.harmony.errors import InvalidReference

ALBUM_ID = "0123456789ABCDEFGHIJKL"
SPOTIFY_URL = "https://open.spotify.com/album/" + ALBUM_ID


class FakeSegno:
    def __init__(self, fail=False):
        self.urls = []
        self.fail = fail

    def make(self, url):
        self.urls.append(url)
        if self.fail:
            raise RuntimeError("no terminal")
        return self

    def terminal(self, **_kwargs):
        return None


class HandoffTest(unittest.TestCase):
    def test_release_url_requests_default_provider_category(self):
        handoff_url = canonical_harmony_url(SPOTIFY_URL)
        parsed = urlsplit(handoff_url)

        self.assertEqual("https", parsed.scheme)
        self.assertEqual("harmony.pulsewidth.org.uk", parsed.netloc)
        self.assertEqual("/release", parsed.path)
        self.assertEqual(
            [("url", SPOTIFY_URL), ("region", "US"), ("category", "default")],
            parse_qsl(parsed.query),
        )

    def test_visible_url_osc_bytes_and_qr_use_the_same_canonical_url(self):
        output = io.StringIO()
        bytes_output = io.BytesIO()
        qr = FakeSegno()
        result = TerminalHandoff(output, byte_output=bytes_output, is_tty=lambda: True, environ={"TERM": "xterm"}, segno_module=qr).present(SPOTIFY_URL)
        expected = canonical_harmony_url(SPOTIFY_URL)
        self.assertEqual(expected + "\n", output.getvalue())
        self.assertEqual(expected, qr.urls[0])
        self.assertTrue(result.osc52_emitted)
        self.assertEqual(b"\x1b]52;c;" + base64.b64encode(expected.encode()) + b"\x07", bytes_output.getvalue())

    def test_disabled_redirected_and_dumb_terminal_paths_remain_plain_and_safe(self):
        for is_tty, environ in ((False, {"TERM": "xterm"}), (True, {"TERM": "dumb"})):
            output = io.StringIO()
            result = TerminalHandoff(output, is_tty=lambda: is_tty, environ=environ, segno_module=FakeSegno()).present(SPOTIFY_URL)
            self.assertIn("https://harmony.pulsewidth.org.uk/", output.getvalue())
            self.assertFalse(result.osc52_emitted)
            self.assertFalse(result.qr_rendered)
        output = io.StringIO()
        result = TerminalHandoff(output, is_tty=lambda: True, environ={"TERM": "xterm"}).present(SPOTIFY_URL, osc52=False, qr=False)
        self.assertFalse(result.osc52_emitted)

    def test_qr_and_osc_failures_do_not_hide_the_url(self):
        output = io.StringIO()
        warnings = []
        result = TerminalHandoff(output, byte_output=object(), is_tty=lambda: True, environ={"TERM": "xterm"}, warning=warnings.append, segno_module=FakeSegno(fail=True)).present(SPOTIFY_URL)
        self.assertIn(canonical_harmony_url(SPOTIFY_URL), output.getvalue())
        self.assertEqual(2, len(result.warnings))
        self.assertEqual(result.warnings, tuple(warnings))

    def test_url_is_encoded_once(self):
        already_encoded = "https%3A%2F%2Fopen.spotify.com%2Falbum%2F" + ALBUM_ID
        result = canonical_harmony_url(already_encoded)
        self.assertIn("url=https%3A%2F%2Fopen.spotify.com%2Falbum%2F", result)
        self.assertNotIn("%253A", result)

    def test_handoff_rejects_non_album_references(self):
        with self.assertRaises(InvalidReference):
            canonical_harmony_url("https://open.spotify.com/track/0123456789ABCDEFGHIJKL")
