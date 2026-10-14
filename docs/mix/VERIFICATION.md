# Mix verification plan

## Unit tests (offline, in the Nix check phase)

Synthetic stores and libraries only; no network, no Plex, no model weights.

- **Vectors:** stale fingerprint → ineligible; missing `text` vector → ineligible only when steering.
- **Filters:** each exclusion rule, including: `plex_userrating == 0` is kept; `0 < rating <= 4` is dropped; skip rule boundary (`skip=3, view=3` dropped; `skip=3, view=4` kept); `Non-Music---*` top label dropped; adaptive length floor (a seed set of 30 s cues keeps 25 s candidates; a seed set of 3-minute songs drops a 40 s interlude).
- **Version duplicates:** same `mb_trackid` on another album; "Song (Live)", "Song - 2011 Remaster" against "Song"; different songs with a shared prefix not collapsed.
- **Clustering:** two well-separated synthetic blobs (sizes 40/20) → two clusters; single blob → one cluster; singleton merge rule; determinism across runs.
- **Allocation:** largest-remainder with minimum one; clusters > N; shortfall roll-over when an artist cap starves a cluster.
- **Ranking:** a candidate near many seeds outranks one near a single seed; ties deterministic.
- **Steering:** with `w = 0`, order equals unsteered for the same eligible population (supplying steering still requires candidate text vectors, even at zero weight); steering never introduces items outside the pool.
- **Artist cap:** albumartist fallback; cap counted across clusters.
- **Apply:** already-present IDs skipped; non-Plex-linked refused per item; smart playlist and ambiguous title fail the command; a single `addItems` call with IDs in the requested order (Plex client mocked).
- **JSON:** output validates against the documented `beets-mix.proposal.v1` / `beets-mix.apply.v1` shapes; no token in any output or error.

## Hold-out evaluation (on link, real library, read-only)

A dev-only harness (`python -m beets_mix.evaluate`, not a beets subcommand) that answers "is it any good" with a number.

For each evaluation playlist, over 20 seeded random trials:

1. Sort and deduplicate supplied playlist IDs; retain only resolved, current-style-vector IDs for splitting. Hide `max(2, ceil(0.2 * usable_count))`; skip and report trials with fewer than one training seed remaining. Derive playlist/trial streams from SHA-256, not Python hash or input ordering. Fix splits across the complete threshold/K grid and N values.
2. Run the shared `extend` ranking kernel on remaining usable seeds with N = 15 and N = 50. Remove heldouts from remaining originals, but keep all other original rows (including unavailable vectors) as exclusions. Heldouts are ordinary candidates subject to the same natural filters; use training-only length floors and duplicate checks against remaining originals. Load read-only Store data once per evaluation run.
3. Primary **track recall** is recovered hidden IDs / all hidden IDs, including filtered positives in the denominator. Report eligible-only track recall separately (null, with reason, when none are eligible), hidden filter counts, and actual recommendation counts. **Album recall** is unique recovered hidden album keys / all unique hidden album keys; use an optional positive `album_id`, otherwise a unique item-ID fallback.

Compare against two baselines on the same splits:

- **Centroid:** uncapped top-N tracks by cosine to the normalized mean training seed vector, with item-ID ties; a zero mean ties all candidates by ID.
- **Random:** uncapped N eligible tracks uniformly without replacement; an independent playlist/trial stream yields identical draws across grid points and stable prefixes across N.

All methods consume the exact same eligible pool. Baselines are intentionally canonical and uncapped; Mix retains its global artist cap and fixed neighbourhood pools. Disclose this constraint asymmetry rather than silently cap-match baselines. Aggregate trials within each playlist, then macro-average playlist means, excluding nulls with explicit valid/null counts instead of converting them to zero.

The dev-only input is explicit JSON `{items: [complete snapshots, optional album_id], playlists: {name: [local item IDs]}}`, plus a read-only Store path and explicit threshold/K grids. Defaults are 20 trials, RNG seed 0 and N = 15/50; no threshold or K grid is guessed. Rank the **exploratory best observed** grid pair by macro track@15, album@15, track@50, album@50, then smaller threshold and smaller K. This report never changes production defaults or establishes validated tuning from synthetic fixtures.

Evaluation playlists (Plex, manual): `morning eggs` (61), `03 jazz i dig` (101), `park hang` (164), `07 city pop` (93). Use the run to choose `cluster_threshold` and K; record the chosen values and the results table in the implementation PR/commit body and in `plugins/mix/README.md`.

This informs tuning; it does **not** gate the build. Mix should clearly beat random; it's expected, not required, to beat centroid on the most varied playlist.

## Live checks (on link, after deploy)

1. `beet mix-extend --plex-playlist "morning eggs" --json` → valid proposal, 15 items, all Plex-linked, none already in the playlist, elapsed time reported. If over 30 s, open the vector-cache follow-up.
2. Same with `--steer "sleepier"` → still 15, CLAP model ID reported, order differs.
3. Beets-query seed (`artist:Khruangbin`) → proposal without a target.
4. Plex playlist with a duplicated title (`Weekly-Exploration`) → clear ambiguity error.
5. `beet mix-apply` is run **only after Finn approves a specific proposal** in chat. Verify the reported count matches Plex and that rerunning the identical apply reports everything as already present.

## Infra checks

- `nix flake check` and `nix build .#packages.x86_64-linux.default` in this repository (CI parity).
- In infra: the beets config evaluates with `mix` enabled, and the existing beets/embed checks still pass. Run long builds through `agent-run-long`.
