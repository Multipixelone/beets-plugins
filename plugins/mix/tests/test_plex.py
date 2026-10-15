"""Synthetic PlexAPI/transport tests: never open a connection."""

from dataclasses import FrozenInstanceError, replace
import runpy
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, call, patch
from urllib.parse import parse_qs, urlsplit

from beets_mix.plex import ControlledSession, PlexClient, PlexError, canonical_key


SECRET = "sentinel-token-host-response"


def track(server, **changes):
    return SimpleNamespace(**{**dict(_server=server, type="track", listType="audio",
        ratingKey="001", title="Song", playlistItemID="999"), **changes})


def playlist(server, **changes):
    return SimpleNamespace(**{**dict(_server=server, title="Mix", playlistType="audio",
        smart=False, ratingKey="007", key="/playlists/7", addItems=Mock(),
        items=Mock(return_value=[track(server)])), **changes})


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


class ExactReads(unittest.TestCase):
    def setUp(self):
        self.server = SimpleNamespace(fetchItem=Mock(), playlists=Mock())
        self.client = PlexClient(self.server)

    def error(self, code, call):
        with self.assertRaises(PlexError) as caught:
            call()
        self.assertEqual(caught.exception.code, code)
        self.assertNotIn(SECRET, repr(caught.exception))
        return caught.exception

    def test_track_fetches_exact_canonical_path_and_keeps_object(self):
        obj = track(self.server, ratingKey="002")
        self.server.fetchItem.return_value = obj
        self.assertIs(self.client.track("0002"), obj)
        self.server.fetchItem.assert_called_once_with("/library/metadata/2")
        self.server.playlists.assert_not_called()

    def test_bad_track_keys_fail_before_fetch(self):
        for key in [None, True, 1.0, 0, -1, "0", "bad", "/library/metadata/2"]:
            with self.subTest(key=key):
                self.error("invalid_track", lambda: self.client.track(key))
        self.server.fetchItem.assert_not_called()

    def test_track_server_media_and_identity_refusals(self):
        for changes, code in [({"_server": object()}, "wrong_server"),
                              ({"type": "album"}, "wrong_media_type"),
                              ({"listType": "video"}, "wrong_media_type"),
                              ({"ratingKey": None}, "invalid_track"),
                              ({"ratingKey": "2"}, "track_identity_mismatch")]:
            with self.subTest(code=code):
                self.server.fetchItem.return_value = track(self.server, **changes)
                self.error(code, lambda: self.client.track(1))

    def test_missing_and_read_failure_are_safe_unavailable_reads(self):
        from plexapi.exceptions import NotFound
        for error in [NotFound(SECRET), RuntimeError(SECRET)]:
            self.server.fetchItem.side_effect = error
            for call in [lambda: self.client.track(1),
                         lambda: self.client.playlist_by_key(7, expected_title="Mix")]:
                caught = self.error("read_failed", call)
                self.assertTrue(caught.__suppress_context__)

    def test_by_key_fetches_new_handle_and_entries_without_title_lookup(self):
        first, second = playlist(self.server), playlist(self.server,
            items=Mock(return_value=[track(self.server, ratingKey="2")]))
        self.server.fetchItem.side_effect = [first, second]
        a = self.client.playlist_by_key("007", expected_title="Mix")
        b = self.client.playlist_by_key(7, expected_title="Mix")
        self.assertIs(a._handle, first)
        self.assertIs(b._handle, second)
        self.assertEqual(a.entries[0]["plex_ratingkey"], "1")
        self.assertEqual(b.entries[0]["plex_ratingkey"], "2")
        self.assertEqual(self.server.fetchItem.call_args_list,
                         [call("/playlists/7")] * 2)
        first.items.assert_called_once_with()
        second.items.assert_called_once_with()
        self.server.playlists.assert_not_called()

    def test_by_key_validates_title_key_server_manual_and_audio(self):
        for changes, code in [({"title": "Renamed"}, "invalid_playlist"),
                              ({"ratingKey": "8"}, "invalid_playlist"),
                              ({"ratingKey": "bad"}, "invalid_playlist"),
                              ({"key": "/playlists/8"}, "invalid_playlist"),
                              ({"key": "https://foreign.invalid/playlists/7"}, "invalid_playlist"),
                              ({"_server": object()}, "wrong_server"),
                              ({"smart": True}, "smart_playlist"),
                              ({"playlistType": "video"}, "wrong_playlist_type")]:
            obj = playlist(self.server, **changes)
            self.server.fetchItem.return_value = obj
            with self.subTest(code=code):
                self.error(code, lambda: self.client.playlist_by_key(7, expected_title="Mix"))
                obj.items.assert_not_called()
        for key, title in [(None, "Mix"), (True, "Mix"), ("/7", "Mix"), (7, " "), (7, None)]:
            self.server.fetchItem.reset_mock()
            self.error("invalid_playlist", lambda: self.client.playlist_by_key(key, expected_title=title))
            self.server.fetchItem.assert_not_called()

    def test_unknown_error_code_still_uses_safe_read_fallback(self):
        self.assertEqual(PlexError(SECRET).code, "read_failed")
        self.assertEqual(str(PlexError(SECRET)), "Plex read failed")


class AppendScopes(unittest.TestCase):
    setUp = Transport.setUp
    base = "https://example.invalid/proxy/plex"
    endpoint = base + "/playlists/7/items"

    def test_get_does_not_consume_put_grant_and_second_put_is_blocked(self):
        session = ControlledSession(self.base)
        with session._append_scope("7"):
            session.get(self.base + "/")
            session.put(self.endpoint + "?uri=server%3A%2F%2Ftest")
            session.get(self.base + "/playlists")
            with self.assertRaises(PlexError):
                session.put(self.endpoint)
        self.assertEqual([c.args[0] for c in self.raw.request.call_args_list], ["GET", "PUT", "GET"])
        with self.assertRaises(PlexError):
            session.put(self.endpoint)

    def test_other_origin_path_method_or_security_override_cannot_use_grant(self):
        session = ControlledSession(self.base)
        bad_urls = ["https://foreign.invalid/proxy/plex/playlists/7/items",
            "http://example.invalid/proxy/plex/playlists/7/items",
            self.base + "/playlists/8/items", "https://example.invalid/playlists/7/items",
            self.endpoint + "/", self.base + "//playlists/7/items",
            self.base + "/playlists/007/items", self.base + "/playlists/%37/items",
            self.base + "/./playlists/7/items", self.base + "/other/../playlists/7/items",
            self.base + "/playlists/7%2Fitems", self.base + "/playlists/7/items#fragment"]
        with session._append_scope("7"):
            for url in bad_urls:
                with self.subTest(url=url), self.assertRaises(PlexError):
                    session.put(url)
            for method in ["POST", "DELETE", "PATCH", "HEAD", "OPTIONS"]:
                with self.subTest(method=method), self.assertRaises(PlexError):
                    session.request(method, self.endpoint)
            for options in [{"verify": False}, {"auth": SECRET}, {"proxies": {"https": SECRET}}]:
                with self.subTest(options=options), self.assertRaises(PlexError):
                    session.put(self.endpoint, **options)
            self.raw.request.assert_not_called()
            session.put(self.endpoint)
        self.raw.request.assert_called_once_with("PUT", self.endpoint,
                                                 allow_redirects=False, proxies={}, verify=True)

    def test_grant_is_consumed_on_dispatch_failure_and_revoked_on_interrupt(self):
        session = ControlledSession(self.base)
        for error in [RuntimeError(SECRET), KeyboardInterrupt(SECRET), SystemExit(SECRET)]:
            self.raw.request.side_effect = error
            with self.subTest(error=type(error).__name__), self.assertRaises(BaseException):
                with session._append_scope("7"):
                    try:
                        session.put(self.endpoint)
                    finally:
                        self.assertIsNone(session._append_grant)
            with self.assertRaises(PlexError):
                session.put(self.endpoint)
            self.raw.request.side_effect = None
            session.get(self.base)
        self.assertEqual([c.args[0] for c in self.raw.request.call_args_list], ["PUT", "GET"] * 3)

    def test_nested_scope_and_unconsumed_scope_fail_closed(self):
        session = ControlledSession(self.base)
        with session._append_scope("7"):
            with self.assertRaises(PlexError):
                with session._append_scope("8"):
                    self.fail("nested grant must not open")
            session.put(self.endpoint)
        with self.assertRaises(PlexError):
            with session._append_scope("7"):
                pass
        with self.assertRaises(PlexError):
            session.put(self.endpoint)
        self.assertEqual(self.raw.request.call_count, 1)

    def test_unsafe_base_prefix_keys_originless_and_closed_cannot_grant(self):
        for base in [None, self.base + "//other", self.base + "/%70ath", self.base + "/../other"]:
            session = ControlledSession(base)
            with self.subTest(base=base), self.assertRaises(PlexError):
                with session._append_scope("7"):
                    self.fail("unsafe grant")
        session = ControlledSession(self.base)
        for key in [None, 7, "007", "0", "bad", "/7"]:
            with self.subTest(key=key), self.assertRaises(PlexError):
                with session._append_scope(key):
                    self.fail("noncanonical grant")
        session.close()
        with self.assertRaises(PlexError):
            with session._append_scope("7"):
                self.fail("closed grant")
        with self.assertRaises(PlexError):
            session.get(self.base)
        self.raw.request.assert_not_called()

    def test_cross_thread_cannot_spend_the_grant(self):
        from threading import Thread
        session = ControlledSession(self.base)
        errors = []
        def attempt():
            try:
                session.put(self.endpoint)
            except PlexError as exc:
                errors.append(exc.code)
        with session._append_scope("7"):
            thread = Thread(target=attempt)
            thread.start()
            thread.join()
            self.assertEqual(errors, ["transport_refused"])
            self.raw.request.assert_not_called()
            session.put(self.endpoint)


class Appends(unittest.TestCase):
    base = AppendScopes.base
    endpoint = AppendScopes.endpoint

    def setUp(self):
        Transport.setUp(self)
        def constructor(url, *, session, **kwargs):
            return SimpleNamespace(_session=session, playlists=Mock())
        with Transport.constructor(self, constructor):
            self.client = PlexClient.connect(self.base, SECRET)
        self.addCleanup(self.client.close)
        self.server = self.client._server
        self.handle = playlist(self.server)
        self.handle.addItems.side_effect = lambda tracks: self.client._session.put(self.endpoint)
        self.server.playlists.return_value = [self.handle]
        self.snapshot = self.client.playlist("Mix")
        self.tracks = [track(self.server, ratingKey="3"), track(self.server, ratingKey="2")]

    def error(self, code, call):
        with self.assertRaises(PlexError) as caught:
            call()
        self.assertEqual(caught.exception.code, code)
        self.assertNotIn(SECRET, repr(caught.exception))
        return caught.exception

    def test_validated_ordered_single_add_and_put_and_expired_permission(self):
        self.assertIsNone(self.client.append(self.snapshot, self.tracks))
        self.handle.addItems.assert_called_once_with(self.tracks)
        self.raw.request.assert_called_once()
        self.assertEqual(self.raw.request.call_args.args, ("PUT", self.endpoint))
        self.error("transport_refused", lambda: self.client._session.put(self.endpoint))

    def test_empty_is_validated_noop_even_for_read_only_injected_client(self):
        PlexClient(self.server).append(self.snapshot, [])
        self.handle.smart = True
        self.error("smart_playlist", lambda: self.client.append(self.snapshot, []))
        self.handle.addItems.assert_not_called()
        self.raw.request.assert_not_called()

    def test_all_tracks_prevalidated_before_any_add(self):
        for changes, code in [({"_server": object()}, "wrong_server"),
                              ({"type": "album"}, "wrong_media_type"),
                              ({"listType": "video"}, "wrong_media_type"),
                              ({"ratingKey": "bad-key"}, "invalid_track"),
                              ({"ratingKey": True}, "invalid_track")]:
            with self.subTest(code=code):
                self.error(code, lambda: self.client.append(self.snapshot,
                    [self.tracks[0], track(self.server, **changes)]))
        self.handle.addItems.assert_not_called()
        self.raw.request.assert_not_called()

    def test_target_mutations_and_forged_snapshot_refused_before_add(self):
        for field, value, code in [("_server", object(), "wrong_server"),
                                  ("smart", True, "smart_playlist"),
                                  ("smart", 0, "smart_playlist"),
                                  ("playlistType", "video", "wrong_playlist_type"),
                                  ("title", "Renamed", "invalid_playlist"),
                                  ("ratingKey", "8", "invalid_playlist"),
                                  ("key", "/playlists/8", "invalid_playlist"),
                                  ("key", "/playlists/7?bad=1", "invalid_playlist")]:
            original = getattr(self.handle, field)
            setattr(self.handle, field, value)
            with self.subTest(field=field):
                self.error(code, lambda: self.client.append(self.snapshot, self.tracks))
            setattr(self.handle, field, original)
        for snapshot in [None, replace(self.snapshot, plex_ratingkey="007"),
                         replace(self.snapshot, title="Other"), replace(self.snapshot, _handle=None)]:
            with self.subTest(snapshot=snapshot):
                self.error("invalid_playlist", lambda: self.client.append(snapshot, self.tracks))
        self.handle.addItems.assert_not_called()
        self.raw.request.assert_not_called()

    def test_unowned_mismatched_and_closed_sessions_never_add(self):
        self.error("transport_refused", lambda: PlexClient(self.server).append(self.snapshot, self.tracks))
        owned = self.server._session
        self.server._session = object()
        self.error("transport_refused", lambda: self.client.append(self.snapshot, self.tracks))
        self.server._session = owned
        owned.close()
        self.error("transport_refused", lambda: self.client.append(self.snapshot, self.tracks))
        self.handle.addItems.assert_not_called()
        self.raw.request.assert_not_called()

    def test_write_exceptions_and_interruptions_have_fixed_context_free_unknown(self):
        for error in [RuntimeError(SECRET), KeyboardInterrupt(SECRET), SystemExit(SECRET)]:
            self.handle.addItems.reset_mock()
            self.raw.request.reset_mock()
            self.raw.request.side_effect = error
            with self.subTest(error=type(error).__name__):
                caught = self.error("write_outcome_unknown", lambda: self.client.append(self.snapshot, self.tracks))
                self.assertEqual(str(caught), "Plex write outcome is unknown; re-read the playlist before retrying")
                self.assertIsNone(caught.__context__)
                self.assertIsNone(caught.__cause__)
                self.handle.addItems.assert_called_once_with(self.tracks)
                self.raw.request.assert_called_once()
                self.raw.request.side_effect = None
                self.error("transport_refused", lambda: self.client._session.put(self.endpoint))
                self.client._session.get(self.base)

    def assert_entry_failure_revoked_and_client_reusable(self, session, error):
        self.assertEqual(error.code, "write_outcome_unknown")
        self.assertEqual(str(error), "Plex write outcome is unknown; re-read the playlist before retrying")
        self.assertIsNone(error.__context__)
        self.assertIsNone(error.__cause__)
        self.handle.addItems.assert_not_called()
        self.raw.request.assert_not_called()
        state = (session._append_scope_path, session._append_grant)
        try:
            session.put(self.endpoint)
            refused = False
        except PlexError as caught:
            refused = caught.code == "transport_refused"
        # Inspect both revocation and sink dispatch before any test cleanup closes the client.
        self.assertEqual((state, refused, self.raw.request.call_count), ((None, None), True, 0))
        self.assertIs(self.client._session, session)
        self.assertIs(self.server._session, session)
        self.assertFalse(session._closed)
        self.raw.close.assert_not_called()
        fresh = self.client.playlist("Mix")
        self.assertIsNone(self.client.append(fresh, self.tracks))
        self.handle.addItems.assert_called_once_with(self.tracks)
        self.raw.request.assert_called_once_with("PUT", self.endpoint,
                                                 allow_redirects=False, proxies={}, verify=True)
        self.assertIsNone(session._append_scope_path)
        self.assertIsNone(session._append_grant)
        self.error("transport_refused", lambda: session.put(self.endpoint))
        self.assertEqual(self.raw.request.call_count, 1)

    def interrupt_after_grant_before_scope_body(self, error_type):
        session = self.client._session
        code = ControlledSession._append_scope.__wrapped__.__code__
        injected = []
        def trace(frame, event, arg):
            if (event == "line" and frame.f_code is code
                    and frame.f_locals.get("self") is session
                    and session._append_grant is not None and not injected):
                injected.append(True)
                raise error_type(SECRET)
            return trace
        previous = sys.gettrace()
        try:
            sys.settrace(trace)
            error = self.error("write_outcome_unknown",
                               lambda: self.client.append(self.snapshot, self.tracks))
        finally:
            sys.settrace(previous)
        self.assertEqual(injected, [True])
        self.assertIs(sys.gettrace(), previous)
        self.assert_entry_failure_revoked_and_client_reusable(session, error)

    def test_scope_entry_keyboard_interrupt_revokes_grant_before_body(self):
        self.interrupt_after_grant_before_scope_body(KeyboardInterrupt)

    def test_scope_entry_system_exit_revokes_grant_before_body(self):
        self.interrupt_after_grant_before_scope_body(SystemExit)

    def test_partial_scope_installation_failures_revoke_and_allow_fresh_append(self):
        session = self.client._session
        for error_type in (RuntimeError, KeyboardInterrupt, SystemExit):
            self.handle.addItems.reset_mock()
            self.raw.request.reset_mock()
            with self.subTest(error=error_type.__name__):
                partial = []
                def fail_identify():
                    partial.append((session._append_scope_path, session._append_grant))
                    raise error_type(SECRET)
                with patch("beets_mix.plex.get_ident", side_effect=fail_identify) as identify:
                    error = self.error("write_outcome_unknown",
                                       lambda: self.client.append(self.snapshot, self.tracks))
                identify.assert_called_once_with()
                self.assertEqual(partial, [(urlsplit(self.endpoint).path, None)])
                self.assert_entry_failure_revoked_and_client_reusable(session, error)

    def test_double_dispatch_is_blocked_without_retry_and_missing_dispatch_is_unknown(self):
        def twice(tracks):
            self.client._session.put(self.endpoint)
            self.client._session.put(self.endpoint)
        self.handle.addItems.side_effect = twice
        self.error("write_outcome_unknown", lambda: self.client.append(self.snapshot, self.tracks))
        self.raw.request.assert_called_once()
        self.handle.addItems.assert_called_once()
        self.raw.request.reset_mock()
        self.handle.addItems.reset_mock()
        self.handle.addItems.side_effect = None
        self.error("write_outcome_unknown", lambda: self.client.append(self.snapshot, self.tracks))
        self.raw.request.assert_not_called()
        self.handle.addItems.assert_called_once()

    def test_put_redirects_and_transport_refusals_are_unknown_at_write_boundary(self):
        self.raw.request.return_value = Mock(status_code=302)
        self.error("write_outcome_unknown", lambda: self.client.append(self.snapshot, self.tracks))
        self.raw.request.assert_called_once()
        self.raw.request.return_value.close.assert_called_once()
        self.raw.request.reset_mock()
        self.handle.addItems.side_effect = lambda tracks: self.client._session.put(self.base + "/other")
        self.error("write_outcome_unknown", lambda: self.client.append(self.snapshot, self.tracks))
        self.raw.request.assert_not_called()
        self.error("transport_refused", lambda: self.client._session.put(self.endpoint))


class InstalledPlexAPI(unittest.TestCase):
    def test_real_plexapi_http_errors_are_context_free_unknown_without_retry(self):
        from xml.etree.ElementTree import fromstring
        from plexapi.audio import Track
        from plexapi.playlist import Playlist
        from beets_mix.plex import PlaylistSnapshot
        base = AppendScopes.base
        raw = Mock(proxies={})
        with patch("requests.Session", return_value=raw):
            for status in [400, 401, 404, 500]:
                raw.request.return_value = SimpleNamespace(status_code=200, url=base,
                    text='<MediaContainer machineIdentifier="fake-machine" version="1" friendlyName="Fake"/>')
                with self.subTest(status=status), PlexClient.connect(base, SECRET) as client:
                    handle = Playlist(client._server, fromstring('<Playlist ratingKey="7" '
                        'key="/playlists/7" type="playlist" title="Mix" playlistType="audio" smart="0"/>'))
                    obj = Track(client._server, fromstring('<Track ratingKey="2" '
                        'key="/library/metadata/2" type="track" title="Song"/>'))
                    snapshot = PlaylistSnapshot("Mix", "7", (), handle)
                    raw.request.reset_mock()
                    raw.request.return_value = SimpleNamespace(status_code=status,
                        text=SECRET, url=base + "/" + SECRET)
                    with self.assertRaises(PlexError) as caught:
                        client.append(snapshot, [obj])
                    self.assertEqual(caught.exception.code, "write_outcome_unknown")
                    self.assertIsNone(caught.exception.__context__)
                    self.assertIsNone(caught.exception.__cause__)
                    self.assertNotIn(SECRET, str(caught.exception))
                    self.assertEqual(raw.request.call_count, 1)
                    self.assertEqual(raw.request.call_args.args[0], "PUT")
                    with self.assertRaises(PlexError):
                        client._session.put(base + "/playlists/7/items")

    def test_real_4182_objects_and_additems_issue_one_ordered_put_under_fake_http(self):
        import plexapi
        from plexapi.audio import Track
        from plexapi.playlist import Playlist
        self.assertEqual(plexapi.__version__, "4.18.2")
        base = AppendScopes.base
        raw = Mock(proxies={})
        def response(method, url, **kwargs):
            path = urlsplit(url).path
            if method == "PUT":
                self.assertEqual(path, "/proxy/plex/playlists/7/items")
                text = "<MediaContainer/>"
            elif path == "/proxy/plex/":
                text = '<MediaContainer machineIdentifier="fake-machine" version="1" friendlyName="Fake"/>'
            elif path in ("/proxy/plex/playlists", "/proxy/plex/playlists/7"):
                text = ('<MediaContainer size="1" totalSize="1"><Playlist ratingKey="7" '
                        'key="/playlists/7" type="playlist" title="Mix" playlistType="audio" smart="0"/></MediaContainer>')
            else:
                key = "1" if path == "/proxy/plex/playlists/7/items" else path.rsplit("/", 1)[-1]
                self.assertIn(path, ["/proxy/plex/playlists/7/items", "/proxy/plex/library/metadata/2",
                                     "/proxy/plex/library/metadata/3"])
                text = (f'<MediaContainer size="1" totalSize="1"><Track ratingKey="{key}" '
                        f'key="/library/metadata/{key}" type="track" title="Song {key}"/></MediaContainer>')
            return SimpleNamespace(status_code=200, text=text, url=url)
        raw.request.side_effect = response
        with patch("requests.Session", return_value=raw), PlexClient.connect(base, SECRET) as client:
            snapshot = client.playlist("Mix")
            tracks = [client.track("003"), client.track(2)]
            self.assertIsInstance(snapshot._handle, Playlist)
            self.assertTrue(all(isinstance(t, Track) for t in tracks))
            original = Playlist.addItems
            with patch.object(Playlist, "addItems", autospec=True, side_effect=original) as add:
                client.append(snapshot, tracks)
                add.assert_called_once_with(snapshot._handle, tracks)
            puts = [c for c in raw.request.call_args_list if c.args[0] == "PUT"]
            self.assertEqual(len(puts), 1)
            query = parse_qs(urlsplit(puts[0].args[1]).query)
            self.assertEqual(query["uri"], ["server://fake-machine/com.plexapp.plugins.library/library/metadata/3,2"])
            self.assertFalse(puts[0].kwargs["allow_redirects"])
            self.assertIs(puts[0].kwargs["verify"], True)
            with self.assertRaises(PlexError):
                client._session.put(base + "/playlists/7/items")
            fresh = client.playlist_by_key(7, expected_title="Mix")
            self.assertIsNot(fresh._handle, snapshot._handle)
            self.assertEqual(fresh.entries, ({"plex_ratingkey": "1", "title": "Song 1"},))
        raw.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
