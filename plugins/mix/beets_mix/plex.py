"""Read-only Plex boundary. Importing this module does not import PlexAPI."""

from dataclasses import dataclass, field
import math
import ipaddress
import re
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
    """GET-only PlexAPI session bound to one explicitly configured origin."""

    def __init__(self, base_url=None):
        self._origin = _url_origin(base_url) if base_url is not None else None
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
        if not isinstance(method, str) or method.upper() != "GET":
            raise PlexError("transport_refused") from None
        if self._origin is None or _url_origin(url) != self._origin:
            raise PlexError("transport_refused") from None
        if (kwargs.get("proxies") or kwargs.get("auth") is not None
                or kwargs.get("verify", True) is not True):
            raise PlexError("transport_refused") from None
        kwargs.update(allow_redirects=False, proxies={}, verify=True)
        try:
            response = self._session.request("GET", url, **kwargs)
            if 300 <= response.status_code < 400:
                response.close()
                raise PlexError("transport_refused")
            return response
        except PlexError:
            raise
        except Exception:
            raise PlexError("read_failed") from None

    def get(self, url, **kwargs):
        return self.request("GET", url, **kwargs)

    def close(self):
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
        self._session = None

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
            playlist = matches[0]
            if playlist._server is not self._server:
                raise PlexError("wrong_server")
            if playlist.playlistType != "audio":
                raise PlexError("wrong_playlist_type")
            if playlist.smart is not False:
                raise PlexError("smart_playlist")
            key = canonical_key(playlist.ratingKey)
            if key is None:
                raise PlexError("invalid_playlist")
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
        except PlexError:
            raise
        except Exception:
            raise PlexError("read_failed") from None
