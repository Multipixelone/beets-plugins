"""Read-only MusicBrainz discovery primitives for Harmony."""

from __future__ import annotations

from dataclasses import dataclass
import time
from typing import Any, Callable, Mapping, Optional, Sequence, Tuple

from .errors import DeadlineExceeded, LookupAmbiguous, MalformedResponse, ServiceUnavailable
from .spotify_api import canonical_album_url, parse_album_reference

MUSICBRAINZ_API = "https://musicbrainz.org/ws/2"
POLL_OFFSETS = (0.0, 2.0, 5.0, 10.0, 20.0, 30.0, 60.0, 120.0)
DEFAULT_USER_AGENT = "beets-harmony/1.0 (+https://github.com/multipixelone/beets-plugins)"


@dataclass(frozen=True)
class MusicBrainzRelease:
    id: str
    title: str
    artist: Optional[str]
    date: Optional[str]
    barcode: Optional[str]
    spotify_urls: Tuple[str, ...]
    raw: Mapping[str, Any]


def canonical_spotify_url(reference: str) -> str:
    return canonical_album_url(parse_album_reference(reference))


def release_has_spotify_url(release: MusicBrainzRelease, spotify_url: str) -> bool:
    wanted = canonical_spotify_url(spotify_url)
    for resource in release.spotify_urls:
        try:
            if canonical_spotify_url(resource) == wanted:
                return True
        except Exception:
            continue
    return False


class MusicBrainzClient:
    """Serial, rate-aware client. It never chooses an indexed result itself."""

    def __init__(
        self,
        session: Optional[Any] = None,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleeper: Callable[[float], None] = time.sleep,
        timeout: float = 10.0,
        min_interval: float = 1.0,
        user_agent: str = DEFAULT_USER_AGENT,
    ) -> None:
        self._session = session if session is not None else _default_session()
        self._clock = clock
        self._sleeper = sleeper
        self._timeout = timeout
        self._min_interval = min_interval
        self._user_agent = user_agent
        self._last_request_at: Optional[float] = None

    def related_release_ids(self, spotify_url: str, *, deadline: Optional[float] = None) -> Tuple[str, ...]:
        resource = canonical_spotify_url(spotify_url)
        payload = self._get_json(
            "/url", {"resource": resource, "inc": "release-rels", "fmt": "json"},
            deadline=deadline, absent_on_404=True,
        )
        if payload is None:
            return ()
        relations = _list(payload.get("relations"), "relations")
        ids: list[str] = []
        for relation in relations:
            relation_map = _mapping(relation, "relation")
            release = relation_map.get("release")
            if not isinstance(release, Mapping):
                continue
            release_id = release.get("id")
            if isinstance(release_id, str) and release_id and release_id not in ids:
                ids.append(release_id)
        return tuple(ids)

    def get_release(self, mbid: str, *, deadline: Optional[float] = None) -> MusicBrainzRelease:
        if not mbid or "/" in mbid:
            raise MalformedResponse("MusicBrainz release ID is invalid")
        payload = self._get_json(
            "/release/{0}".format(mbid),
            {"inc": "artist-credits+recordings+url-rels", "fmt": "json"},
            deadline=deadline,
        )
        assert payload is not None
        return _release_from_payload(payload)

    def validated_related_releases(
        self, spotify_url: str, validator: Callable[[MusicBrainzRelease], bool], *, deadline: Optional[float] = None
    ) -> Tuple[MusicBrainzRelease, ...]:
        wanted = canonical_spotify_url(spotify_url)
        valid = []
        for mbid in self.related_release_ids(wanted, deadline=deadline):
            self._remaining_timeout(deadline)
            release = self.get_release(mbid, deadline=deadline)
            self._remaining_timeout(deadline)
            if release_has_spotify_url(release, wanted) and validator(release):
                valid.append(release)
        return tuple(valid)

    def find_linked_release(
        self, spotify_url: str, validator: Callable[[MusicBrainzRelease], bool], *, deadline: Optional[float] = None
    ) -> Optional[MusicBrainzRelease]:
        valid = self.validated_related_releases(spotify_url, validator, deadline=deadline)
        if len(valid) > 1:
            raise LookupAmbiguous("more than one MusicBrainz release passed validation")
        return valid[0] if valid else None

    def poll_for_submitted_release(
        self,
        spotify_url: str,
        validator: Callable[[MusicBrainzRelease], bool],
        *,
        poll_timeout: float,
        offsets: Sequence[float] = POLL_OFFSETS,
    ) -> Optional[MusicBrainzRelease]:
        """Poll at absolute offsets, never extending the caller's deadline."""
        started = self._clock()
        deadline = started + max(0.0, poll_timeout)
        for offset in offsets:
            target = started + max(0.0, offset)
            now = self._clock()
            if target > deadline or now >= deadline:
                break
            if now < target:
                self._sleeper(target - now)
            if self._clock() >= deadline:
                break
            try:
                found = self.find_linked_release(spotify_url, validator, deadline=deadline)
            except DeadlineExceeded:
                return None
            if found is not None:
                return found
        return None

    def search_indexed_releases(
        self,
        *,
        barcode: Optional[str] = None,
        artist: Optional[str] = None,
        title: Optional[str] = None,
        date: Optional[str] = None,
        limit: int = 25,
        deadline: Optional[float] = None,
    ) -> Tuple[MusicBrainzRelease, ...]:
        """Return a fully hydrated candidate set for later validation.

        A deadline failure aborts rather than returning a partial set, since a
        partial fallback result can never establish a unique release.
        """
        terms = []
        if barcode:
            terms.append("barcode:{0}".format(_lucene(barcode)))
        if artist:
            terms.append('artist:"{0}"'.format(_lucene(artist)))
        if title:
            terms.append('release:"{0}"'.format(_lucene(title)))
        if date:
            terms.append("date:{0}".format(_lucene(date)))
        if not terms:
            return ()
        payload = self._get_json(
            "/release",
            {
                "query": " AND ".join(terms),
                "limit": max(1, min(limit, 100)),
                "offset": 0,
                "fmt": "json",
            },
            deadline=deadline,
        )
        assert payload is not None
        results = _list(payload.get("releases"), "releases")
        result_count = payload.get("count")
        offset = payload.get("offset")
        if (
            isinstance(result_count, bool)
            or not isinstance(result_count, int)
            or result_count < 0
            or isinstance(offset, bool)
            or not isinstance(offset, int)
            or offset != 0
            or result_count != len(results)
        ):
            raise LookupAmbiguous("MusicBrainz indexed fallback result set is incomplete")
        releases = []
        for result in results:
            self._remaining_timeout(deadline)
            result_map = _mapping(result, "indexed release")
            release_id = _string(result_map.get("id"), "indexed release.id")
            releases.append(self.get_release(release_id, deadline=deadline))
            self._remaining_timeout(deadline)
        return tuple(releases)

    def validated_indexed_releases(
        self, candidates: Sequence[MusicBrainzRelease], validator: Callable[[MusicBrainzRelease], bool]
    ) -> Tuple[MusicBrainzRelease, ...]:
        return tuple(candidate for candidate in candidates if validator(candidate))

    def _get_json(
        self, path: str, params: Mapping[str, Any], *, deadline: Optional[float] = None,
        absent_on_404: bool = False,
    ) -> Optional[Mapping[str, Any]]:
        self._wait_for_rate_limit(deadline)
        timeout = min(self._timeout, self._remaining_timeout(deadline))
        try:
            response = self._session.request(
                "GET",
                MUSICBRAINZ_API + path,
                params=dict(params),
                headers={"Accept": "application/json", "User-Agent": self._user_agent},
                timeout=timeout,
            )
        except Exception as exc:
            raise ServiceUnavailable("MusicBrainz request failed: {0}".format(type(exc).__name__)) from exc
        self._last_request_at = self._clock()
        status = getattr(response, "status_code", None)
        if status == 404 and absent_on_404:
            return None
        if not isinstance(status, int) or status < 200 or status >= 300:
            raise ServiceUnavailable("MusicBrainz returned HTTP {0}".format(status))
        try:
            payload = response.json()
        except Exception as exc:
            raise MalformedResponse("MusicBrainz returned malformed JSON") from exc
        self._remaining_timeout(deadline)
        return _mapping(payload, "response")

    def _wait_for_rate_limit(self, deadline: Optional[float]) -> None:
        self._remaining_timeout(deadline)
        if self._last_request_at is None:
            return
        remaining = self._min_interval - (self._clock() - self._last_request_at)
        if remaining > 0:
            if deadline is not None and remaining >= self._remaining_timeout(deadline):
                raise DeadlineExceeded("MusicBrainz rate wait exceeds lookup deadline")
            self._sleeper(remaining)
            self._remaining_timeout(deadline)

    def _remaining_timeout(self, deadline: Optional[float]) -> float:
        if deadline is None:
            return self._timeout
        remaining = deadline - self._clock()
        if remaining <= 0:
            raise DeadlineExceeded("MusicBrainz lookup deadline reached")
        return remaining


def _release_from_payload(payload: Mapping[str, Any]) -> MusicBrainzRelease:
    artist_credit = payload.get("artist-credit")
    names = []
    if isinstance(artist_credit, list):
        for credit in artist_credit:
            if isinstance(credit, Mapping) and isinstance(credit.get("name"), str):
                names.append(credit["name"])
                if isinstance(credit.get("joinphrase"), str):
                    names.append(credit["joinphrase"])
    urls = []
    for relation in _list_or_empty(payload.get("relations")):
        if not isinstance(relation, Mapping):
            continue
        url = relation.get("url")
        if isinstance(url, Mapping) and isinstance(url.get("resource"), str):
            urls.append(url["resource"])
    return MusicBrainzRelease(
        id=_string(payload.get("id"), "release.id"),
        title=_string(payload.get("title"), "release.title"),
        artist="".join(names) or None,
        date=payload.get("date") if isinstance(payload.get("date"), str) else None,
        barcode=payload.get("barcode") if isinstance(payload.get("barcode"), str) else None,
        spotify_urls=tuple(urls),
        raw=payload,
    )


def _lucene(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _mapping(value: Any, name: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise MalformedResponse("MusicBrainz {0} must be an object".format(name))
    return value


def _list(value: Any, name: str) -> Sequence[Any]:
    if not isinstance(value, list):
        raise MalformedResponse("MusicBrainz {0} must be a list".format(name))
    return value


def _list_or_empty(value: Any) -> Sequence[Any]:
    return value if isinstance(value, list) else ()


def _string(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise MalformedResponse("MusicBrainz {0} must be a non-empty string".format(name))
    return value


def _default_session() -> Any:
    """Keep mocked clients importable before packaging supplies requests."""
    try:
        import requests
    except ImportError as exc:
        raise ServiceUnavailable("MusicBrainz HTTP support is unavailable") from exc
    return requests.Session()
