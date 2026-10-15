# Mix exploratory hold-out evaluation — 2026-10-15

The authorized full protocol completed on **2026-10-15** at source commit
**`c0186d8bbd2590aa18009fa0c7ab36147bff1d34`**. All 80 trials succeeded.
Threshold **0.1 / K=200** was the **best_observed, exploratory_only** grid point.
At that selected point, macro Mix recall exceeded both supplied baselines on
track and album recall at 15 and 50. This does **not** hold for every playlist
or configuration, establish listening quality, or select a validated production
default. No defaults were changed: **K remains 100 and cluster_threshold remains
explicit, with no invented default**.

## Evidence and reproducibility

This is a durable, aggregate account of the completed run, not a catalog export.
The full result and compact summary were written as strict JSON
(`allow_nan=False`). Evidence artifact **filenames** and SHA-256 identities:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `input.json` | 48,586,937 | `310b509b55c857d4b1205eefc3cae1df256a3e35cd6fee2f821c1f6aa38d2dfb` |
| `full-evaluation-result.json` | 44,398,429 | `30eee4ff7d9ffaff83271636592aa56b8d53d4bc6dce01335660d379605424d1` |
| `full-evaluation-summary.json` | 33,450 | `b61fd0b5ae67a2df13de2a2679032194b7d5e291fa1d0a9deb06d7b084bffcf2` |

These are private scratch artifacts, **not bundled in the repository or
guaranteed to be retained forever**. Hashes identify the captured evidence;
they do not make that data publicly available or reconstruct missing vectors.
The scratch execution driver was `full-evaluation-driver.py`. No raw catalog,
track memberships, recommendation IDs, credentials, or configuration paths are
included here. Numerical tables below use the recorded summary/report values;
recall percentages are displayed to six decimal places, while the full JSON
retains original precision.

Environment and frozen settings:

- Python **3.14.7**, NumPy **2.5.2**; `OPENBLAS_NUM_THREADS=1`,
  `OMP_NUM_THREADS=1`, `PYTHONDONTWRITEBYTECODE=1`.
- Style model:
  `style:beef4902613f2357bc41f5b8a8d24fa73c68dc1a7566ec177b81e471d8c44289`.
- **20 trials** each for `morning eggs`, `03 jazz i dig`, `park hang`, and
  `07 city pop`; RNG seed **0**.
- Threshold grid **0.1, 0.2, 0.3, 0.4**; K grid **50, 100, 200**;
  N **15, 50**. No retries, resampling, grid changes, or extra full runs.
- Complete explicit local snapshot input as described in the
  [library README](../../plugins/mix/README.md#phase-2-dev-only-hold-out-evaluation):
  `{"items": [complete snapshots, optional album_id], "playlists": {name: [local item IDs]}}`.
  Reproduction needs the same captured metadata, audio fingerprint availability
  and model-matched vectors, not just the playlist names or input hash.
- The evaluator opened the supplied Store path with `Store(readonly=True)`
  (SQLite URI `mode=ro`). Independent monitoring used a separate read-only,
  `query_only=ON` connection. Observed schema/model groups, versions,
  `total_changes=0`, and Store size/mtime were unchanged. No whole-database hash
  was taken. There were **no Plex requests or writes**, library/Store mutations,
  model inference, or credential/config access during evaluation.

For a deliberately authorized reproduction with complete explicit local input
and a matching read-only Store, the equivalent dev CLI settings are:

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="plugins/mix:plugins/embed:$PYTHONPATH" OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 agent-run-long --label mix-evaluation-reproduction --timeout 3h -- python3.14 -m beets_mix.evaluate --input evaluation-input.json --store embeddings.sqlite3 --thresholds 0.1 0.2 0.3 0.4 --ks 50 100 200 --ns 15 50 --trials 20 --seed 0 --style-model-id style:beef4902613f2357bc41f5b8a8d24fa73c68dc1a7566ec177b81e471d8c44289
```

The filenames above are placeholders for caller-supplied local artifacts, not
configuration locations. Load the Linux `agent-run-long` workflow and obtain a
new long-run budget before executing; this recipe is **not authorization for
another run**. The historical command used the scratch driver for input guards,
monitoring and summary generation around one actual `evaluate` call. The CLI
emits the full evaluator JSON, not those additional driver artifacts.

### Captured population and mapping losses

The source contained **93,955** items. One ambiguous playlist key matched three
local items, which were globally quarantined rather than arbitrarily resolved:
**93,952** snapshot candidates remained. Runtime fingerprint/stat/numerical
checks found **93,852 available style vectors** in that snapshot.

The captured playlists contained **419 raw track occurrences**. Extraction
retained **364 resolved seed occurrences / 352 distinct local items**, after
**54 unmatched occurrences and one ambiguous selected-playlist key**. The
ambiguous key accounts for the three quarantined local items. All retained
playlist seeds had usable style vectors. The evaluator's zero unresolved and
zero no-vector seed counts describe this already-resolved export; they do not
erase upstream mapping losses or imply evaluation of all 419 raw occurrences.

Extraction preceded evaluation. Read-only guards and unchanged observed counts
do not make extraction, audio stats, Store reads and monitoring one atomic
snapshot. No library or playlist refresh occurred during the run.

## Protocol and denominators

The [frozen protocol](./VERIFICATION.md#hold-out-evaluation-on-link-real-library-read-only)
uses sorted unique current-vector playlist IDs and
`max(2, ceil(0.2 * usable_count))` heldouts. SHA-256-derived playlist/trial split
and random streams fix splits across all grid points and N values. Only
remaining usable seeds determine training, clustering and the adaptive length
floor. Heldouts are removed from original exclusions and treated as ordinary
candidates; all remaining original rows participate in ID/version exclusions.
No hidden positive is forced eligible.

| Playlist | Original/resolved/usable | Training per trial | Hidden per trial | Hidden occurrences: all / eligible / filtered |
| --- | ---: | ---: | ---: | ---: |
| 03 jazz i dig | 96 / 96 / 96 | 76 | 20 | 400 / 380 / 20 |
| 07 city pop | 80 / 80 / 80 | 64 | 16 | 320 / 272 / 48 |
| morning eggs | 50 / 50 / 50 | 40 | 10 | 200 / 196 / 4 |
| park hang | 138 / 138 / 138 | 110 | 28 | 560 / 546 / 14 |
| **Total across trials** | — | — | — | **1,480 / 1,394 / 86** |

All **86 naturally filtered hidden occurrences** were excluded by the history
skip rule (`skipcount >= 3 and skipcount >= viewcount`); other hidden
first-reason exclusions were zero. These are repeated trial occurrences, not
86 distinct tracks. Artist caps operate later on proposals, not on this hidden
eligibility denominator.

- Primary **track recall** divides recovered hidden IDs by **all hidden IDs**
  per trial, including filtered positives. Eligible-only recall remains a
  separate diagnostic, not the primary score or selection objective.
- **Album recall** counts unique recovered hidden album keys / all unique
  hidden album keys. Positive `album_id` defines album identity; absent IDs use
  a unique item fallback. Multiple recommendations from one hidden album count
  only once; an album hit need not be an exact hidden-track hit.
- Trial means are averaged within playlists, then the four playlist means
  receive **equal macro weight**. The tables are **not pooled recall over
  1,480 hidden occurrences**. Nulls are excluded with counts, not coerced to zero;
  all reported macro track/album/count summaries had four valid playlists and
  zero null playlists in this run.
- All methods share each trial's naturally eligible pool. Centroid is canonical
  **uncapped** cosine-to-training-mean top-N; random is **uncapped** uniform
  sampling without replacement. Mix retains its proposal-only global artist
  cap and fixed `10 × share` neighbourhood pools. Fresh and steering were off.
  This disclosed asymmetry is not an isolated ablation of clustering alone.

Observed completion: **80 successful trials, zero skips, 960 configuration-trials,
5,760 method/N result rows, 72 macro summary rows**. Every method filled exactly
N on every result, with no duplicate IDs within a result and no underfilled
outputs. Equal output counts do not remove the constraint asymmetry.

## Complete Mix grid

Values are **percent recall**. T = primary track recall; A = unique hidden-album
recall. Baselines below are identical across configurations because their
populations, splits and rankings are fixed, not retuned.

| Threshold | K | Mix T15 | Mix A15 | Mix T50 | Mix A50 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0.1 | 50 | 6.363839 | 17.846243 | 10.098214 | 27.162861 |
| 0.1 | 100 | 6.468750 | 19.144493 | 10.330357 | 27.997884 |
| 0.1 | 200 | 6.562500 | 19.939619 | 10.352679 | 30.278451 |
| 0.2 | 50 | 5.526786 | 16.757384 | 9.915179 | 26.275120 |
| 0.2 | 100 | 6.136161 | 17.934718 | 8.024554 | 24.269506 |
| 0.2 | 200 | 6.091518 | 19.270664 | 8.450893 | 26.519715 |
| 0.3 | 50 | 4.058036 | 14.071362 | 9.015625 | 23.280517 |
| 0.3 | 100 | 4.013393 | 14.387070 | 5.729911 | 21.298270 |
| 0.3 | 200 | 3.343750 | 15.414706 | 5.073661 | 21.644436 |
| 0.4 | 50 | 4.448661 | 13.025817 | 9.299107 | 24.180481 |
| 0.4 | 100 | 3.013393 | 11.726855 | 6.055804 | 19.506771 |
| 0.4 | 200 | 1.578125 | 9.931542 | 4.156250 | 19.022805 |

### Baseline macro comparison

| Method | T15 | A15 | T50 | A50 |
| --- | ---: | ---: | ---: | ---: |
| Mix, selected 0.1/K=200 | 6.562500 | 19.939619 | 10.352679 | 30.278451 |
| Centroid, uncapped | 2.026786 | 6.214200 | 5.464286 | 17.713090 |
| Random, uncapped | 0.000000 | 0.106431 | 0.044643 | 0.609026 |

The supported claim is **higher macro recall at the selected point on this
captured input**, not superiority at all settings or subjective listening
quality. For example, Mix track recall at threshold 0.4/K=200 is below centroid
at both N values.

## Exploratory selection and heterogeneous outcomes

The frozen lexicographic objective is macro T15, A15, T50, A50, then smaller
threshold and smaller K. `best_observed` returned **0.1/K=200**, status
**exploratory_only**, with no null reason. Its unrounded metric tuple was:

```text
[0.065625, 0.19939618577997734, 0.10352678571428572, 0.3027845055301097]
```

Only one grid point had this tuple; parameter tie-breaks did not determine the
winner. The nearest objective-ranked alternatives were 0.1/K=100, then 0.1/K=50.
The primary T15 lead over K=100 was just **0.093750 percentage points**, as
recorded in the run report. No confidence intervals, significance inference,
independent confirmation dataset or generalization claim were produced.

The winner lies at **both grid edges**: lowest threshold and highest K tested.
It neither demonstrates an interior optimum nor proves a wider grid would
improve results. Selection and assessment used the same data. The pair may be
named an **exploratory follow-up candidate**, not a validated production setting.

Per-playlist means at 0.1/K=200, percent recall:

| Playlist | Method | T15 | A15 | T50 | A50 |
| --- | --- | ---: | ---: | ---: | ---: |
| 03 jazz i dig | Mix | 6.750000 | 17.198009 | 14.250000 | 38.826209 |
| 03 jazz i dig | Centroid | 0.000000 | 0.000000 | 0.000000 | 0.000000 |
| 07 city pop | Mix | 5.000000 | 23.334499 | 13.125000 | 41.984016 |
| 07 city pop | Centroid | 5.000000 | 12.401265 | 8.750000 | 25.120047 |
| morning eggs | Mix | 14.500000 | 35.956349 | 13.500000 | 32.575397 |
| morning eggs | Centroid | 1.500000 | 10.295635 | 11.500000 | 41.123016 |
| park hang | Mix | 0.000000 | 3.269618 | 0.535714 | 7.728180 |
| park hang | Centroid | 1.607143 | 2.159900 | 1.607143 | 4.609296 |

The macro average does not erase these differences:

- **park hang:** Mix track recall trails centroid at both N values, even though
  album recall is higher.
- **morning eggs:** Mix album@50 trails centroid. Mix track@50 is also below its
  track@15: each N has independent allocation, pools, cap competition and
  rollover, so N=15 is **not** a prefix of N=50.

## Runtime and completion boundary

The actual `evaluate` call took **3,208.095399 seconds** (53m28.095s), from
05:37:36.438618 to 06:31:04.534051 UTC on 2026-10-15. The helper's whole-command
elapsed time was **3,214 seconds** (53m34s), including surrounding validation,
guards, serialization and summarization. Process peak RSS recorded immediately
after evaluation, before artifact serialization, was **1,268,192 KiB
(approximately 1.209 GiB)**; this high-water mark includes preceding input
validation and is not kernel-only memory.

This measures the full exploratory evaluator workload, **not a 30-second
production extend-latency proof**, a universal memory bound, or a deployment
benchmark. The run completed its authorized protocol; it did not choose or
change validated production defaults. Final artifact audit and Oracle Gate 4
are separate acceptance work.

Beets/Plex adapters, production CLI, apply/approval safety, Nix packaging, skill
and deployment remain later roadmap work. These results do not authorize those
changes, another live run, or applying any recommendations to a playlist.
