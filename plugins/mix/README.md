# Mix: foundation and phase 2 evaluation harness

An importable, stateless proposal engine over **explicit complete item snapshots**
and supplied seed IDs. It reads current embeddings; it does not import beets UI,
resolve playlists, contact Plex/network services, encode text, write the library
or embedding store, persist proposals, or implement `apply`.

This is not a complete production plugin. An offline evaluation harness is now
available, and the authorized exploratory real-library run completed on
2026-10-15: [dated results](../../docs/mix/EVALUATION.md). Its 0.1/K=200 winner
is not validated production tuning; K remains 100 and threshold explicit.
Beets/Plex adapters, production CLI, apply safety, Nix wiring, skill and
deployment remain pending; no production extend-latency claim is made.

## Reproduce the synthetic tests

From the repository root, in the existing environment (Python 3.14 and its NumPy
are available; the `.venv` Python 3.13 does **not** match this environment's NumPy):

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="plugins/mix:plugins/embed:$PYTHONPATH" python3.14 -m unittest discover -s plugins/mix/tests -v
```

For long validation on Linux, load `agent-run-long` and run that command through
its helper. Full foundation validation is assigned to an independent runner.
The package follows embed's setuptools/Python >=3.13 convention and declares
NumPy and `beets-embed`; it does not add Nix wiring at this phase.

## Exact API

```python
from beets_mix import extend

proposal = extend(
    items, seed_item_ids,                       # full library snapshot, IDs
    store="/path/to/embeddings.sqlite3",        # or protected Store, below
    cluster_threshold=chosen_threshold,        # REQUIRED; no evaluated default
    n=15, k=100,
    playlist_tracks=None,                      # explicit originals, incl. lost seeds
    seed_metadata=None, target_metadata=None,
    style_model_id=None,                       # default current model_ids()['style']
    steer_vector=None, text_model_id=None,      # supplied 512-d vector + exact model ID
    steer=None, steer_weight=0.3, fresh=False,
    max_per_artist=2,
)
payload = proposal.to_dict()                   # independent JSON-ready copy
```

`items` is an iterable of mappings with one row per unique positive integer
`id`. Every row must explicitly contain:

| Fields | Contract |
| --- | --- |
| `id`, `path` | Positive integer ID and stat-able audio path (missing file makes vector unavailable) |
| `artist`, `albumartist`, `title`, `album`, `mb_trackid` | Strings; use `""` for absent albumartist/MBID |
| `year` | Integer or null |
| `length` | Finite nonnegative seconds |
| `plex_ratingkey` | String/integer Plex key or null/empty/zero for unlinked |
| `plex_userrating` | Explicit finite rating in [0,10], zero means unrated |
| `plex_skipcount`, `plex_viewcount` | Explicit finite nonnegative counts |

Unknown item fields are ignored; caller snapshots are not changed. This is not
embed's narrower `snapshot()` contract: a later adapter must provide all fields.
`playlist_tracks` uses the same complete mapping contract and can include tracks
missing from `items` or without vectors. All supplied seed rows present in
`items` are also originals, even if the explicit playlist omits them. Originals
are excluded by ID and version identity regardless of vector availability.
Unresolved IDs and vector losses are reported; zero usable seeds raises
`ValueError`. Seeds are **never** rating/skip/music/length/Plex/text filtered.

`seed_metadata` allows only `source`, `playlist`, `plex_ratingkey`, `unresolved`
(adapter-supplied unresolved metadata list). `target_metadata` allows only
`plex` (boolean, default false), `playlist`, `plex_ratingkey`. `plex=True`
enforces Plex-linked candidates without needing a Plex client. Adapters must
never supply tokens or credentials in descriptive metadata.

Both metadata arguments must be mappings or null. Present `source`, `playlist`,
and unresolved `title` values must be strings (not null); Plex keys must be
strings, integers other than booleans, or null. `unresolved` must be a list of
mappings containing only optional `plex_ratingkey` and `title` fields, with
those same value types. Unknown fields, NaN/nonfinite values, incompatible types
and non-JSON objects are rejected with `ValueError` before store work. Mix copies
metadata mappings, the unresolved list, and each row at ingress; later caller
mutations cannot change a returned proposal. Empty strings and null Plex keys
are valid absent-value representations, not permission to omit snapshot fields.

A store path is opened with `Store(readonly=True)` and closed by the engine.
Upstream Store has **no readonly attribute**; its connection is `Store.db`.
For a supplied Store, enable `store.db.execute("PRAGMA query_only=ON")` before
calling. Unprotected handles are conservatively rejected, including read-only
opened handles whose mode cannot be verified through Python's connection API.
Mix does not toggle caller connection settings or close supplied stores. The
query-only connection guarantees no SQL writes during the proposal call.

Explicit models must be `style:<64 lowercase hex digest>` / `text:<digest>`.
Steering requires an explicit text model ID: that exact ID selects candidate
text vectors, so a different space cannot silently be mixed with the supplied
vector. The caller is responsible for the supplied vector's provenance. Mix
does no encoding. Without steering, text is neither loaded nor required.
`steer` is optional descriptive text only and requires a supplied vector.
Invalid steering vectors raise, including norms below embed's `1e-12`
normalization floor; stored malformed/dimension-mismatched,
nonfinite or zero vectors become unavailable. Integrated fixtures use style
1280/text 512, not toy model dimensions. Loading reuses
`beets_embed.retrieval.available` and `unit` without changing the fingerprint
gate. Style heads come from `Store.heads`; missing/invalid heads do not exclude.
Candidate classifier outputs are consumed transiently: only one deterministic
top style label per available track is retained for the non-music filter. Full
`discogs400` and `moodtheme` distributions are retained only for usable seeds
needed by summaries, so retained full head scores scale with seed count rather
than library count. Equal top scores use the lexicographically smallest label.

## Deterministic pipeline policies

- Candidate filters, in first-reason order: original ID, unavailable required
  vector, version duplicate, unlinked Plex target, `0 < rating <= 4`,
  `skip >= 3 and skip >= view`, top `discogs400` label `Non-Music---*`,
  length below `min(60, .8 * shortest usable style seed length)`.
- Duplicate identity: shared nonempty MBID exactly, otherwise exact normalized
  artist/title **when either ID is absent**. Distinct nonempty IDs are retained.
  Casefold/collapse whitespace; remove recognized bracketed or spaced-dash
  suffixes beginning live, remaster/remastered, demo, acoustic, instrumental,
  radio edit, single version (optional leading year). Keep other parentheses,
  title hyphens and shared prefixes. No fuzzy/prefix match.
- Pure NumPy average-linkage cosine distance, inclusive threshold. Sort seed
  IDs and use lexicographic member IDs to break merge ties. With >=8 usable
  seeds, repeatedly merge the smallest-ID singleton into its nearest
  average-linkage cluster (ties by member IDs), including another singleton if
  needed. Below 8, retain singletons. Final clusters: size descending, IDs.
- Proportional largest-remainder allocation with minimum one: reserve one for
  under-quota clusters and recompute proportional quotas for the rest. If more
  clusters than N, the largest N get one; other shares and pools are zero.
- Exact per-seed top-K, similarity descending then candidate ID. Sum only
  top-K endorsements, divide by full cluster size; support ties use maximum
  similarity to any cluster seed then item ID. Nearest-seed ties use seed ID.
- Every cluster's selection pool is its first `10 * share` supported candidates.
  Steering uses population z-scores inside that fixed pool; constant columns
  yield zero. `w=0` bypasses reranking and exactly preserves unsteered order
  **for the same eligible population** (steering still requires available text).
  Fresh adds 0.1 for viewcount zero within the same pool only; without fresh,
  play history is used only by the eligibility skip rule.
- Global greedy albumartist cap, falling back to artist (casefold/whitespace).
  Only newly proposed tracks count, not playlist artists. Global IDs are unique.
  First preserve all allocated shares, then send shortfalls to the next-largest
  cluster, wrapping to earlier clusters if needed, without reducing other
  shares. Pools are never expanded for shortfalls. Exhaustion returns fewer
  than N. Final order is cluster-largest then its pool rank, numbered from 1.

All initial knobs live in `defaults.py` and are echoed in `params` (threshold
is caller-supplied, not a guessed default). N, K and cap must be positive
integers; threshold is finite [0,2], weight finite [0,1], fresh boolean.

## Proposal v1 shape

`Proposal.to_dict()` returns:

- `schema`: `"beets-mix.proposal.v1"`.
- `seed`: source/playlist/key metadata, `tracks` (distinct originals/seed IDs
  plus adapter-supplied unresolved entries),
  `resolved` (distinct seed IDs present in snapshot), `with_vectors`,
  `unresolved` adapter list, `losses` list of `{item_id, reason}` where reason
  is `unresolved` or `no_vector`.
- `target`: supplied target metadata.
- `clusters`: `{id, size, share, seed_item_ids, selected, top_styles, top_moods}`;
  share is original allocation, selected is actual fill after redistribution.
  Summaries rank average valid seed head scores descending, label tie break;
  at most two labels per head, empty lists if unavailable.
- `proposal`: `{n, item_id, plex_ratingkey, artist, title, album, year, cluster,
  support, nearest_seed: {item_id, title}}` rows. Support is raw cluster support,
  not the calibrated steering score.
- `excluded_counts`: all first-reason filter counts (`in_playlist`,
  `version_duplicate`, `not_plex_linked`, `low_rated`, `skipped`, `non_music`,
  `too_short`, `no_vector`) plus `artist_cap` (unique pool IDs blocked by cap).
  Lost original seed vectors appear in `seed.losses`, not candidate no_vector.
- `params`: n/k/threshold/steer/weight/fresh/cap and named fresh bonus, pool
  multiple, skip/rating boundaries, length constants, singleton boundary,
  head summary limit, z-score epsilon, minimum steering-vector norm.
- `models`: exact style ID and text ID (null when not steering).
- `elapsed_ms`: measured duration; the only intentionally nondeterministic field.

This data seam is suitable for later adapters, not authorization to apply.

## Phase 2: dev-only hold-out evaluation

`python -m beets_mix.evaluate` is an offline development tool, not a beets
subcommand or a playlist resolver. It does not read a beets database, fetch Plex
playlists, encode text, contact services, or accept credentials. Supply a local
JSON export explicitly:

```json
{"items": [{"id": 1, "path": "/local/audio.wav", "artist": "Artist",
  "albumartist": "", "title": "Song", "album": "Album", "year": 2000,
  "length": 180, "mb_trackid": "", "plex_ratingkey": null,
  "plex_userrating": 0, "plex_skipcount": 0, "plex_viewcount": 0,
  "album_id": 10}], "playlists": {"example": [1, 2, 3]}}
```

Include the **complete library candidate snapshot**, not just playlist rows.
Snapshot fields use the exact `extend` contract above; optional `album_id` is
a positive integer or null/absent. Album IDs are captured by the evaluator
before the ordinary snapshot copy discards extra fields. Repeated album IDs
share identity; absent IDs use unique `('item', id)` identities, never a shared
imaginary album. Playlist values must be local positive integer ID lists.
Names and IDs are sorted; duplicate playlist IDs are removed. Unknown playlist
IDs and originals with unavailable style vectors are reported, not fabricated.
The one-row example illustrates the format only and has insufficient usable
seeds to evaluate.

Callable API:

```python
from beets_mix.evaluate import evaluate
result = evaluate(data, store=store_path, thresholds=explicit_threshold_grid,
                  ks=explicit_k_grid, trials=20, seed=0, ns=(15, 50),
                  style_model_id=None)
```

The Store path is opened read-only; supplied Stores need the same query-only
guard as `extend`. Input snapshots and arrays are copied during preparation and
not mutated. Current style vectors and compact candidate head labels are loaded
**once per run**, not once per trial/grid/N. Preparation is ephemeral in-process
data, not a persistent cache. `extend` and evaluation use the same internal
eligibility/proposal kernel; steering/fresh are off and Mix uses its existing
default proposal cap. No alternate ranking implementation is used for Mix.

From the repository root, with available Python 3.14 and NumPy, this illustrative
synthetic grid demonstrates command syntax, **not tuned parameter values**:

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="plugins/mix:plugins/embed:$PYTHONPATH" python3.14 -m beets_mix.evaluate --input evaluation-input.json --store embeddings.sqlite3 --thresholds 0.1 0.2 --ks 50 100 --trials 20 --seed 0 --ns 15 50
```

Both grids are required: there is no guessed default threshold/K grid. The
callable allows other positive N values, but exploratory selection is null if
the required valid Mix metrics at both 15 and 50 are absent. CLI output is one
strict finite JSON object on stdout. Input/store paths and snapshot text/Plex
keys are not echoed. Errors use a generic stderr message and exit 2 without
tracebacks or input values; `--help` explains arguments. Descriptive playlist
names are reported, so callers must not put credentials in names.

### Frozen evaluation protocol and result meaning

- Use sorted unique resolved **current style-vector** playlist IDs. Hold out
  `max(2, ceil(.2 * usable_count))`; skip if fewer than one training seed remains.
  SHA-256 over JSON `[seed, playlist_name, trial_index, stream]` seeds NumPy's
  `default_rng`, with independent `split`/`random` streams. Reordering input does
  not change a run; splits are fixed across grid points and N.
- Remove heldout rows from originals. Exclude **all remaining original rows**,
  including ones without vectors. Only remaining usable seeds determine the
  adaptive floor, clustering, and support. Heldouts are ordinary candidates,
  never forced eligible; duplicate checks consider remaining originals only.
- Mix, centroid, and random share one naturally eligible pool per trial.
  Centroid ranks cosine to the unit-normalized training mean, then item ID;
  a zero mean gives all candidates equal scores. Random uses a uniform
  permutation without replacement and stable prefixes across N/grid points.
  Baselines are explicitly **uncapped**. Mix retains its artist cap and fixed
  pools, so recommendation counts can differ: this is disclosed, not silently
  adjusted. No method pads or repeats IDs.
- Primary track recall = hits / **all hidden IDs**. Filtered positives remain in
  that denominator. Eligible-only recall is a secondary diagnostic, null with
  `no_eligible_hidden_tracks` when its denominator is empty. Album recall counts
  **unique recovered hidden album keys / all unique hidden album keys**; several
  recommendations from one hidden album recover it only once.
- `playlists` reports original/resolved/usable counts, unresolved/no-vector
  IDs/counts and skipped trials. Successful `trials` expose training/hidden/
  remaining-original/eligible IDs, eligible hidden IDs/counts, hidden filter
  reasons, common exclusions, and `results` for each method/N/configuration.
  Each result includes recommendation IDs/count, constraint label, recall/hit
  metrics, album denominator and eligible-recall null reason.
- `summary` reports means over trials within each playlist and equal-weight
  playlist macro means for every method/N/configuration. Every mean carries
  `valid`/`null` counts; nulls and skipped playlists are not coerced to zero.
  Baseline results repeat across configurations to make comparisons explicit.
- `best_observed` ranks macro Mix track@15, album@15, track@50, album@50, then
  smaller threshold and smaller K. It is labeled **exploratory_only**, not a
  validated optimum; no production defaults are changed. Empty evaluation
  sets yield null selection and an explicit reason. Top-level `protocol`,
  `models`, `inputs`, and `skipped_trials` preserve context. There are no timing
  fields in the evaluation result identity.

Offline synthetic regressions cover reproducibility, hidden-positive recovery,
natural losses/denominators, shared pools, baseline asymmetry, kernel parity
against `extend`, one-time preparation, album identity, aggregation and CLI
safety. Full validation belongs to the independent runner. The authorized full
run and its limitations are recorded in the [2026-10-15 results](../../docs/mix/EVALUATION.md);
no validated production knobs or subjective quality claim follow from it.
