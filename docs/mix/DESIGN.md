# Mix v1 design

## Goal

Given a seed playlist, propose N tracks from the local beets library that sound like what's already in it — respecting the playlist's internal variety — and, after explicit human approval, append the approved ones to that same playlist.

First real use: extend the Plex playlist `morning eggs` (manual, 61 tracks, Plex ratingKey `183285` as of 2026-10-13).

## Non-goals

- **Anything outside the library, ever.** No Explo/slskd/streamrip discovery, no "tracks to download". Every candidate must already have available vectors; a download path would introduce un-embedded tracks into the ranking. See [ADR 0001](./adr/0001-library-only.md).
- A UI, HTTP server, or long-running process. The library API is the seam a later UI will wrap.
- New playlists from a text description, or from a single seed song. The engine must support these (it takes arbitrary seed item IDs and an optional text vector) but v1 exposes only _extend_.
- Sequencing, transitions, or weaving new tracks into the existing order. Finn listens on shuffle; new tracks are appended.
- Remembering rejections. Finn removes unwanted tracks himself. No state file of any kind.
- MPD playlists as seed or target. Later.
- Recomputing embeddings. Mix is read-only against the embedding store and the beets library.
- An approximate-nearest-neighbour index or vector cache. Exact search over ~94k vectors is the baseline; add a cache only if verification shows `extend` exceeding 30 s on `link`.

## Facts this design relies on (verified 2026-10-13)

- Embedding store: `~/.local/share/beets/embeddings.sqlite3`, schema v1 (`vectors`, `models`), read via `beets_embed.store.Store(readonly=True)`. 93,783 items have both a `style` (1280-d, `<f2`) and a `text` (512-d) vector; the library has 93,955 items.
- Vector availability is fingerprint-gated (`beets_embed.retrieval.available`): a retag that changes mtime makes the vector unavailable until the nightly backfill re-embeds it. Mix reuses this rule unchanged.
- `beet similar` already exists but ranks albums against the **mean** of all seeds. Mix exists because a centroid of a varied playlist lands between its strands.
- Text encoding is available offline via the packaged worker: `beets-embed-worker encode-text --device cpu --manifest phrases.json` prints one 512-d vector per phrase.
- `plexsync` writes `plex_ratingkey`, `plex_userrating` (0–10; 0 = unrated), `plex_skipcount`, `plex_viewcount` as flexible attributes. 87,171 items are Plex-linked. Ratings in practice: 79,313 unrated, 7,853 at 10, 5 tracks between 1 and 8. Skip counts: 81,464 at 0, long tail to 10.
- `mb_trackid` is present on 93,813 / 93,955 items.
- 7,435 items are shorter than 60 s (many are VGM cues), so a fixed 60 s floor would wrongly gut VGM playlists.
- Plex connection details live in the beets `plex:` config (`host`, `token`), included from the `beets-plex` agenix secret. `plexapi` is already in the beets closure via `plexsync`.

## Packaging and layout

New plugin in this repository, following `plugins/embed/`'s shape:

```
plugins/mix/
  default.nix            # buildPythonPackage; depends on beets-embed (store/retrieval), numpy, plexapi
  pyproject.toml
  beets_mix/             # importable library — no beets UI, no printing
    seeds.py             # resolve seed sources -> item IDs (Plex playlist, beets query)
    vectors.py           # load available style/text vectors via beets_embed
    cluster.py           # seed clustering
    rank.py              # per-cluster support scoring, steering, diversity caps
    filters.py           # eligibility filters
    plex.py              # read playlist items, append items
    api.py               # extend(...) -> Proposal ; apply(...) -> ApplyResult
  beetsplug/mix/__init__.py   # thin beets plugin: subcommands, option parsing, JSON output
  tests/
skills/mix/SKILL.md      # Kestrel skill, symlinked into the OpenClaw workspace (see below)
```

Wire into `flake.nix` like `embed` (package, `pluginOverrides`, default bundle). Infra then bumps the `beets-plugins` input and adds `"mix"` to `programs.beets.settings.plugins` on link; that activation goes through the normal link deploy gate.

`beets_mix.api` is the contract a future UI or service calls. The beets plugin is one client of it.

## Commands

### `beet mix-extend`

```
beet mix-extend (--plex-playlist TITLE | QUERY...) [-n 15] [--steer TEXT]
                [--steer-weight 0.3] [--fresh] [--max-per-artist 2] [--json]
```

- Exactly one seed source: `--plex-playlist "morning eggs"` or a beets query (`artist:Khruangbin year:2015..`).
- With a beets-query seed there is no implicit target; output still includes `plex_ratingkey` so a caller can apply to any Plex playlist.
- Read-only. Never writes to Plex, beets, or the store.
- `--json` prints the proposal (schema below); without it, a numbered human-readable table.

### `beet mix-apply`

```
beet mix-apply --plex-playlist TITLE ITEM_ID... [--json]
```

- Appends the given beets item IDs, in the given order, to the end of the Plex playlist.
- Stateless: takes item IDs, not a proposal ID. Partial approval ("all except 3 and 7") is done by the caller passing only the wanted IDs.
- Re-reads the playlist first and skips IDs already present (so a stale or repeated apply is idempotent).
- Refuses smart playlists, ambiguous titles (more than one playlist with that title — e.g. `Weekly-Exploration` exists three times), and non-Plex-linked items; reports each refusal per item rather than failing the batch, except the playlist-level ones, which fail the command.

## Pipeline (`extend`)

1. **Resolve seeds.** Plex: fetch playlist items, map `ratingKey` → beets item via `plex_ratingkey`. Report unmapped seeds; do not fail unless zero seeds resolve. Query: beets items matching.
2. **Load vectors.** All available style vectors for the library (seeds + candidates), unit-normalized, f32. Seeds without available vectors are reported and dropped from clustering.
3. **Eligibility filters** (candidates only; seeds are never filtered):
   - available style vector (and text vector when steering);
   - not already in the playlist, and not a version duplicate of a playlist track (`mb_trackid` first, else normalized artist + title: casefold, strip bracketed/after-dash qualifiers such as "live", "remaster", "demo", collapse whitespace);
   - Plex-linked when the target is Plex;
   - not low-rated: `0 < plex_userrating <= 4` (≤ 2 stars; 0 means unrated and is kept);
   - not habitually skipped: `plex_skipcount >= 3 and plex_skipcount >= plex_viewcount` (tunable);
   - not non-music: top `discogs400` label in the `Non-Music---*` family;
   - not too short: `length < min(60 s, 0.8 × shortest seed)` is excluded — adaptive so short-track VGM playlists stay eligible.
4. **Cluster the seeds.** Average-linkage agglomerative clustering on cosine distance over seed style vectors, cut at a distance threshold (initial value chosen by the hold-out evaluation, recorded in code with the evaluated value). Singleton clusters merge into their nearest cluster unless the playlist has fewer than 8 seeds. Pure numpy; seed counts are small.
5. **Allocate shares.** N picks split across clusters proportional to cluster size by largest-remainder rounding, minimum one per cluster; if clusters > N, the largest N clusters get one each.
6. **Score candidates per cluster.** For every seed, exact top-K (K = 100, tunable) nearest candidates by cosine. A candidate's support in cluster C is the sum of its similarity to each seed in C whose top-K contains it, divided by |C|. Ties break on max single-seed similarity, then item ID (determinism).
7. **Steer (optional).** Encode `--steer` with the packaged worker (`encode-text`, CPU). Within each cluster's top pool (10 × share), re-rank by `(1 − w) · z(support) + w · z(text cosine)` using z-scores within the pool, `w = --steer-weight` (default 0.3). Steering only reorders the neighbourhood pool; it can't pull in tracks the seeds don't endorse.
8. **Fresh (optional).** `--fresh` adds a bonus for `plex_viewcount == 0` inside the same pool re-rank. Without it, play history is ignored.
9. **Diversity.** Greedy fill per cluster in rank order with a global cap of `--max-per-artist` (default 2, by `albumartist` falling back to `artist`), counting tracks already in the playlist toward the cap only for the purpose of the proposal (an artist with 6 playlist tracks can still get 2 new ones). If a cluster can't fill its share under the caps, the shortfall rolls to the next-largest cluster.
10. **Order the proposal** by cluster (largest first), then rank. Number from 1.

Every tunable has a named default in one module (`beets_mix/defaults.py`) and is echoed in the JSON `params`.

## Proposal JSON

```json
{
  "schema": "beets-mix.proposal.v1",
  "seed": {"source": "plex", "playlist": "morning eggs", "plex_ratingkey": 183285,
           "tracks": 61, "resolved": 60, "with_vectors": 60,
           "unresolved": [{"plex_ratingkey": 123, "title": "..."}]},
  "clusters": [{"id": 0, "size": 24, "share": 6,
                "top_styles": ["Electronic---Downtempo", "Jazz---Bossa Nova"],
                "top_moods": ["calm", "relaxing"]}],
  "proposal": [{"n": 1, "item_id": 4242, "plex_ratingkey": 98765,
                "artist": "...", "title": "...", "album": "...", "year": 1999,
                "cluster": 0, "support": 0.71, "nearest_seed": {"item_id": 17, "title": "..."}}],
  "excluded_counts": {"in_playlist": 61, "version_duplicate": 4, "not_plex_linked": 0,
                      "low_rated": 0, "skipped": 12, "non_music": 3, "too_short": 40,
                      "no_vector": 0, "artist_cap": 9},
  "params": {"n": 15, "k": 100, "cluster_threshold": 0.0, "steer": null,
             "steer_weight": 0.3, "fresh": false, "max_per_artist": 2},
  "models": {"style": "style:<digest>", "text": null},
  "elapsed_ms": 0
}
```

`nearest_seed` is there so a caller can explain a pick ("because of X").

## Apply JSON

```json
{"schema": "beets-mix.apply.v1", "playlist": "morning eggs", "plex_ratingkey": 183285,
 "added": [4242], "already_present": [], "refused": [{"item_id": 7, "reason": "not_plex_linked"}],
 "playlist_tracks_after": 75}
```

## Concurrency and safety

- Beets library: read through a read-only snapshot the same way `embed` does; no import lock, no writes.
- Embedding store: `Store(readonly=True)`.
- Plex: `extend` only reads. `apply` performs exactly one `addItems` call for the non-refused IDs. No removals, reorders, or edits of any kind, so the worst case of a bad apply is a few extra tracks Finn deletes in Plexamp.
- Plex token comes from beets config; never printed, never in JSON or errors.

## Kestrel skill

`skills/mix/SKILL.md` lives in this repository and is symlinked into the OpenClaw workspace (`~/.openclaw/workspace/skills/mix -> <checkout>/skills/mix`), the same pattern as `commutecompass`. It must be self-contained: no relative links outside `skills/mix/`, no assumption about the checkout path.

Behaviour it encodes:

- Triggers: "add more like <playlist>", "N more for <playlist>", "extend <playlist>", with optional steer phrasing ("sleepier", "more brass", "fresh ones").
- Run `beet mix-extend --plex-playlist … --json`, send Finn a compact numbered list (artist — title, grouped by cluster with its top style), then stop.
- On "add" / "all" / "all but 3, 7" / "only 1–5": compute the ID subset from the proposal still in context and run `beet mix-apply`. Report the one-line result. Never apply without that reply.
- If the proposal is no longer in context, rerun `extend` rather than guess IDs.
- Never offers downloads, never edits other playlists.

Workspace-side follow-ups (outside this repository): create the symlink and add a routing row to `SKILLS.md`.

## Implementation order

1. `beets_mix` library with fixtures (no Plex, no beets UI): vectors, filters, cluster, rank, api.
2. Hold-out evaluation harness (see [VERIFICATION.md](./VERIFICATION.md)); tune `cluster_threshold`, K.
3. Plex read path; `mix-extend` command.
4. Plex write path; `mix-apply` command.
5. Nix packaging and flake wiring; CI checks.
6. `skills/mix/SKILL.md`.
7. Infra: input bump + enable plugin on link (separate infra change, deployed through the gate).
