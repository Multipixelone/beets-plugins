# Mix domain language

- **Seed playlist** — the playlist being extended. Its tracks, resolved to beets items, are the **seeds**.
- **Seed source** — where seeds come from. v1: a Plex playlist (by title) or a beets query. The engine itself only ever sees a list of beets item IDs.
- **Target** — the playlist that approved tracks are appended to. In v1 the target is always the seed playlist itself; Mix never creates a copy such as `morning eggs +`.
- **Style vector** — the 1280-d Discogs-EffNet track embedding (`style:<digest>` model in the store). Drives "sounds like".
- **Text vector** — the 512-d AMCLAP embedding (`text:<digest>` model). Shares a space with encoded text, so a phrase can steer results.
- **Heads** — per-track classifier scores stored alongside the style vector: `discogs400` (genre/style), `moodtheme`, `instrument`, `approachability`, `engagement`.
- **Available vector** — a vector whose stored fingerprint (path, size, mtime) matches the file on disk now, exactly as `beets_embed.retrieval.available` decides. Stale or missing vectors make a track ineligible; they are never recomputed by Mix.
- **Cluster** — a group of seeds that sound alike, found by clustering the seed playlist's own style vectors. Not the album-graph viewer's "sound communities", which are album-level, computed in the browser, never persisted, and cover only the exported albums.
- **Share** — the number of proposed tracks allocated to a cluster, proportional to its size, minimum one.
- **Support** — how strongly a candidate is endorsed by a cluster: the sum of its similarity to each seed in that cluster whose nearest neighbours include it.
- **Steer** — an optional free-text phrase ("sleepier", "more brass") that re-ranks candidates by text-vector similarity without escaping the playlist's neighbourhood.
- **Proposal** — the numbered, ordered list of suggested tracks returned by `extend`. Proposals are not stored anywhere.
- **Apply** — appending an approved subset of a proposal (by beets item ID) to the target.
- **Plex-linked** — a beets item with a `plex_ratingkey` flexible attribute (written by `plexsync`). Only Plex-linked items can be applied to a Plex target.
- **Version duplicate** — a candidate that is another release of a recording already in the playlist (live, remaster, compilation): same `mb_trackid`, or same normalized artist + title when either lacks one.
