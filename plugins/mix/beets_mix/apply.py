"""Stateless explicit-ID append over an injected, validating client.

No beets UI, PlexAPI, library, vector, or service work occurs at import time.
The transport owns media/server validation and its one-use write capability.
"""

from collections import Counter
from collections.abc import Mapping
from copy import deepcopy
from dataclasses import dataclass


@dataclass
class ApplyResult:
    data: dict[str, object]

    def to_dict(self):
        return deepcopy(self.data)


def _requested(item_ids):
    try:
        values = list(item_ids)
    except Exception:
        raise ValueError("Expected explicit item IDs") from None
    if not values or any(type(i) is not int or i <= 0 for i in values):
        raise ValueError("Expected nonempty positive integer item IDs") from None
    return list(dict.fromkeys(values))


def _identities(items, canonical_key):
    try:
        rows = list(items)
    except Exception:
        raise ValueError("Invalid identity snapshot") from None
    identities, groups = {}, {}
    for row in rows:
        if not isinstance(row, Mapping) or "id" not in row or "plex_ratingkey" not in row:
            raise ValueError("Incomplete identity snapshot") from None
        item_id = row["id"]
        if type(item_id) is not int or item_id <= 0 or item_id in identities:
            raise ValueError("Identity snapshot requires unique positive integer IDs") from None
        key = canonical_key(row["plex_ratingkey"])
        # Canonical immutable scalars are owned; no caller row or extra metadata
        # (potentially containing live objects) is retained or exposed.
        identities[item_id] = {"id": item_id, "plex_ratingkey": key}
        if key is not None:
            groups.setdefault(key, []).append(item_id)
    return identities, groups


def _playlist_counts(snapshot, title, canonical_key, *, expected_key=None):
    from .plex import PlexError

    try:
        key = canonical_key(snapshot.plex_ratingkey)
        if type(snapshot.title) is not str or snapshot.title != title or key is None:
            raise ValueError
        if expected_key is not None and key != expected_key:
            raise ValueError
        entries = snapshot.entries
        if not isinstance(entries, (tuple, list)):
            raise ValueError
        keys = []
        for entry in entries:
            if not isinstance(entry, Mapping):
                raise ValueError
            entry_key = canonical_key(entry.get("plex_ratingkey"))
            if entry_key is None:
                raise ValueError
            keys.append(entry_key)
        return key, Counter(keys), len(keys)
    except Exception:
        raise PlexError("invalid_playlist") from None


def apply(items, item_ids, *, client, plex_playlist):
    """Append an explicitly approved ordered subset once, then observe fresh data.

    items is the complete current identity-only snapshot, not engine/history
    input. Sequential repeats skip existing keys; concurrent atomicity and
    causal attribution of post-read counts are not guaranteed.
    """
    from .plex import PlexError, canonical_key

    requested = _requested(item_ids)
    if type(plex_playlist) is not str or not plex_playlist.strip() or "\x00" in plex_playlist:
        raise ValueError("Expected a nonblank playlist title") from None
    identities, groups = _identities(items, canonical_key)
    try:
        initial = client.playlist(plex_playlist)
    except PlexError as error:
        raise PlexError(error.code if type(error.code) is str else "read_failed") from None
    except Exception:
        raise PlexError("read_failed") from None
    original_key, initial_counts, observed_count = _playlist_counts(initial, plex_playlist, canonical_key)
    already_present, refused, accepted, tracks = [], [], [], []
    for item_id in requested:
        identity = identities.get(item_id)
        key = identity["plex_ratingkey"] if identity is not None else None
        if identity is None:
            reason = "item_not_found"
        elif key is None:
            reason = "not_plex_linked"
        elif len(groups[key]) != 1:
            reason = "ambiguous_plex_link"
        elif initial_counts[key]:
            already_present.append(item_id)
            continue
        else:
            try:
                track = client.track(key)
                if track is None:
                    raise ValueError
            except Exception as error:
                code = error.code if isinstance(error, PlexError) and type(error.code) is str else None
                reason = code if code in ("wrong_server", "wrong_media_type", "track_identity_mismatch") else "plex_track_unavailable"
            else:
                accepted.append((item_id, key))
                tracks.append(track)
                continue
        refused.append({"item_id": item_id, "reason": reason})
    if accepted:
        try:
            client.append(initial, list(tracks))
            fresh = client.playlist_by_key(original_key, expected_title=plex_playlist)
            _, fresh_counts, observed_count = _playlist_counts(fresh, plex_playlist, canonical_key, expected_key=original_key)
            if any(fresh_counts[key] <= initial_counts[key] for _, key in accepted):
                raise ValueError
        except (Exception, KeyboardInterrupt, SystemExit):
            # No success result, corrective append or retry after any uncertain
            # write/observation, including interruption after mutation.
            raise PlexError("write_outcome_unknown") from None
    return ApplyResult({"schema": "beets-mix.apply.v1", "playlist": plex_playlist,
        "plex_ratingkey": original_key, "added": [item_id for item_id, _ in accepted],
        "already_present": already_present, "refused": refused,
        "playlist_tracks_after": observed_count})
