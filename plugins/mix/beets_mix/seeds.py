"""Pure seed translation; no vector, database, or Plex calls."""

from copy import deepcopy
from dataclasses import dataclass

from .plex import canonical_key


@dataclass(frozen=True)
class SeedResolution:
    items: list[dict[str, object]]
    seed_item_ids: list[int]
    playlist_tracks: list[dict[str, object]]
    seed_metadata: dict[str, object]
    target_metadata: dict[str, object]
    diagnostics: dict[str, object]


def from_plex(items, playlist_snapshot):
    rows = deepcopy(list(items))
    groups = {}
    for row in rows:
        key = canonical_key(row.get("plex_ratingkey"))
        row["plex_ratingkey"] = key
        if key is not None:
            groups.setdefault(key, []).append(row)
    collisions = {key: group for key, group in groups.items() if len(group) > 1}
    quarantined = sorted({row["id"] for group in collisions.values() for row in group})
    quarantine = set(quarantined)
    unresolved, ambiguous, unmapped, seed_ids = [], [], [], []
    seen_ids = set()
    resolved_occurrences = 0
    raw = 0
    for entry in playlist_snapshot.entries:
        raw += 1
        key = canonical_key(entry.get("plex_ratingkey"))
        title = entry.get("title", "")
        safe = {"plex_ratingkey": key, "title": title if type(title) is str else ""}
        group = groups.get(key, [])
        if len(group) != 1:
            unresolved.append(safe)
            (ambiguous if len(group) > 1 else unmapped).append(dict(safe))
        else:
            resolved_occurrences += 1
            item_id = group[0]["id"]
            if item_id not in seen_ids:
                seen_ids.add(item_id)
                seed_ids.append(item_id)
    if not seed_ids:
        raise ValueError("No resolved seed items") from None
    kept = [row for row in rows if row["id"] not in quarantine]
    by_id = {row["id"]: row for row in kept}
    playlist = {"playlist": playlist_snapshot.title,
                "plex_ratingkey": canonical_key(playlist_snapshot.plex_ratingkey)}
    return SeedResolution(kept, seed_ids, [deepcopy(by_id[i]) for i in seed_ids],
        {"source": "plex", **playlist, "unresolved": deepcopy(unresolved)},
        {"plex": True, **playlist},
        {"raw_entries": raw, "resolved_occurrences": resolved_occurrences,
         "resolved_unique": len(seed_ids),
         "duplicate_resolved_occurrences": resolved_occurrences - len(seed_ids),
         "unresolved_count": len(unresolved), "unresolved": unresolved,
         "ambiguous_count": len(ambiguous), "ambiguous": ambiguous,
         "unmapped_count": len(unmapped), "unmapped": unmapped,
         "quarantined_item_ids": quarantined, "quarantined_count": len(quarantined),
         "ambiguous_key_count": len(collisions)})


def from_query(items, seed_ids):
    rows = deepcopy(list(items))
    by_id = {row["id"]: row for row in rows}
    ids = []
    seen_ids = set()
    for item_id in seed_ids:
        if type(item_id) is not int or item_id <= 0:
            raise ValueError("Invalid seed item ID") from None
        if item_id in by_id and item_id not in seen_ids:
            seen_ids.add(item_id)
            ids.append(item_id)
    if not ids:
        raise ValueError("No resolved seed items") from None
    return SeedResolution(rows, ids, [deepcopy(by_id[i]) for i in ids],
                          {"source": "query"}, {},
                          {"resolved_unique": len(ids), "quarantined_count": 0,
                           "quarantined_item_ids": []})
