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

1. Hide 20% of the playlist's resolvable tracks (minimum 2).
2. Run `extend` on the remaining tracks with N = 15 and N = 50, treating hidden tracks as eligible candidates.
3. Record **track recall** (hidden tracks proposed) and **album recall** (a proposed track shares an album with a hidden one) at 15 and 50.

Compare against two baselines on the same splits:

- **Centroid:** top-N tracks by cosine to the mean seed vector (what `beet similar` does, at track level).
- **Random:** N eligible tracks uniformly at random.

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
