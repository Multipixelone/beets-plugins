"""Candidate-only rules and conservative exact recording identity."""

import re

from . import defaults as d

EXCLUSIONS = ("in_playlist", "version_duplicate", "not_plex_linked", "low_rated",
              "skipped", "non_music", "too_short", "no_vector", "artist_cap")
QUALIFIER = re.compile(r"^(?:\d{4}\s+)?(?:live|remaster(?:ed)?|demo|acoustic|instrumental|radio edit|single version)(?:\b.*)?$", re.I)


def normalize(value):
    value = str(value or "").casefold()
    previous = None
    while previous != value:
        previous = value
        value = re.sub(r"\(([^()]*)\)|\[([^\[\]]*)\]",
                       lambda m: " " if QUALIFIER.fullmatch((m[1] if m[1] is not None else m[2]).strip()) else m[0], value)
        parts = re.split(r"\s+[-–—]\s+", value)
        if len(parts) > 1 and QUALIFIER.fullmatch(parts[-1].strip()):
            value = " - ".join(parts[:-1])
        value = " ".join(value.split())
    return value


def duplicate(left, right):
    a, b = left["mb_trackid"], right["mb_trackid"]
    if a and b:
        return a == b
    return (normalize(left["artist"]), normalize(left["title"])) == (normalize(right["artist"]), normalize(right["title"]))


def artist_key(track):
    return " ".join((track["albumartist"] or track["artist"]).casefold().split())


def filter_candidates(tracks, *, playlist_tracks, vectors, text_vectors=None,
                      top_styles=None, plex_target=False, shortest_seed_length):
    counts = dict.fromkeys(EXCLUSIONS, 0)
    originals = {t["id"] for t in playlist_tracks}
    floor = min(d.LENGTH_MAX_FLOOR, d.LENGTH_SEED_RATIO * shortest_seed_length)
    eligible = []
    for track in sorted(tracks, key=lambda t: t["id"]):
        item_id = track["id"]
        top = (top_styles or {}).get(item_id, "")
        if item_id in originals:
            reason = "in_playlist"
        elif item_id not in vectors or (text_vectors is not None and item_id not in text_vectors):
            reason = "no_vector"
        elif any(duplicate(track, original) for original in playlist_tracks):
            reason = "version_duplicate"
        elif plex_target and not track["plex_ratingkey"]:
            reason = "not_plex_linked"
        elif 0 < track["plex_userrating"] <= d.LOW_RATING_MAX:
            reason = "low_rated"
        elif track["plex_skipcount"] >= d.SKIP_MIN and track["plex_skipcount"] >= track["plex_viewcount"]:
            reason = "skipped"
        elif top.startswith("Non-Music---"):
            reason = "non_music"
        elif track["length"] < floor:
            reason = "too_short"
        else:
            eligible.append(track)
            continue
        counts[reason] += 1
    return eligible, counts
