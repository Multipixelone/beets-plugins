"""Synthetic PlexAPI/transport tests: never open a connection."""

from dataclasses import FrozenInstanceError
import runpy
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from beets_mix.plex import ControlledSession, PlexClient, PlexError, canonical_key


SECRET = "sentinel-token-host-response"


def track(server, **changes):
    return SimpleNamespace(**{**dict(_server=server, type="track", listType="audio",
        ratingKey="001", title="Song", playlistItemID="999"), **changes})


def playlist(server, **changes):
    return SimpleNamespace(**{**dict(_server=server, title="Mix", playlistType="audio",
        smart=False, ratingKey="007", items=Mock(return_value=[track(server)])), **changes})


class Keys(unittest.TestCase):
    def test_positive_canonical(self):
        for value, expected in [(1, "1"), ("000123", "123"), ("9" * 5000, "9" * 5000)]:
            self.assertEqual(canonical_key(value), expected)

    def test_near_canonical_rejected(self):
        for value in [None, True, False, 0, -1, 1.0, "", "000", "-1", "+1", " 1",
                      "1 ", "1.0", "١", "１", b"1", "/library/metadata/1", "1/2"]:
            with self.subTest(value=value):
                self.assertIsNone(canonical_key(value))


class Playlists(unittest.TestCase):
    def setUp(self):
        self.server = SimpleNamespace(playlists=Mock())
        self.p = playlist(self.server)
        self.server.playlists.return_value = [self.p]
        self.client = PlexClient(self.server)

    def assert_error(self, code):
        with self.assertRaises(PlexError) as caught:
            self.client.playlist("Mix")
        self.assertEqual(caught.exception.code, code)
        self.assertNotIn(SECRET, repr(caught.exception))

    def test_exact_local_filter_and_copies(self):
        self.server.playlists.return_value = [playlist(self.server, title="mix"),
            playlist(self.server, title="Mix extended"), self.p]
        result = self.client.playlist("Mix")
        self.server.playlists.assert_called_once_with(playlistType="audio", title="Mix")
        self.p.items.assert_called_once_with()
        self.assertEqual(result.entries, ({"plex_ratingkey": "1", "title": "Song"},))
        self.assertEqual(result.plex_ratingkey, "7")
        self.assertNotIn("_handle", repr(result))
        self.p.items.return_value[0].title = "changed"
        self.assertEqual(result.entries[0]["title"], "Song")
        with self.assertRaises(FrozenInstanceError):
            result.title = "changed"

    def test_fuzzy_only_not_found(self):
        self.p.title = "Mix extended"
        self.assert_error("playlist_not_found")

    def test_ambiguous_exact(self):
        self.server.playlists.return_value.append(playlist(self.server))
        self.assert_error("playlist_ambiguous")

    def test_strict_manual(self):
        for value in [True, None, 0, "false"]:
            self.p.smart = value
            self.assert_error("smart_playlist")
        self.p.items.assert_not_called()

    def test_wrong_type(self):
        self.p.playlistType = "video"
        self.assert_error("wrong_playlist_type")

    def test_invalid_playlist_key(self):
        self.p.ratingKey = "/playlists/7"
        self.assert_error("invalid_playlist")

    def test_foreign_playlist_same_claimed_identifier(self):
        self.server.machineIdentifier = "same"
        self.p._server = SimpleNamespace(machineIdentifier="same")
        self.assert_error("wrong_server")

    def test_foreign_entry(self):
        self.p.items.return_value[0]._server = object()
        self.assert_error("wrong_server")

    def test_audio_track_required(self):
        for field, value in [("type", "album"), ("listType", "video")]:
            self.p.items.return_value = [track(self.server, **{field: value})]
            self.assert_error("wrong_media_type")

    def test_malformed_and_missing_entry_keys_retained(self):
        missing = track(self.server)
        del missing.ratingKey
        self.p.items.return_value = [track(self.server, ratingKey=True, title=None), missing]
        self.assertEqual(self.client.playlist("Mix").entries,
            ({"plex_ratingkey": None, "title": ""}, {"plex_ratingkey": None, "title": "Song"}))

    def test_reads_fail_safely(self):
        for method in [self.server.playlists, self.p.items]:
            method.side_effect = RuntimeError(SECRET)
            with self.assertRaises(PlexError) as caught:
                self.client.playlist("Mix")
            self.assertEqual(caught.exception.code, "read_failed")
            self.assertTrue(caught.exception.__suppress_context__)
            self.assertNotIn(SECRET, str(caught.exception))
            method.side_effect = None

    def test_each_resolution_reads_new_object_not_cached_snapshot(self):
        fresh = playlist(self.server, items=Mock(return_value=[track(self.server, ratingKey="2")]))
        self.server.playlists.side_effect = [[self.p], [fresh]]
        self.assertEqual(self.client.playlist("Mix").entries[0]["plex_ratingkey"], "1")
        self.assertEqual(self.client.playlist("Mix").entries[0]["plex_ratingkey"], "2")
        self.p.items.assert_called_once_with()
        fresh.items.assert_called_once_with()


class Transport(unittest.TestCase):
    def setUp(self):
        self.raw = Mock()
        self.raw.proxies = {}
        self.raw.request.return_value = SimpleNamespace(status_code=200)
        self.patch = patch("requests.Session", return_value=self.raw)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_read_policy(self):
        session = ControlledSession("https://example.invalid")
        self.assertFalse(self.raw.trust_env)
        self.assertIs(self.raw.verify, True)
        self.assertIsNone(self.raw.auth)
        self.assertEqual(self.raw.mount.call_count, 2)
        for call in self.raw.mount.call_args_list:
            self.assertEqual(call.args[1].max_retries.total, 0)
        session.get("https://example.invalid", allow_redirects=True)
        self.raw.request.assert_called_once_with("GET", "https://example.invalid",
                                                allow_redirects=False, proxies={}, verify=True)

    def test_non_get_proxy_auth_tls_refused(self):
        session = ControlledSession("https://example.invalid")
        for method, options in [("PUT", {}), ("POST", {}), ("HEAD", {}),
                                ("GET", {"proxies": {"https": SECRET}}),
                                ("GET", {"verify": False}), ("GET", {"auth": SECRET})]:
            with self.assertRaises(PlexError):
                session.request(method, "https://example.invalid", **options)
        self.raw.request.assert_not_called()

    def test_redirect_is_failure_not_plexapi_valid_result(self):
        session = ControlledSession("https://example.invalid")
        for status in [300, 301, 302, 307, 308, 399]:
            response = Mock(status_code=status)
            self.raw.request.return_value = response
            with self.assertRaises(PlexError) as caught:
                session.get("https://example.invalid")
            self.assertEqual(caught.exception.code, "transport_refused")
            response.close.assert_called_once_with()

    def test_transport_exception_safe(self):
        self.raw.request.side_effect = RuntimeError(SECRET)
        with self.assertRaises(PlexError) as caught:
            ControlledSession("https://example.invalid").get("https://example.invalid")
        self.assertNotIn(SECRET, repr(caught.exception))
        self.assertTrue(caught.exception.__suppress_context__)

    def test_foreign_origins_and_userinfo_never_dispatch(self):
        session = ControlledSession("https://example.invalid/proxy/plex")
        for url in [f"https://{SECRET}.invalid/library/metadata/1",
                    "https://example.invalid:8443/", "http://example.invalid/",
                    f"https://{SECRET}@example.invalid/",
                    f"https://user:{SECRET}@example.invalid/",
                    "https://example.invalid.evil.invalid/", "https://example.invalid./"]:
            with self.subTest(url=url), self.assertRaises(PlexError) as caught:
                session.get(url, headers={"X-Plex-Token": SECRET})
            self.assertEqual(caught.exception.code, "transport_refused")
            self.assertTrue(caught.exception.__suppress_context__)
            self.assertNotIn(SECRET, repr(caught.exception))
        self.raw.request.assert_not_called()

    def test_malformed_and_unsupported_request_urls_never_dispatch(self):
        session = ControlledSession("https://example.invalid")
        for url in [None, b"https://example.invalid", "", "/library/metadata/1",
                    "//example.invalid/", "ftp://example.invalid/", "https:///missing",
                    "https://example.invalid:", "https://example.invalid:0/",
                    "https://example.invalid:65536/", "https://example.invalid:bad/",
                    "https://[invalid]/", "https://example.invalid/#fragment",
                    " https://example.invalid/", "https://example.invalid/\npath",
                    "https://example.invalid\\@evil.invalid/", "https://%65xample.invalid/"]:
            with self.subTest(url=url), self.assertRaises(PlexError) as caught:
                session.get(url, headers={"X-Plex-Token": SECRET})
            self.assertEqual(caught.exception.code, "transport_refused")
            self.assertTrue(caught.exception.__suppress_context__)
        self.raw.request.assert_not_called()

    def test_originless_or_invalid_base_never_dispatch(self):
        with self.assertRaises(PlexError) as caught:
            ControlledSession().get("https://example.invalid", headers={"X-Plex-Token": SECRET})
        self.assertEqual(caught.exception.code, "transport_refused")
        for base in ["", "example.invalid", "ftp://example.invalid", "https://user@host.invalid",
                     f"https://[{SECRET}]", "https://host.invalid:bad"]:
            with self.subTest(base=base), self.assertRaises(PlexError) as caught:
                ControlledSession(base)
            self.assertEqual(caught.exception.code, "transport_refused")
            self.assertTrue(caught.exception.__suppress_context__)
            self.assertNotIn(SECRET, repr(caught.exception))
        self.raw.request.assert_not_called()

    def test_case_default_ports_and_same_origin_proxy_paths_allowed(self):
        for base, urls in [
            ("HTTPS://EXAMPLE.INVALID/proxy/plex", ["https://example.invalid:443/",
                "https://Example.Invalid/proxy/plex/playlists?title=Mix",
                "https://example.invalid/other/path"]),
            ("http://example.invalid:80/proxy", ["HTTP://EXAMPLE.INVALID/",
                "http://example.invalid:80/proxy/library/metadata/1"]),
            ("https://[2001:db8::1]/proxy", ["https://[2001:0db8:0:0:0:0:0:1]:443/"]),
        ]:
            session = ControlledSession(base)
            for url in urls:
                session.get(url, headers={"X-Plex-Token": SECRET})
                self.assertEqual(self.raw.request.call_args.args, ("GET", url))
                self.assertFalse(self.raw.request.call_args.kwargs["allow_redirects"])
        self.assertEqual(self.raw.request.call_count, 6)

    def test_constructor_and_later_queries_share_origin_guard(self):
        def constructor(url, *, session, **kwargs):
            session.get(url + "/", headers={"X-Plex-Token": SECRET})
            return SimpleNamespace(session=session)
        with self.constructor(constructor):
            with PlexClient.connect("https://example.invalid/proxy/plex", SECRET) as client:
                client._server.session.get("https://EXAMPLE.INVALID:443/proxy/plex/playlists")
                with self.assertRaises(PlexError):
                    client._server.session.get("https://foreign.invalid/items", headers={"X-Plex-Token": SECRET})
        self.assertEqual(self.raw.request.call_count, 2)
        self.assertEqual(self.raw.request.call_args_list[0].args[1], "https://example.invalid/proxy/plex/")
        self.raw.close.assert_called_once_with()

    def test_foreign_constructor_root_query_refused_before_dispatch(self):
        def constructor(url, *, session, **kwargs):
            return session.get(f"https://{SECRET}.invalid/", headers={"X-Plex-Token": SECRET})
        with self.constructor(constructor), self.assertRaises(PlexError) as caught:
            PlexClient.connect("https://example.invalid/proxy", SECRET)
        self.assertEqual(caught.exception.code, "connection_failed")
        self.assertTrue(caught.exception.__suppress_context__)
        self.assertNotIn(SECRET, repr(caught.exception))
        self.raw.request.assert_not_called()
        self.raw.close.assert_called_once_with()

    def constructor(self, callback):
        return patch.dict(sys.modules, {"plexapi": SimpleNamespace(),
            "plexapi.server": SimpleNamespace(PlexServer=callback)})

    def test_connect_urls_and_context_cleanup(self):
        for host, expected in [("plex.invalid", "http://plex.invalid:32400"),
                               ("https://plex.invalid:8443/reverse/plex/", "https://plex.invalid:8443/reverse/plex"),
                               ("http://127.0.0.1", "http://127.0.0.1")]:
            constructor = Mock(return_value=object())
            with self.constructor(constructor):
                with PlexClient.connect(host, "token"):
                    pass
            self.assertEqual(constructor.call_args.args, (expected,))
            self.assertEqual(constructor.call_args.kwargs["timeout"], 15)
        self.assertEqual(self.raw.close.call_count, 3)

    def test_constructor_root_query_guard_and_cleanup(self):
        def constructor(url, *, session, **kwargs):
            return session.get(url + "/")
        self.raw.request.return_value = Mock(status_code=302)
        with self.constructor(constructor), self.assertRaises(PlexError) as caught:
            PlexClient.connect("plex.invalid", "token")
        self.assertEqual(caught.exception.code, "connection_failed")
        self.raw.close.assert_called_once_with()
        self.assertFalse(self.raw.request.call_args.kwargs["allow_redirects"])

    def test_constructor_error_safe_even_cleanup_error(self):
        self.raw.close.side_effect = RuntimeError(SECRET)
        with self.constructor(Mock(side_effect=RuntimeError(SECRET))), self.assertRaises(PlexError) as caught:
            PlexClient.connect("plex.invalid", "token")
        self.assertNotIn(SECRET, repr(caught.exception))
        self.assertTrue(caught.exception.__suppress_context__)

    def test_config_rejected_before_constructor(self):
        constructor = Mock()
        bad = [dict(host=h) for h in ["", " plex.invalid", "ftp://plex.invalid",
            "http://user:secret@plex.invalid", "https://plex.invalid?token=x",
            "https://plex.invalid#x", "plex.invalid/path", "host:123", "http://host:",
            "http://host:99999", "https://bad_host", "https://host\\other"]]
        bad += [dict(token=t) for t in [None, "", " ", "token\n", "token value"]]
        bad += [dict(port=p) for p in [True, 0, 65536, "32400"]]
        bad += [dict(timeout=t) for t in [True, 0, -1, float("nan"), float("inf")]]
        with self.constructor(constructor):
            for options in bad:
                with self.subTest(options=options), self.assertRaises(PlexError) as caught:
                    PlexClient.connect(**{**dict(host="plex.invalid", token="token"), **options})
                self.assertEqual(caught.exception.code, "invalid_config")
        constructor.assert_not_called()
        self.raw.request.assert_not_called()

    def test_module_reload_is_inert(self):
        import beets_mix.plex as module
        with self.constructor(Mock()) as modules:
            runpy.run_path(module.__file__)
            modules["plexapi.server"].PlexServer.assert_not_called()
        self.raw.request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
