# Mix verification plan

## Phase 3A read-only command integration

Source-level `mix-extend` passed independent offline validation and its review gate:
119 Mix tests, 25 embed core tests and 13 isolated actual CLI cases.
[Setup and output semantics](../../plugins/mix/README.md#phase-3a-read-only-mix-extend)
describe explicit threshold/K flags, source namespace paths and the worker now
wired by phase 4. Read-only extend remains unchanged by the phase 3B entry point.

Focused mocked command checks cover inert import/construction, exactly-one-source
and finite knob validation before command I/O, preserved native query tokens,
complete snapshot/query capture and library close before all external boundaries,
real synthetic Store/engine query composition, query isolation from Plex/worker,
Plex occurrence counts/global collision quarantine, safe connection/read/cleanup
errors, strict JSON and ordinary grouped text output. CLI `elapsed_ms` includes
composition, unlike the unchanged pure API engine timer. Independent validation
must cover persisted numeric Plex history with Mix-only configuration (including
normal populated nonseeds, strict malformed-value rejection and bounded raw
reads), plus pre-bound standard/native beets handlers, `extra_debug` and exact
guard restoration on success/error/interruption. Independent validation
must retain all helper/kernel/evaluator regressions. No live connection, worker
inference, playlist mutation or deployment is authorized by these mocked checks.

## Phase 3B explicit-ID apply

Source-level `apply`/`ApplyResult` and `mix-apply` are implemented against the
frozen client seams. Combined validation passed 161 Mix and 25 embed core tests,
plus 12 isolated real-CLI/PlexAPI fake-HTTP scenarios. Gate 6 identified a
scope-entry interruption cleanup defect. Its correction passed 74 independent
focused transport/API/CLI tests, and Gate 6 accepted the re-review. The earlier
full-suite and process-probe evidence was reused, not rerun. No live playlist
mutation is authorized.

- Identity/request validation before client I/O; full-library canonical key
  collisions including off-playlist rows; ordered deduplication, missing/unlinked
  refusals and owned output; no engine/history/vector eligibility recheck.
- Fresh exact/manual/audio/same-server target, fail-closed malformed current
  entry keys, all track preflight before one ordered append, fixed per-item
  refusal reasons, all-present/all-refused zero-write results.
- Scoped exact-origin/path one-use PUT in the transport; revocation on all
  exits, no ambient write capability, redirect/proxy/TLS/retry policy retained.
- Fresh original-key/title post-read, per-key Counter increases, actual observed
  length including concurrent additions, partial/missing/failing/interrupted
  writes or observation as `write_outcome_unknown`, never an inferred success or
  automatic retry. Sequential idempotence only; no atomic concurrency claim.
- Real temporary-library identity-only raw snapshots (bad unrelated history
  must not block apply), bounded pages, duplicate raw attributes fail closed,
  read-only SQL dumps and close-before-config/client. No Store/worker settings,
  full history snapshot, path stats, worker or extend calls in apply.
- Strict JSON/text/no-op/mixed refusal output, safe sentinel failures and
  supported standard/native logging restoration; only command registration
  assertions in prior tests change from one command to two.

Independent evidence includes actual isolated CLI and installed PlexAPI/fake-HTTP
probes for ordered one-PUT dispatch, permission revocation, unknown outcome and
no host data/service access. Entry fault-injection tests cover partial permission
installation, interruption before the scope body, zero unauthorized dispatches
and subsequent deliberate append on the same open client.
[Full contract](../../plugins/mix/README.md#phase-3b-explicit-id-mix-apply).
Installed packaging/skill evidence, deployment and separately approved live apply
are not covered by these source-level tests.

## Phase 4 repository packaging and skill (accepted)

The [self-contained skill](../../skills/mix/SKILL.md), synthetic prompt fixtures
and durable stdlib-only checks under `skills/mix/tests/` are repository artifacts.
Repository packaging and skill delivery are complete: **Gate 7 accepted and
structure review PASS**. Validation establishes **x86_64-linux only**; incompatible
non-x86 systems were omitted, not validated. Earlier 161-Mix/25-embed (186 total)
tests, 12 CLI/SDK fake-HTTP cases and 74 focused cleanup tests remain historical
phase-3 evidence, not new phase-4 coverage.

Both explicit CI commands passed:

```sh
nix flake check --print-build-logs
nix build .#packages.x86_64-linux.default --print-build-logs --no-link
```

The final standard flake check passed in **76 seconds**, with **164 freshly run
Mix tests, zero failures/errors/skips**, a built/installed wheel, successful
runtime-dependency, import and metadata hooks, and the complete installed check.
The separate exact default build passed in **4 seconds**, legitimately reusing
the matching already-built output, not replaying those tests. Its derivation
was `q7lmaf8z39fnws0vxrxvc04lxxihq82s-python3.14-beets-63b69fa.drv`, with output
`cm84z30sc9bc07a251lly7a68iyrm8d3-python3.14-beets-63b69fa` under `/nix/store`.
The upstream beets dependency separately reported **2667 passed, 163 skipped,
3 deselected, 225 warnings**; these are not extra Mix tests or a zero-skip closure.
Earlier cache-failure and obsolete false-smoke-guard reports remain retained as
historical failures, not rewritten successes.

Independent static authoring check (eight checks previously passed):

```sh
PYTHONDONTWRITEBYTECODE=1 python3 skills/mix/tests/test_contract.py -v
```

The test entry point also accepts absolute `--skill` and `--cli` source paths.
It checks the generated YAML scalar format, self-containment, registered CLI
flags via AST, explicit protocol clauses and synthetic approval arithmetic.
It does not import/run the CLI or prove agent behavior. The three realistic
prompts in `skills/mix/evals/evals.json` are not executed by these checks;
separate offline simulated-tool evidence consists of six fake-tool text traces
for three paired cases. Independent grading found **9/9 assertions, 3/3 cases
with the skill**, versus **7/9 assertions, 2/3 cases without it**. This is not real
CLI/OpenClaw runtime, statistical compliance or prompt-injection proof. The
graded traces predate the renderer-stable ordinal clarification; no new model
test of that formatting is claimed. The fixture JSON remains plans, not results.
Required cases include proposal-only initial requests, imperative metadata,
original-number subset mapping, absent threshold/context, changed targets,
query's empty target, and no retry after uncertain/nonzero apply outcomes.

The installed check used built outputs, not checkout PYTHONPATH, and verified
module origins, four callable public exports and both commands. Pure imports
and plugin construction/registration were inert under **SQLite-connect DENY and
Popen DENY**, leaving no catalog/music state. Real native beets help children
opened **only the explicitly configured disposable database**: after each,
`items=0` and `albums=0`, with no music directory. JSON separately reports
`import_constructor_library_io=false` and
`native_cli_disposable_library_opened=true`; help is not globally database-free.

The exact shared absolute worker path and executable metadata were verified:
`/nix/store/x6i44rznh4fvglbl04lyc639iwb1r92z-beets-embed-worker/bin/beets-embed-worker`.
It was **never executed**; no worker probe, model load or inference was performed.
Realizing the existing worker closure may fetch existing pinned runtime/model
assets; no new model pins were introduced. No host deployment, workspace skill
installation/activation, OpenClaw runtime, live Plex apply, production latency or
tuning claim follows. K remains 100 and the threshold explicitly user-chosen.

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

**2026-10-15 status:** The authorized full 20-trial/four-playlist protocol
completed with zero skips; [dated results and reproducibility](./EVALUATION.md)
record the exploratory 0.1/K=200 winner, not validated production defaults.
The historical playlist counts below precede mapping/quarantine losses; the
report gives actual evaluated populations. K remains 100 and threshold explicit.

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

These are future separately authorized checks, not part of phase-4 execution.
The example threshold **0.25 is illustrative and user-chosen, not a production
default**; substitute Finn's explicit value or an applicable already approved
context value. Missing threshold requires clarification, not exploratory tuning.

1. `beet mix-extend --cluster-threshold 0.25 --plex-playlist "morning eggs" --json` → valid proposal with actual returned count/losses, all proposed tracks Plex-linked and absent from the playlist, elapsed time reported. If over 30 s, open the vector-cache follow-up.
2. Same with `--steer "sleepier"`, only with matching configured worker readiness → text model ID reported; inspect the actual resulting proposal rather than assuming exactly N picks.
3. Beets-query seed (`artist:Khruangbin`) → proposal without a target.
4. Plex playlist with a duplicated title (`Weekly-Exploration`) → clear ambiguity error.
5. `beet mix-apply` is run **only after Finn subsequently approves a specific proposal/subset** in chat. Check added/already-present/refused outcomes and the actual observed count. No automatic rerun follows an uncertain or nonzero outcome; sequential-repeat/idempotence checks remain synthetic unless a further live write is separately authorized. The CLI resolves by title, not by an expected proposal-key argument; known key/title mismatch stops the workflow, and a returned-key mismatch requires inspection, not correction/retry.

## Infra checks

- `nix flake check` and `nix build .#packages.x86_64-linux.default` in this repository (CI parity).
- In infra: the beets config evaluates with `mix` enabled, and the existing beets/embed checks still pass. Run long builds through `agent-run-long`.
