"""Origin-bound Plex reads and explicitly scoped append; no PlexAPI import work."""

from contextlib import contextmanager
from dataclasses import dataclass, field
import math
import ipaddress
import re
from threading import get_ident
from urllib.parse import urlsplit, urlunsplit


_MESSAGES = {
    "invalid_config": "Invalid Plex connection configuration",
    "connection_failed": "Plex connection failed",
    "read_failed": "Plex read failed",
    "transport_refused": "Plex transport request refused",
    "playlist_not_found": "Plex playlist not found",
    "playlist_ambiguous": "Plex playlist title is ambiguous",
    "wrong_playlist_type": "Plex playlist is not audio",
    "smart_playlist": "Plex playlist is not manual",
    "invalid_playlist": "Plex playlist identity is invalid",
    "wrong_media_type": "Plex playlist entry is not an audio track",
    "wrong_server": "Plex object belongs to another server",
    "invalid_track": "Plex track identity is invalid",
    "track_identity_mismatch": "Plex track identity does not match the requested key",
    "write_outcome_unknown": "Plex write outcome is unknown; re-read the playlist before retrying",
}


class PlexError(Exception):
    """Only adapter-owned categories and messages cross the boundary."""

    def __init__(self, code):
        self.code = code if code in _MESSAGES else "read_failed"
        super().__init__(_MESSAGES[self.code])


def canonical_key(value):
    """Positive ASCII decimal keys only; never paths or occurrence IDs."""
    if type(value) is int:
        return str(value) if value > 0 else None
    if type(value) is str and value and value.isascii() and value.isdecimal():
        return value.lstrip("0") or None
    return None


class ControlledSession:
    """GET-only by default; append can grant one exact-path PUT on this thread."""

    def __init__(self, base_url=None):
        self._origin = _url_origin(base_url) if base_url is not None else None
        self._base_path = urlsplit(base_url).path.rstrip("/") if base_url is not None else None
        self._closed = False
        self._append_scope_path = None
        self._append_grant = None
        import requests
        from requests.adapters import HTTPAdapter

        self._session = requests.Session()
        self._session.trust_env = False
        self._session.verify = True
        self._session.proxies.clear()
        self._session.auth = None
        self._session.mount("http://", HTTPAdapter(max_retries=0))
        self._session.mount("https://", HTTPAdapter(max_retries=0))

    def request(self, method, url, **kwargs):
        if self._closed or not isinstance(method, str) or method.upper() not in ("GET", "PUT"):
            raise PlexError("transport_refused") from None
        method = method.upper()
        if self._origin is None or _url_origin(url) != self._origin:
            raise PlexError("transport_refused") from None
        if (kwargs.get("proxies") or kwargs.get("auth") is not None
                or kwargs.get("verify", True) is not True):
            raise PlexError("transport_refused") from None
        if method == "PUT":
            if self._append_grant != (urlsplit(url).path, get_ident()):
                raise PlexError("transport_refused") from None
        kwargs.update(allow_redirects=False, proxies={}, verify=True)
        try:
            if method == "PUT":
                # Consume immediately before dispatch, even when dispatch raises.
                self._append_grant = None
            response = self._session.request(method, url, **kwargs)
            if 300 <= response.status_code < 400:
                response.close()
                raise PlexError("transport_refused")
            return response
        except PlexError:
            raise
        except Exception:
            raise PlexError("write_outcome_unknown" if method == "PUT" else "read_failed") from None

    def get(self, url, **kwargs):
        return self.request("GET", url, **kwargs)

    def put(self, url, **kwargs):
        return self.request("PUT", url, **kwargs)

    @contextmanager
    def _append_scope(self, key):
        if (self._closed or self._origin is None or self._append_scope_path is not None
                or type(key) is not str or canonical_key(key) != key
                or type(self._base_path) is not str
                or not re.fullmatch(r"(?:/[A-Za-z0-9._~-]+)*", self._base_path)
                or any(part in (".", "..") for part in self._base_path.split("/"))):
            raise PlexError("transport_refused") from None
        path = f"{self._base_path}/playlists/{key}/items"
        try:
            self._append_scope_path = path
            self._append_grant = (path, get_ident())
            yield
            if self._closed or self._append_grant is not None:
                raise PlexError("transport_refused")
        finally:
            self._append_grant = None
            self._append_scope_path = None

    def close(self):
        self._closed = True
        self._append_grant = None
        self._session.close()


def _base_url(host, port):
    if (type(host) is not str or not host or host != host.strip()
            or any(c.isspace() or ord(c) < 32 for c in host)
            or "\\" in host or "?" in host or "#" in host):
        raise PlexError("invalid_config")
    explicit = "://" in host
    parsed = urlsplit(host if explicit else "//" + host)
    if (explicit and parsed.scheme not in ("http", "https")
            or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.query or parsed.fragment
            or not explicit and (parsed.path or parsed.port is not None)):
        raise PlexError("invalid_config")
    if parsed.port is not None and not 1 <= parsed.port <= 65535:
        raise PlexError("invalid_config")
    if parsed.netloc.endswith(":"):
        raise PlexError("invalid_config")
    hostname = parsed.hostname
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        if not all(re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label)
                   for label in hostname.rstrip(".").split(".")):
            raise PlexError("invalid_config")
    if explicit:
        return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))
    hostname = parsed.hostname
    if ":" in hostname:
        hostname = f"[{hostname}]"
    return f"http://{hostname}:{port}"


def _url_origin(url):
    """Validate before dispatch; query strings are allowed, credentials are not."""
    try:
        if (type(url) is not str or not url or "\\" in url or "#" in url
                or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in url)):
            raise ValueError
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError
        # Reuse the configured-URL authority validation without restricting
        # ordinary Plex query parameters on the already validated origin.
        _base_url(urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", "")), 32400)
        hostname = parsed.hostname
        if hostname is None:
            raise ValueError
        try:
            hostname = ipaddress.ip_address(hostname).compressed
        except ValueError:
            hostname = hostname.lower()
        return parsed.scheme, hostname, parsed.port or (443 if parsed.scheme == "https" else 80)
    except Exception:
        raise PlexError("transport_refused") from None


@dataclass(frozen=True)
class PlaylistSnapshot:
    title: str
    plex_ratingkey: str
    entries: tuple[dict[str, object], ...]
    _handle: object = field(default=None, repr=False, compare=False)


class PlexClient:
    def __init__(self, server):
        self._server = server
        self._session: ControlledSession | None = None

    @classmethod
    def connect(cls, host, token, *, port=32400, timeout=15):
        session = None
        try:
            if (type(token) is not str or not token.strip()
                    or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in token)
                    or type(port) is not int or not 1 <= port <= 65535
                    or isinstance(timeout, bool) or not isinstance(timeout, (int, float))
                    or not math.isfinite(timeout) or timeout <= 0):
                raise PlexError("invalid_config")
            url = _base_url(host, port)
        except Exception:
            raise PlexError("invalid_config") from None
        try:
            from plexapi.server import PlexServer

            session = ControlledSession(url)
            server = PlexServer(url, token=token, session=session, timeout=timeout)
            client = cls(server)
            client._session = session
            return client
        except Exception:
            if session is not None:
                try:
                    session.close()
                except Exception:
                    pass
            raise PlexError("connection_failed") from None

    def close(self):
        if self._session is not None:
            session, self._session = self._session, None
            try:
                session.close()
            except Exception:
                raise PlexError("read_failed") from None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def playlist(self, title):
        if type(title) is not str or not title.strip():
            raise PlexError("invalid_playlist") from None
        try:
            matches = [p for p in self._server.playlists(playlistType="audio", title=title)
                       if p.title == title]
            if len(matches) != 1:
                raise PlexError("playlist_ambiguous" if matches else "playlist_not_found")
            return self._snapshot(matches[0], title)
        except PlexError:
            raise
        except Exception:
            raise PlexError("read_failed") from None

    def _playlist_key(self, playlist, title, expected_key=None):
        if playlist._server is not self._server:
            raise PlexError("wrong_server")
        if playlist.playlistType != "audio":
            raise PlexError("wrong_playlist_type")
        if playlist.smart is not False:
            raise PlexError("smart_playlist")
        key = canonical_key(playlist.ratingKey)
        if (key is None or playlist.title != title
                or expected_key is not None and (key != expected_key
                    or getattr(playlist, "key", None) != f"/playlists/{expected_key}")):
            raise PlexError("invalid_playlist")
        return key

    def _snapshot(self, playlist, title, expected_key=None):
        key = self._playlist_key(playlist, title, expected_key)
        entries = []
        for track in playlist.items():
            if track._server is not self._server:
                raise PlexError("wrong_server")
            if track.type != "track" or track.listType != "audio":
                raise PlexError("wrong_media_type")
            track_title = getattr(track, "title", "")
            entries.append({"plex_ratingkey": canonical_key(getattr(track, "ratingKey", None)),
                            "title": track_title if type(track_title) is str else ""})
        return PlaylistSnapshot(title, key, tuple(entries), playlist)

    def _track_key(self, track, expected_key=None):
        if getattr(track, "_server", None) is not self._server:
            raise PlexError("wrong_server")
        if getattr(track, "type", None) != "track" or getattr(track, "listType", None) != "audio":
            raise PlexError("wrong_media_type")
        key = canonical_key(getattr(track, "ratingKey", None))
        if key is None:
            raise PlexError("invalid_track")
        if expected_key is not None and key != expected_key:
            raise PlexError("track_identity_mismatch")
        return key

    def track(self, key):
        key = canonical_key(key)
        if key is None:
            raise PlexError("invalid_track") from None
        try:
            track = self._server.fetchItem(f"/library/metadata/{key}")
            self._track_key(track, key)
            return track
        except PlexError:
            raise
        except Exception:
            raise PlexError("read_failed") from None

    def playlist_by_key(self, key, *, expected_title):
        key = canonical_key(key)
        if key is None or type(expected_title) is not str or not expected_title.strip():
            raise PlexError("invalid_playlist") from None
        try:
            playlist = self._server.fetchItem(f"/playlists/{key}")
            return self._snapshot(playlist, expected_title, key)
        except PlexError:
            raise
        except Exception:
            raise PlexError("read_failed") from None

    def append(self, snapshot, tracks):
        try:
            if (not isinstance(snapshot, PlaylistSnapshot) or type(snapshot.title) is not str
                    or not snapshot.title.strip() or type(snapshot.plex_ratingkey) is not str
                    or canonical_key(snapshot.plex_ratingkey) != snapshot.plex_ratingkey):
                raise PlexError("invalid_playlist")
            handle = snapshot._handle
            if handle is None:
                raise PlexError("invalid_playlist")
            key = self._playlist_key(handle, snapshot.title, snapshot.plex_ratingkey)
            add_items = getattr(handle, "addItems", None)
            if not callable(add_items):
                raise PlexError("invalid_playlist")
            ordered = list(tracks)
            for track in ordered:
                self._track_key(track)
            if not ordered:
                return
            session = self._session
            if (type(session) is not ControlledSession or session._closed
                    or getattr(self._server, "_session", None) is not session):
                raise PlexError("transport_refused")
        except PlexError:
            raise
        except Exception:
            raise PlexError("read_failed") from None
        failed = False
        try:
            with session._append_scope(key):
                add_items(ordered)
        except BaseException:
            failed = True
        if failed:
            # Outside the handler: do not retain even a suppressed raw context.
            raise PlexError("write_outcome_unknown") from None
