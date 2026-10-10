# Album graph timeline handoff

Status: **documentation only**, revised 2026-10-10 to reconcile Oracle's final artifact review. No
timeline feature exists; nothing here is shipped or claimed working. The user's standing
correction: **albums outside the selected snapshot disappear** (no dimming), and the histogram is
stacked and colored by the kinds of music added in each bin. The design below is a recommended
default, not user-approved beyond §1. Audience: Sol (implementing agent) and the validation owner.
Read [AGENTS.md](../AGENTS.md) before editing. Related context:
[album-graph-readability-handoff.md](album-graph-readability-handoff.md) (do not modify it).

## Opening instruction for Sol (paste-ready)

```text
Implement the album timeline for the beets album graph viewer, following
docs/album-graph-timeline-handoff.md in this repo. Read that handoff and AGENTS.md fully before
editing. Core requirement: a bottom tray holds a stacked histogram of albums added over time —
each bin's height is how many albums were added then, stacked and colored by their sound-community
groups using the same musical color mapping as the graph. A single playhead sets a cutoff date:
the graph then shows the library as it stood at that date — albums added later disappear entirely,
along with their incident links. Scrubbing backward removes future additions; forward brings them
back. The cutoff composes with existing search/lens/filter/phrase visibility (it only hides, never
reveals), positions and camera stay frozen while historical comparison is active, and albums keep
their musical colors. Start with Phase 0 (pure timeline.mjs binning/membership module plus tests —
add ./timeline.mjs to the fileset in viewer/default.nix; ./tests is already included), then
Phase 1 (tray, stacked histogram, playhead, composed cutoff visibility, map freeze), with
keyboard/touch/ARIA as required MVP scope. All UI work is in plugins/embed/viewer/; the exporter
already provides album.added. Run `npm test` in plugins/embed/viewer and report which acceptance
tests pass.
```

## 1. User requirements (what was asked)

1. A small bottom tray for scrolling through the beets library in chronological order.
2. A histogram showing when most albums were added.
3. **Core:** the graph shows the library **at that snapshot of time** — albums added after the
   selected date disappear (with their links). The timeline is colored with the albums as they
   were added, so one can see **when and what kind of music** was added. The user explicitly
   rejected dimming: “it should show my library at that snapshot of time.”

Everything else in this document is a recommended default, not a user requirement.

## 2. Recommended design defaults (proposal, open to change)

### 2.1 Snapshot model: one cumulative cutoff

- A single playhead position **T**, or the explicit **unbounded** state (“Latest”, the default).
  Unbounded is a distinct state, never represented as a finite cutoff at the last bin: membership
  rules and counts differ, and the End key selects the **final dated bin**, which is not Latest.
- With a cutoff, an album belongs to the snapshot iff it has a valid `added` and `added < T`
  (strict, half-open — consistent with binning, §4). Selecting UTC date D sets T to midnight of
  the **next** UTC day (exclusive), so the whole selected day is included.
- The playhead may sit **before the first dated bin** — an empty snapshot is an MVP state with an
  explanatory readout, not an error.
- Scrubbing backward removes later additions; forward restores them; earlier albums always remain.
  One boundary only: a cumulative cutoff, not a range filter.
- Albums outside the snapshot **disappear completely** — node gone, incident links gone — through
  the existing filter-hiding mechanism (§5). **Do not build a dimming or emphasis layer.**
- Albums with null/invalid/unparseable `added` have no knowable historical membership: hidden in
  any historical snapshot, surfaced as one “undated” count, visible again at Latest. This is
  independent of the existing “Include unknown” checkbox, which covers sound/Essentia unknowns
  only (app.mjs:766) — do not reuse it for dates.

### 2.2 Historical mode: guard, normalize, native suspension

“Pause the physics” is not sufficient on its own, and the Pause button's lifecycle belongs to the
user. Enter historical mode in this order:

1. **Engage the guard first.** Suppress auto-fits (`fitVibeMatches` app.mjs:464, `layoutGather`
  :532, invoked from `updateSearch` at :815) and every simulation start (`reheat` :448, drag
   starts :897/:906/:914, gather orbit start :915, `updateGatherPhysics` start :508). Guard all
   worker-result starts and artwork/layout/render-setting reheats too: edge changes may update
   graph data and community stacks, but must not start physics or replace the frozen pose.
   Disable the Pause button while historical. Explicit drag changes only the dragged album's
   baseline; it must not restart whole-map physics. Clear
  `initialFitPending` and invalidate pending autofit callbacks (the codebase already uses
  generation guards for stale async work, e.g. app.mjs:512).
2. **Normalize Gather synchronously.** If gather is active *or mid-return*, cancel its frame and
   transitions, restore saved canonical coordinates **without animation or fit**, clear the orbit,
   and keep hidden albums absent. Plain `endGather()` (app.mjs:554) is insufficient: it
   early-returns unless gather is active, and otherwise animates the return and can trigger a fit
   (app.mjs:523). Establish the baseline pose **after** this normalization.
3. **Suspend natively.** Save the user's `paused` setting and whether the simulation was actually
   running, then call `graph.pause()`. Do **not** change `enableSimulation` and do **not** drive
    the Pause button (app.mjs:1053–1057) — it retains the user's setting but is disabled here.

While historical: both Gather controls and their activation handlers (app.mjs:486–493 refresh,
:1027–1033) stay unavailable even when `updateGatherControls` re-runs. Explicit user Fit, pan, or
zoom is a deliberate exception; explicit dragging moves albums and legitimately changes their
baseline coordinates.

On Latest: apply the unbounded visibility **with the guard still active** (no fit), then restore
prior physics by calling native `graph.unpause()` **only if**
the simulation was running on entry; never auto-gather. Resumed motion after exit is expected —
measure the restored pose before resuming. The pinned Cosmos dependency exposes `unpause()`
(`dist/index.d.ts:652`); unlike the viewer's current `graph.start(0.3)` resume path, it does not
reheat/reset simulation progress. Restore the Pause button's availability on exit.

**Stability promise:** world coordinates of every album plus camera center/zoom stay constant
across scrubs. Screen pixels are *not* promised: opening the selection card resizes the canvas
(style.css:111, :143).

### 2.3 One temporal composition, applied to the whole selection object

Wrapping `visibleAlbum` alone is insufficient: consumers read `selection.active`, `.states`,
`.visibleIndices`, `.matches` and `.vibeActive` (app.mjs:134, :600–617, :786–792). Define one
helper, e.g. `applyTimeline(selection, temporal)` in `timeline.mjs`, that derives a consistent new
selection object, flags included:

```text
temporal[i]  = unbounded OR (added[i] valid AND added[i] < T)      // hard eligibility
states[i]    = { ...states[i], visible: states[i].visible && temporal[i],
                 match: states[i].match && temporal[i],
                 opacity: (states[i].visible && temporal[i]) ? states[i].opacity : 0 }
return { ...selection, states,
         active: selection.active || historicalMode,   // labels/edges respond to the cutoff alone
         filterActive: selection.filterActive,
         vibeActive: selection.vibeActive,
         visibleIndices/matches recomputed from the new states }
```

`active` must become true under a lone cutoff: edge styling only receives the visibility array
when `selection.active` is set (app.mjs:605), and label tracking branches on it (:134) — otherwise
a cutoff would hide nodes but leave edges and labels unfiltered. The cutoff is **hard
eligibility**; phrase salience stays **soft emphasis** (vibe opacity): a salient album after T is
hidden, not dimmed. `size`/`baseSize`/`strength` are never touched — a lens resizes albums and
would change geometry; the cutoff must not. Clearing search/lens/filters recomputes
`selectionState` and then **reapplies the same cutoff**; async phrase completion lands in
`updateSearch` (app.mjs:72), so it reapplies the cutoff the same way. If the cutoff hides the
selected album, clear selection and details (pattern at app.mjs:783).

### 2.4 Musical color policy: communities only in MVP

- While historical, **always** use the sound-community mapping (`cluster`, index.html:151) for
  graph nodes and histogram segments — even if the user's grouping is Style, Mood, Flavor, Genre,
  Album artist, Year, or Decade. Save the current grouping on entry, **disable the grouping
  dropdown while historical**, and restore the saved grouping on Latest. Alternate musical
  mappings are future work (§3), not an MVP choice.
- Outside historical mode the histogram is labeled “Sound communities” and reflects the community
  partition; graph and histogram hues are guaranteed equal only while the graph is itself in
  community mode.
- The partition is computed across the **full export**, independent of visibility: colors are
  stable across scrubs and filter changes. Community identifiers are grouping keys, not display
  labels. Cover display is unchanged.
- When edge controls recompute the partition (existing behavior), **rebuild per-bin stack
  membership and counts and recolor graph and histogram together**; bin boundaries, per-bin total
  heights, and the y-scale stay fixed (§2.5). Stability is promised only within a fixed partition.

### 2.5 Stacked histogram, playhead, counts, reset

- One bin per calendar interval; **bin height = albums added in that bin** (additions, never the
  cumulative total), stacked per community segment with the community mapping, stable segment
  order (§12).
- Bin boundaries, domain, and y-scale are computed **once per export load** and stay fixed while
  scrubbing, filtering, or searching. Stack membership/colors rebuild only on repartition (§2.4).
- Two distinct counts, always labeled. **Snapshot** (time only): export albums with valid
  `added < T` — at Latest, all `data.albums`, undated included. **Shown on map**: composed
  `states.visible` (time ∧ hard filters) — eligibility on the map, not the current viewport, and
  phrase salience does **not** reduce it; salient matches (`states.match`) may additionally be
  reported, optionally. Both counts use `data.albums.length` as denominator; `summary` fields are
  informative, not required.
- The readout also carries the **scope label** (§4): the timeline covers the albums in this
  export, not the whole beets library.
- **Latest** removes **only the temporal restriction** and recomputes under the **current**
  filters (which may have changed while historical); it restores the saved grouping and the saved
  physics state, and makes Gather available again without auto-gathering. Do not promise a return
  to the exact pre-timeline state.

## 3. Not MVP / future choices

- Two-ended range brush showing **only** a period — later, clearly separate from the cutoff model.
- Style/mood/flavor-tinted timelines (musical mappings other than sound communities).
- Chronological album strip (Phase 3, optional): lists the selected bin's additions; browsing
  only, never flips the graph to period-only. Items hidden by current filters are not actionable
  graph targets — mark them disabled or omit them (§12).
- Top-N-groups + “Other” stack aggregation if segments become unreadable; unsnapped scrub;
  histogram height scale toggle.

## 4. Data contract

- **Source field:** schema-v3 album rows carry `added` — an ISO-8601 UTC string ending in `Z`,
  possibly with fractional seconds (`utc_timestamp` uses `datetime.isoformat()`,
  graph_export.py:66–73), or `null` (README.md:96–110). The viewer consumes the **string or
  null**, never a Unix number.
- **Strict parsing, once:** validate with an explicit shape
  (`YYYY-MM-DDTHH:MM:SS[.fff…]Z` only) and a real-calendar check. Bare `Date.parse` accepts
  timezone-less, numeric, and calendar-rollover strings (e.g. Feb 31) — anything outside the
  strict shape counts as **undated** (nonfatal), same as null/missing/legacy values. Parse once at
  load; bin in UTC milliseconds.
- **Meaning:** beets' default `added` is database insertion time; the importadded plugin can
  instead set it from the oldest track file's mtime, ignoring directory mtimes and skipping
  reimports (citations §11). Dates mean “added to the beets library” and may reflect a migration
  or re-import, not true acquisition. UI copy: “Added to library”.
- **Scope (say it in the UI):** `data.albums` is the **export-selected, embeddable album set** —
  the export pools only query-selected albums that have current vectors (graph_export.py:221–242;
  `summary.skipped_albums` counts the rest, :310–311). It is not the whole surviving beets
  library; `library.albums` in the same file is (README.md:116–123). Timeline, histogram, and
  snapshot counts describe the export set. Label it, e.g. “of the 2,719 albums in this export”.
- **Not historic:** every album's metadata, plays, size, community, and links are **current**
  values; snapshots reconstruct visibility only. Deleted albums and historical metadata edits are
  unrecoverable. The map is the **induced subgraph of the current graph** — similarities are not
  recomputed for earlier line-ups, so old albums may appear isolated in early snapshots; that is
  acceptable, not a bug. Library stats panels stay current export-time stats.
- **Not this:** `library.computed_at` records when the current whole-library statistics were
  computed for this export (README.md:116–123) — it is not a per-album added date.
  `release.original_year`/`year` are never fallbacks for `added`.
- **Older exports:** v1/v2 or early v3 without `added` are valid; the tray shows its empty state
  and the graph is untouched.

## 5. Verified integration points (checked against source 2026-10-10)

All viewer paths are under `plugins/embed/viewer/`:

| Location | Role for this feature |
| --- | --- |
| `sound.mjs:53–85` `selectionState` | Builds `{active, filterActive, vibeActive, states, visibleIndices, matches}`. Keep pure; compose the cutoff outside it into every field, flags included (§2.3). |
| `app.mjs:42–44` `visibleAlbum` | Downstream gate for info, lists, covers, labels, hover — correct once states are composed. |
| `app.mjs:758–815` `updateSearch` | Shared recompute flow: selection rebuild (:763), composed `visible` map (:769), indexed `vibeGraph.positions(changes, {visibility: true})` (:777), hidden-selection clear (:783), count label (:788), auto-fit/gather call (:815) the guard suppresses (§2.2). |
| `app.mjs` `reheat`, drag/orbit starts, worker results, `resizeArtwork`, layout/render handlers | Guard every start/reheat while historical (§2.2). Native `graph.unpause()` resumes only if previously running; do not reuse `start(0.3)` for exact restoration. |
| `app.mjs:1053–1057` Pause button handler | User-owned lifecycle. Historical mode does **not** use it and does **not** touch `enableSimulation` — native `graph.pause()` only (§2.2). |
| `app.mjs:486–493` `updateGatherControls`, `:1027–1033` activation handlers, `:554` `endGather`, `:523` post-restore fit | Gather machinery to disable and to normalize synchronously on entry; `endGather` alone animates and can early-return (§2.2). |
| `visibility.mjs:2–18` `FilterPositions` | Hidden nodes become NaN and skip forces while keeping saved coordinates; visible nodes still simulate — hence native suspension. |
| `visibility.mjs:55` `edgeStyles(…, {visible, …})` | `eligibleLink` skips links with a hidden endpoint: incident links disappear with their albums. |
| `app.mjs:123–131` `updateColors` / `:780` `dropHidden` | Hidden albums render at alpha 0; hidden covers dropped. No separate dim layer. |
| `index.html:150–158` grouping options | `cluster` is the only timeline mapping in MVP; the dropdown is disabled while historical (§2.4). |
| `app.mjs:580` `albumButton` / `app.mjs:628` `showInfo` (rejects hidden at :629) | Strip building blocks; hidden-album clicks already rejected. |
| `app.mjs:817` `load(exported, …)` | Reset timeline state here: parse dates, build bins/stacks, clear cutoff, caches, and pending callbacks. |
| `style.css:110–143` | `#graph` is `touch-action: none` (:110); `.map-footer`/`.map-toolbar` sit bottom-left/right (:112–113); media queries reposition them and resize the canvas with the selection card (:111, :133–143). The tray must coexist with all of this (§6). |
| `app.mjs:16` `reducedMotion` + `style.css:145` | Existing reduced-motion pattern; scrub show/hide is instant under it. |
| `library-stats.mjs:79–83` `addedDate` | Existing display-only `added` formatting guard — superseded for binning by the strict parser (§4). |
| Exporter/tests | `beets_embed/graph_export.py:66–73`, `:221–242`, `:273`, `:310–311`; README.md:96–110, :116–123; `viewer/tests/library-stats.test.mjs:98`; `plugins/embed/tests/test_graph_export.py:81–109`. Viewer tests: `npm test` in `plugins/embed/viewer`. |
| Packaging | Add **`./timeline.mjs`** to the `default.nix:5–11` fileset; `./tests` is already included recursively, so the new test needs no entry. A missing imported module **fails the bundle build** — verify with `nix build .#beets-album-graph` at implementation time. |

Note: the working tree currently carries **uncommitted, in-flight details-panel work** (`showInfo`
header, `library-stats.mjs` helpers, `style.css` facts layout). References above were re-verified
against that state on 2026-10-10; expect line numbers to drift — match by function/rule name.

Note: the documented local data `beets-album-graph/albums.json` + `covers/` is **absent in this
checkout**. Before browser work, generate an export (`beet embed-graph-export` per
plugins/embed/README.md) or build a synthetic fixture with varied `added` dates; do not claim the
data is available.

## 6. Interaction and accessibility (MVP — required, not optional polish)

- **Tray layout:** a bottom bar with the stacked histogram, playhead, snapshot readout, and a
  Latest/reset control. It must displace neither `.map-footer` (status) nor `.map-toolbar`
  (navigation) — adjust those anchors rather than overlap them — and respect the mobile media
  queries (style.css:133–143) and label obstacles. On narrow screens it stacks below the toolbar.
- **Touch isolation:** pointer/touch gestures on the tray must not pan or zoom the graph
  (`#graph` is `touch-action: none`; give the tray its own touch handling and stop propagation).
- **Keyboard:** playhead focusable; Left/Right move one bin, Home jumps before the first bin,
  **End selects the final dated bin** (not Latest), and Escape means Latest. The Escape handler is
  scoped to the timeline so it cannot swallow other existing Escape behaviors.
- **Accessible values:** explicitly label the playhead “Library snapshot date”; its value/readout
  exposes the selected UTC date (or Latest) and snapshot count. Provide accessible text for the
  selected bin's total additions and per-community names/counts, not just colors or hover tooltips.
- **Announcements:** the readout is a live region with **bounded** updates — announce the cutoff
  date on bin changes, not on every pointermove during a drag (throttle/debounce). Precedent:
  `#library-count` already uses `role="status"` (index.html:101). Focus stays where the user put
  it — scrubbing never moves focus.
- **Reduced motion:** appear/disappear is instant under `prefers-reduced-motion` (existing
  `reducedMotion ? 0 : …` pattern); no animated transitions.
- **Strip (if built):** items hidden by current filters are disabled or omitted — never listed as
  if clickable.

## 7. Empty and edge states

- Playhead before the first dated bin (MVP state): graph empty, page alive; readout “No albums
  yet — first addition Jan 2019”.
- Zero-addition bins (quiet periods): drawn at zero height, selectable; snapshot matches the
  previous bin's end.
- All albums share one date (fresh import/migration): one tall stacked bin; copy explains the span
  honestly.
- Export without `added`, or every album undated: tray shows “No albums in this export have an
  added date.”; graph unchanged.
- Early snapshots may show isolated albums (their current neighbors didn't exist yet) — expected,
  not an error state (§4).
- Scrubbing the selected album out of the snapshot clears selection and details (§2.3).

## 8. Performance

- Parse dates and build bins/stacks once per export load: O(albums), trivial at 6,400-album scale.
- A scrub applies the composed visibility and the indexed
  `vibeGraph.positions(changes, {visibility: true})` path (app.mjs:777) with its exit/picking
  invalidation — no whole-positions replacement or reseed, no similarity recompute, no physics
  restart. The existing bounded atlas/cache reconciliation may proceed as usual; do not add
  synchronous atlas construction to the scrub handler.
- Snapped scrubbing makes updates discrete; throttle drags to one update per animation frame and
  live-region posts to one per bin change.
- Histogram DOM stays ≤ a few hundred elements; no chart library, no virtualization.

## 9. Phased implementation plan

1. **Phase 0 — pure logic.** New `viewer/timeline.mjs`: strict `added` parsing, adaptive UTC
   binning, per-bin per-community stacks, half-open membership, cumulative counts, cutoff
   composition (`applyTimeline`). New `viewer/tests/timeline.test.mjs`. **Add `./timeline.mjs` to
   the `default.nix:5–11` fileset** (`./tests` is already included). No DOM. Validate: `npm test`.
2. **Phase 1 — tray, histogram, playhead, cutoff, freeze.** Markup in `index.html`, styling in
   `style.css`, wiring in `app.mjs`: composed visibility in the shared recompute flow, stacked
   bars with the community mapping, click/drag playhead snapped to bins, snapshot/shown counts,
   scope label, Latest reset, selection clearing, the historical guard (§2.2), grouping
   save/disable/restore (§2.4). Phase 1 alone is not release-ready. Validate: `npm test`, then the AGENTS.md
   packaged-viewer + Chrome workflow once export data exists (§5 note).
3. **Phase 2 — interaction (required for MVP).** Keyboard (including End/Escape semantics), touch
   isolation, ARIA, bounded announcements, reduced-motion audit.
4. **Phase 3 — optional chronological strip.** The selected bin's additions (reusing
   `albumButton`); clicks route through `focusAlbum` (guards `visibleAlbum`, app.mjs:591–592);
   filtered-out items disabled or omitted. Browsing only — the graph stays cumulative.
5. **Phase 4 — optional.** Two-ended period-only brush (separate mode), other musical mappings,
   top-N stack aggregation, unsnapped scrub.

Final validation is owned by the parent at implementation time: the repo-required
`nix flake check --print-build-logs` and `nix build .#packages.x86_64-linux.default
--print-build-logs`, in addition to the targeted `nix build .#beets-album-graph` and `npm test` in
`plugins/embed/viewer`.

## 10. Acceptance tests

- Membership: `added < T` strictly; selecting UTC date D cuts off at midnight of the next UTC day
  (exclusive); a timestamp exactly on a bin edge falls in the later bin. Unbounded is distinct
  from any finite cutoff; End selects the final dated bin; Escape (scoped to the timeline) means
  Latest; the before-first position yields the empty snapshot.
- Strict parsing: fractional-second `Z` strings accepted; timezone-less, numeric, malformed, and
  Feb-31-style rollover strings become undated (nonfatal); nothing throws on legacy exports.
- Scrub backward: albums after T **and their incident links** disappear; forward: they reappear at
  **identical world coordinates**; camera center/zoom unchanged (measured backward, forward, and
  at Latest). Entry pose is measured **after** Gather normalization; exit pose is measured at
  Latest **before** resumed physics advances; resumed motion afterwards is expected. An explicit
  drag changes an album's baseline; explicit Fit/pan/zoom are deliberate exceptions. No per-scrub
  simulation pause/resume — exactly one native pause on entry, one resume on exit, and only if the
  simulation was running.
- Composition everywhere: hidden albums stay out of picking, dragging, labels, search results,
  Surprise (`$('surprise')`), related-album lists (`showInfo`), and Gather; the cutoff never
  reveals anything; a lone cutoff still filters edges and labels (`active` flag, §2.3); clearing
  search/lens/filters keeps the cutoff; async phrase completion while historical reapplies the
  cutoff and triggers no auto-fit or camera move.
- Undated: hidden in historical snapshots, included in the undated count, visible at Latest;
  unaffected by the sound “Include unknown” checkbox.
- Selection: a selected album scrubbed out of the snapshot clears selection and details.
- Counts: snapshot (time only; at Latest includes undated) and shown-on-map (time ∧ hard filters;
  salience does not reduce it; eligibility, not viewport) are distinct and correct, both over
  `data.albums.length`; scope label matches the export set.
- Histogram: bin height equals additions (not cumulative); bins/domain/y-scale unchanged during
  scrub; entering historical from **any** non-community grouping switches graph colors to
  communities and disables the grouping dropdown; Latest restores the saved grouping; an
  edge-control repartition rebuilds stack membership/counts and recolors graph and histogram
  together while boundaries, total heights, and y-scale stay fixed.
- Reset: Latest removes only the temporal restriction and recomputes under the **current**
  filters (change filters while historical, then Latest reflects them); saved grouping and physics
  state restored; Gather available again, no auto-gather.
- Boundaries: leap day `2024-02-29` (fixture precedent viewer/tests/fixtures/library-stats.json:51);
  DST/browser-timezone independence (bin in UTC); identical timestamps share one bin exactly.
- Empty: before-first snapshot message with a live page; zero-addition bins selectable; v1/v2 or
  all-undated exports show the tray empty state; isolated albums in early snapshots render without
  errors.
- Tray: touch drag on the histogram does not pan the graph; focus is retained during scrub; live
  announcements are bounded; map-footer/toolbar remain reachable on desktop and mobile widths.
  The labeled playhead exposes its date/count value; bin totals and community breakdowns are
  readable without color or hover. Worker results, setting changes, and Pause-button actions
  cannot restart historical physics; exit uses native unpause without reheating.
- Dataset reload: loading a new export clears cutoff, bins, caches, and pending callbacks.
- Packaging: the bundle build includes `timeline.mjs` (fileset entry) and its tests run via the
  existing `./tests` inclusion; final parent-owned validation runs `nix flake check
  --print-build-logs`, `nix build .#packages.x86_64-linux.default --print-build-logs`,
  `nix build .#beets-album-graph`, and `npm test`.
- **Browser validation required before calling this done:** real GPU/WebGL checks of
  scrub/hide/restore in Chrome per the AGENTS.md workflow. This handoff is a source review only —
  no runtime validation has been performed, and the local export data is absent (§5 note).
- Strip (if built): strip clicks focus only visible albums; the graph stays cumulative.

## 11. Research notes (verified citations)

- [beets dbcore](https://beets.readthedocs.io/en/stable/_modules/beets/dbcore/db.html) — default
  `added` is DB insertion time. Lesson: label the feature “Added to library”.
- [importadded](https://beets.readthedocs.io/en/stable/plugins/importadded.html) — oldest track
  file mtime can override `added`; directory mtimes ignored; reimports skipped. Lesson: dates can
  encode import/migration events, so never promise “when you got the music”.
- [Vega-Lite overview+detail](https://vega.github.io/vega-lite/examples/interactive_overview_detail.html)
  and [bin-extent histogram](https://vega.github.io/vega-lite/examples/interactive_bin_extent.html)
  — a context view driving a detail view, and bin-driven aggregation. Lesson: histogram (context)
  driving the graph snapshot (detail) is an established pattern.
- [D3 focus+context](https://observablehq.com/@d3/focus-context) — same pattern hand-rolled;
  evidence no chart dependency is needed.
- [Nextcloud Photos #426](https://github.com/nextcloud/photos/issues/426) — chronological
  navigation/date-index scaling pain (issue evidence, not normative). Lesson: plan adaptive
  granularity from the start.
- [Apple Photos years/months](https://support.apple.com/guide/photos/browse-your-photo-library-pht53854a251/mac)
  — familiar progressive-granularity browsing analogue; an interaction analogue only, not a
  statement about added-date semantics.

## 12. Open design choices (unresolved, Sol may propose)

- Stack segment ordering (stable by community id vs. largest-first) and whether/when to collapse
  to top-N groups + “Other”.
- Strip items hidden by filters: disabled with explanation vs. omitted (pick one, document it).
- Histogram height scale: linear default vs. sqrt for spiky libraries.
- Whether bin-edge scrub snapping stays mandatory after MVP.

Resolved and no longer open: the before-first position (empty snapshot is MVP, §2.1), alternate
musical mappings (future-only, §3), the pause mechanism (native `graph.pause()`, §2.2).

## Validation for this document

Docs-only change: `docs/album-graph-timeline-handoff.md` revised against Oracle's final review; no
builds, tests, or browser checks were run (none required now). All file/line references in §5 were
re-checked on 2026-10-10 against the working tree, which changed under this session — an
uncommitted details-panel refactor touched `app.mjs`, `library-stats.mjs`, `style.css`, and
`tests/library-stats.test.mjs` (not by this handoff; left as found). Local export data is absent
in this checkout, so nothing here has been validated at runtime. Do not commit from the
implementation agent without the validation owner's review.
