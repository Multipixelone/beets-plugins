"""Narrow, read-only Spotify Web API client used only for discovery."""

from __future__ import annotations

from dataclasses import dataclass, replace
from email.utils import parsedate_to_datetime
import os
import re
import time
from typing import Any, Callable, Mapping, Optional, Sequence, Tuple
from urllib.parse import urlparse

from .errors import (
    CredentialsUnavailable,
    InvalidReference,
    MalformedResponse,
    RateLimitExceeded,
    ServiceUnavailable,
)
from .matching import AutomaticMatchIneligibility

SPOTIFY_API = "https://api.spotify.com/v1"
SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token"
_ALBUM_ID = re.compile(r"^[A-Za-z0-9]{22}$")


@dataclass(frozen=True)
class SpotifyArtist:
    id: str
    name: str


@dataclass(frozen=True)
class SpotifyTrack:
    """Discovery data with common matching-field aliases, not beets metadata."""

    id: str
    title: str
    artists: Tuple[SpotifyArtist, ...]
    disc_number: int
    track_number: int
    duration_ms: Optional[int]
    isrc: Optional[str] = None
    available: bool = True
    linked_from_id: Optional[str] = None

    @property
    def artist(self) -> str:
        return ", ".join(artist.name for artist in self.artists)

    @property
    def duration(self) -> Optional[float]:
        return None if self.duration_ms is None else self.duration_ms / 1000.0

    @property
    def automatic_match_eligible(self) -> bool:
        """Adapt Spotify availability evidence to the generic candidate seam."""
        return self.available and self.linked_from_id is None

    @property
    def automatic_match_reason(self) -> AutomaticMatchIneligibility | None:
        if self.automatic_match_eligible:
            return None
        return AutomaticMatchIneligibility.PROVIDER_RESTRICTION


@dataclass(frozen=True)
class SpotifyAlbum:
    """Provider-neutral-shaped release candidate; it deliberately owns no tags."""

    id: str
    title: str
    artists: Tuple[SpotifyArtist, ...]
    release_date: Optional[str]
    album_type: Optional[str]
    total_tracks: Optional[int]
    tracks: Tuple[SpotifyTrack, ...] = ()
    market: Optional[str] = None

    @property
    def url(self) -> str:
        return canonical_album_url(self.id)

    @property
    def artist(self) -> str:
        return ", ".join(artist.name for artist in self.artists)

    @property
    def album(self) -> str:
        return self.title

    @property
    def album_artist(self) -> str:
        return self.artist

    @property
    def track_count(self) -> int:
        return len(self.tracks) if self.tracks else (self.total_tracks or 0)


def canonical_album_url(album_id: str) -> str:
    if not _ALBUM_ID.fullmatch(album_id):
        raise InvalidReference("Spotify album IDs must be 22 base62 characters")
    return "https://open.spotify.com/album/{0}".format(album_id)


def parse_album_reference(reference: str) -> str:
    """Accept only an album ID, spotify URI, or official open.spotify URL."""
    value = reference.strip()
    if _ALBUM_ID.fullmatch(value):
        return value
    if value.startswith("spotify:album:"):
        album_id = value[len("spotify:album:") :]
        if _ALBUM_ID.fullmatch(album_id):
            return album_id
    parsed = urlparse(value)
    if parsed.scheme == "https" and parsed.netloc.lower() in {
        "open.spotify.com",
        "www.open.spotify.com",
    }:
        parts = [part for part in parsed.path.split("/") if part]
        if len(parts) == 2 and parts[0] == "album" and _ALBUM_ID.fullmatch(parts[1]):
            return parts[1]
    raise InvalidReference("expected a Spotify album ID, URI, or album URL")


def redact_diagnostic(value: object) -> str:
    """Render only safe diagnostic fields and redact token/header representations."""
    if isinstance(value, Mapping):
        safe = {"method", "path", "status", "retry_after", "error"}
        text = " ".join(
            "{0}={1}".format(key, value[key] if key in safe else "<redacted>")
            for key in sorted(value)
        )
    else:
        text = str(value)
    text = re.sub(
        r"(?i)(authorization\s*[:=]\s*)(?:(?:bearer|basic)\s+)?[^\s,]+",
        r"\1<redacted>",
        text,
    )
    text = re.sub(
        r"(?i)((?:access_token|client_secret|client_id|token)\s*[:=]\s*)([^\s,&]+)",
        r"\1<redacted>",
        text,
    )
    return text


class SpotifyClient:
    """A bounded official-API client with injectable time and HTTP seams."""

    def __init__(
        self,
        session: Optional[Any] = None,
        *,
        environ: Optional[Mapping[str, str]] = None,
        clock: Callable[[], float] = time.time,
        sleeper: Callable[[float], None] = time.sleep,
        timeout: float = 10.0,
        market: str = "US",
        warning: Optional[Callable[[str], None]] = None,
        diagnostic: Optional[Callable[[str], None]] = None,
        max_retry_after: float = 60.0,
        max_track_pages: int = 20,
    ) -> None:
        self._session = session if session is not None else _default_session()
        self._environ = environ if environ is not None else os.environ
        self._clock = clock
        self._sleeper = sleeper
        self._timeout = timeout
        self.market = market
        self._warning = warning or (lambda _message: None)
        self._diagnostic = diagnostic or (lambda _message: None)
        self._max_retry_after = max(0.0, max_retry_after)
        self._max_track_pages = max(1, max_track_pages)
        self._token: Optional[str] = None
        self._token_expires_at = 0.0
        self._warned_missing_credentials = False

    def search_albums(self, query: str, *, limit: int = 20) -> Tuple[SpotifyAlbum, ...]:
        if not query.strip():
            return ()
        bounded_limit = max(1, min(int(limit), 50))
        payload = self._api_json(
            "GET",
            "/search",
            params={"q": query, "type": "album", "limit": bounded_limit, "market": self.market},
        )
        albums = _mapping(payload.get("albums"), "albums")
        items = _list(albums.get("items"), "albums.items")
        return tuple(self._album_from_payload(item) for item in items[:bounded_limit])

    def get_album(
        self, reference: str, *, enrich_track_details: bool = False
    ) -> SpotifyAlbum:
        album_id = parse_album_reference(reference)
        payload = self._api_json("GET", "/albums/{0}".format(album_id), params={"market": self.market})
        album = self._album_from_payload(payload)
        tracks = self._album_tracks(album_id, payload)
        if enrich_track_details:
            tracks = self._enrich_tracks(tracks)
        return replace(album, tracks=tracks)

    def _album_tracks(self, album_id: str, payload: Mapping[str, Any]) -> Tuple[SpotifyTrack, ...]:
        embedded = _mapping(payload.get("tracks"), "album.tracks")
        tracks = [self._track_from_payload(item) for item in _list(embedded.get("items"), "tracks.items")]
        offset = len(tracks)
        total = _integer(embedded.get("total"), "tracks.total")
        declared_total = _integer(payload.get("total_tracks"), "album.total_tracks")
        if total != declared_total or offset > total:
            raise MalformedResponse("Spotify album track totals are inconsistent")
        page_limit = 50
        pages = 0
        while offset < total:
            if pages >= self._max_track_pages:
                raise MalformedResponse("Spotify album track pagination exceeded its bound")
            page = self._api_json(
                "GET",
                "/albums/{0}/tracks".format(album_id),
                params={"market": self.market, "limit": page_limit, "offset": offset},
            )
            items = _list(page.get("items"), "tracks.items")
            if not items:
                raise MalformedResponse("Spotify track page was unexpectedly empty")
            page_total = page.get("total")
            if page_total is not None and _integer(page_total, "tracks.total") != total:
                raise MalformedResponse("Spotify paginated track total changed")
            if len(items) > total - offset:
                raise MalformedResponse("Spotify track page exceeds declared total")
            tracks.extend(self._track_from_payload(item) for item in items)
            offset += len(items)
            pages += 1
        if len(tracks) != total:
            raise MalformedResponse("Spotify album track hydration is incomplete")
        return tuple(tracks)

    def _enrich_tracks(self, tracks: Sequence[SpotifyTrack]) -> Tuple[SpotifyTrack, ...]:
        enriched = {track.id: track for track in tracks}
        for start in range(0, len(tracks), 50):
            ids = [track.id for track in tracks[start : start + 50] if track.id]
            if not ids:
                continue
            try:
                payload = self._api_json("GET", "/tracks", params={"ids": ",".join(ids), "market": self.market})
                details = _list(payload.get("tracks"), "tracks")
                for detail in details:
                    if detail is None:
                        continue
                    detail_map = _mapping(detail, "track detail")
                    track_id = _string(detail_map.get("id"), "track detail.id")
                    if track_id not in enriched:
                        continue
                    external_ids = detail_map.get("external_ids")
                    isrc = None
                    if isinstance(external_ids, Mapping) and isinstance(external_ids.get("isrc"), str):
                        isrc = external_ids["isrc"]
                    if isrc:
                        enriched[track_id] = replace(enriched[track_id], isrc=isrc)
            except (ServiceUnavailable, MalformedResponse) as exc:
                # Details/ISRC are enrichment only. Permission and availability errors
                # must not turn an otherwise usable discovery candidate into a failure.
                self._diagnostic(redact_diagnostic("Spotify detail enrichment skipped: {0}".format(exc)))
                continue
        return tuple(enriched[track.id] for track in tracks)

    def _api_json(self, method: str, path: str, *, params: Mapping[str, Any]) -> Mapping[str, Any]:
        response = self._request(method, SPOTIFY_API + path, params=params, authenticated=True)
        return self._json(response)

    def _request(
        self, method: str, url: str, *, params: Mapping[str, Any], authenticated: bool
    ) -> Any:
        refreshed = False
        retried_rate_limit = False
        while True:
            headers = {"Accept": "application/json"}
            if authenticated:
                headers["Authorization"] = "Bearer {0}".format(self._access_token())
            try:
                response = self._session.request(
                    method, url, params=dict(params), headers=headers, timeout=self._timeout
                )
            except Exception as exc:
                # Exception intentionally excludes KeyboardInterrupt/SystemExit.
                raise ServiceUnavailable("Spotify request failed: {0}".format(type(exc).__name__)) from exc
            status = getattr(response, "status_code", None)
            self._diagnostic(redact_diagnostic({"method": method, "path": path_from_url(url), "status": status}))
            if authenticated and status == 401 and not refreshed:
                self._token = None
                self._token_expires_at = 0.0
                refreshed = True
                continue
            if status == 429 and not retried_rate_limit:
                self._wait_retry_after(response)
                retried_rate_limit = True
                continue
            if status == 429:
                raise RateLimitExceeded("Spotify rate limit persisted after retry")
            if not isinstance(status, int) or status < 200 or status >= 300:
                raise ServiceUnavailable("Spotify returned HTTP {0}".format(status))
            return response

    def _access_token(self) -> str:
        if self._token is not None and self._clock() < self._token_expires_at:
            return self._token
        client_id = self._environ.get("SPOTIFY_CLIENT_ID")
        client_secret = self._environ.get("SPOTIFY_CLIENT_SECRET")
        if not client_id or not client_secret:
            if not self._warned_missing_credentials:
                self._warning("Spotify credentials are unavailable; Harmony assistance is disabled.")
                self._warned_missing_credentials = True
            raise CredentialsUnavailable("Spotify credentials are unavailable")
        response = self._request_token(client_id, client_secret)
        payload = self._json(response)
        token = _string(payload.get("access_token"), "access_token")
        expires_in = _integer(payload.get("expires_in"), "expires_in")
        if expires_in <= 0:
            raise MalformedResponse("Spotify token expiry must be positive")
        self._token = token
        self._token_expires_at = self._clock() + max(0, expires_in - 30)
        return token

    def _request_token(self, client_id: str, client_secret: str) -> Any:
        tried_rate_limit = False
        while True:
            try:
                response = self._session.request(
                    "POST",
                    SPOTIFY_TOKEN_URL,
                    data={"grant_type": "client_credentials"},
                    auth=(client_id, client_secret),
                    headers={"Accept": "application/json"},
                    timeout=self._timeout,
                )
            except Exception as exc:
                raise ServiceUnavailable("Spotify token request failed: {0}".format(type(exc).__name__)) from exc
            status = getattr(response, "status_code", None)
            if status == 429 and not tried_rate_limit:
                self._wait_retry_after(response)
                tried_rate_limit = True
                continue
            if status == 429:
                raise RateLimitExceeded("Spotify token rate limit persisted after retry")
            if not isinstance(status, int) or status < 200 or status >= 300:
                raise ServiceUnavailable("Spotify token endpoint returned HTTP {0}".format(status))
            return response

    def _retry_after(self, response: Any) -> float:
        headers = getattr(response, "headers", {}) or {}
        value = headers.get("Retry-After") if isinstance(headers, Mapping) else None
        try:
            return max(0.0, float(value))
        except (TypeError, ValueError):
            try:
                then = parsedate_to_datetime(str(value)).timestamp()
                return max(0.0, then - self._clock())
            except (TypeError, ValueError, IndexError, OverflowError):
                return 1.0

    def _wait_retry_after(self, response: Any) -> None:
        delay = self._retry_after(response)
        if delay > self._max_retry_after:
            raise RateLimitExceeded("Spotify Retry-After exceeds Harmony waiting budget")
        self._sleeper(delay)

    @staticmethod
    def _json(response: Any) -> Mapping[str, Any]:
        try:
            payload = response.json()
        except Exception as exc:
            raise MalformedResponse("Spotify returned malformed JSON") from exc
        return _mapping(payload, "response")

    @staticmethod
    def _album_from_payload(payload: Any) -> SpotifyAlbum:
        data = _mapping(payload, "album")
        return SpotifyAlbum(
            id=_string(data.get("id"), "album.id"),
            title=_string(data.get("name"), "album.name"),
            artists=_artists(data.get("artists")),
            release_date=data.get("release_date") if isinstance(data.get("release_date"), str) else None,
            album_type=data.get("album_type") if isinstance(data.get("album_type"), str) else None,
            total_tracks=data.get("total_tracks") if isinstance(data.get("total_tracks"), int) else None,
        )

    @staticmethod
    def _track_from_payload(payload: Any) -> SpotifyTrack:
        data = _mapping(payload, "track")
        linked = data.get("linked_from")
        return SpotifyTrack(
            id=_string(data.get("id"), "track.id"),
            title=_string(data.get("name"), "track.name"),
            artists=_artists(data.get("artists")),
            disc_number=_integer(data.get("disc_number"), "track.disc_number"),
            track_number=_integer(data.get("track_number"), "track.track_number"),
            duration_ms=data.get("duration_ms") if isinstance(data.get("duration_ms"), int) else None,
            available=data.get("is_playable") is not False,
            linked_from_id=linked.get("id") if isinstance(linked, Mapping) and isinstance(linked.get("id"), str) else None,
        )


def _mapping(value: Any, name: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise MalformedResponse("Spotify {0} must be an object".format(name))
    return value


def _list(value: Any, name: str) -> Sequence[Any]:
    if not isinstance(value, list):
        raise MalformedResponse("Spotify {0} must be a list".format(name))
    return value


def _string(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise MalformedResponse("Spotify {0} must be a non-empty string".format(name))
    return value


def _integer(value: Any, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise MalformedResponse("Spotify {0} must be an integer".format(name))
    return value


def _artists(value: Any) -> Tuple[SpotifyArtist, ...]:
    return tuple(
        SpotifyArtist(id=_string(_mapping(item, "artist").get("id"), "artist.id"), name=_string(_mapping(item, "artist").get("name"), "artist.name"))
        for item in _list(value, "artists")
    )


def _default_session() -> Any:
    """Import requests only when a real HTTP client is actually required."""
    try:
        import requests
    except ImportError as exc:
        raise ServiceUnavailable("Spotify HTTP support is unavailable") from exc
    return requests.Session()


def path_from_url(url: str) -> str:
    """Keep diagnostics to a non-secret API path, never request headers or query."""
    return urlparse(url).path
