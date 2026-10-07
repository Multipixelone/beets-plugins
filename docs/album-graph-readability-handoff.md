# Album graph readability handoff

Updated 2026-10-07. Audience: a future agent continuing work in `plugins/embed/viewer/`.

## Start here

The readability work is implemented in the working tree and validated against the actual local export in Google Chrome. The user said it was **“looking FAR better”**, then requested slightly more separation. That last spacing adjustment is already implemented and included in the final measurements below. The current request is documentation, not another implementation pass.

The user wants Markdown documentation for future agents. Do not turn this handoff into a Word document. The original screenshots illustrated problems, not a visual target. The desired result is distinct sound communities, recognizable artwork, and visible bridges, with sensible defaults rather than maximum repulsion or artificial isolated circles.

At this handoff:

- The baseline Git commit is `cd439708daadd29ca5cddc9e1a151ab11d8905ba`. The implementation was uncommitted; no commit, PR, deployment, or production export was made.
- Fifteen viewer source/test files were changed. This document and its README link are subsequent documentation additions.
- Full-data controlled Chrome trials reduced artwork overlap pairs from **7,613 to 1,053**. Tuned album forces alone produced **1,371** under the comparison described below.
- The GPU point-size ceiling is bypassed; covers continue growing past 255.5 CSS pixels on the tested Retina configuration.
- Labels update with the actual rendered frame. A focused pan probe measured **0.211 CSS pixels maximum** residual against the current anchor and placement offset.
- The final viewer Nix build passed **68 JavaScript tests and 4 Python HTTP/supervisor tests**. Host flake checking passed; the requested x86_64 Linux build did not complete.
- Residual cover overlaps, optional Auto-mode geometry changes, legacy cover resolution, and platform/performance coverage remain open. Do not describe this as zero-overlap or as a proven frame-rate improvement.

Read [AGENTS.md](../AGENTS.md) before future edits. Follow its packaged-viewer and Chrome-extension workflow. Preserve unrelated work and the local export; the existing untracked `.DS_Store` and `beets-album-graph/` were not created as implementation changes.

## Data and environment used

| Item | Recorded value |
| --- | --- |
| Repository | `/Users/tunnel/Documents/Git/beets-plugins` |
| Export | `beets-album-graph/albums.json` |
| Export SHA256 | `8e4b37254264278f86fa863c0bacb9483de9b36d0170c6256376f7f941bf716b` |
| Loaded albums | 2,719 |
| Computed links | 17,399 |
| Sound communities | 78 |
| Albums with map covers | 2,689; 0 unavailable in final inspection |
| Cover files | 5,378 map/card files in `beets-album-graph/covers/` |
| Export selection metadata | 6,378 selected, 3,659 skipped |
| Browser | Google Chrome, controlled through the Chrome extension |
| Native graph viewport | 819 × 614 CSS pixels, DPR 2 |
| Native screenshot size | 1,089 × 614, including controls |
| Simulation world | 8,192 × 8,192; artwork geometry scale 1 |
| Cosmos | `@cosmos.gl/graph` 3.4.2, pinned source adapter |

The full export arrived during the work by SCP. Earlier partial local exports and the 177-album deployment baseline in AGENTS.md are not the data behind these results. “Full library” here means the complete available **2,719-album embedded export**, not all 6,378 selected library albums; albums without usable embeddings were skipped by export.

## Implementation map

All paths in this table are relative to `plugins/embed/viewer/`.

| File | Changes and entry points |
| --- | --- |
| `physics.mjs` | `communityLayout` coarse layout, footprint estimates, affinity-dependent attraction, isolate handling; `communityLinkStrengths` keeps local links and weakens cross-community album springs. |
| `logic.mjs` | `layoutParameters` world-area-aware repulsion, collision-area budget and padding, final defaults. Existing `seedLayout` and artwork size calculations remain the foundation. |
| `app.mjs` | `configureCommunities`, geometry/cache invalidation, native cluster positions/strengths, initial camera, persistent labels, render-frame synchronization, collision obstacles, cover size caching, explicit mip URLs, edge styling integration. |
| `cosmos-atlas-patch.mjs` | Version/SHA-guarded instanced album quads in drawing/core/picking paths, shared frame clamp, cap removal, square picking, drag ordering, `onRenderFrame` hook. |
| `covers.mjs` | Uncapped screen-pixel demand, 512px detail tier, existing bounded atlas/cache behavior. |
| `sound.mjs` | Representative core anchors, concise names/descriptions, bounded collision-aware `placeLabels` with previous-placement preference. |
| `visibility.mjs` | `bridgeLinks` representative per connected community pair; `edgeStyles` background/bridge/focus hierarchy and smooth zoom detail. |
| `index.html` | Layout choice and updated controls/copy. |
| `style.css` | Graph label typography and interaction styling. |
| `tests/physics.test.mjs` | Community footprint, connectivity, affinity, isolate and layout behavior. |
| `tests/logic.test.mjs` | Density/area scaling, geometry and padding budget. |
| `tests/atlas.test.mjs` | Pinned adapter guards and drawing/picking/frame hook coverage. |
| `tests/covers.test.mjs` | Uncapped size demand, detail tiers and budget behavior. |
| `tests/sound.test.mjs` | Core anchors, concise descriptions and label placement/collision behavior. |
| `tests/visibility.test.mjs` | Bridge coverage, filtered edges, focus ordering and visual hierarchy. |

No production modules or dependencies were added. `default.nix`, `package.json`, `package-lock.json`, `worker.mjs`, the exporter and server were not changed by the implementation.

## Tier 1 Community structure and breathing room

### Confirmed findings

The viewer already had album repulsion, native collision, clustering, artwork geometry budgeting, and library-size scaling. Adding another generic repulsion or collision mechanism without inspecting these would have duplicated existing behavior.

Native centroid attraction did not independently separate communities according to their occupied area. Also, repulsion scaling used album count without accounting for simulation-world area: moving from a 4,096-unit to an 8,192-unit world gives four times the area, but the old calculation still suppressed repulsion as if the world had not grown. These are confirmed code findings. The claim that any particular new force would produce a pleasing map was a hypothesis, tested through the comparisons below.

### Implemented two-level layout

1. Reuse the existing similarity-derived local seed for albums.
2. Estimate each community's footprint from album artwork/dot sizes, conservative selection-frame geometry and collision padding. The diameter budget for a covered album is `(artworkSize + 8) / 0.8 * geometryScale + 2 * padding`; the community radius is an area estimate, not a containing boundary.
3. Seed community centers using a footprint-weighted spiral at 55% occupancy. This is a starting condition, not a prescribed final circular arrangement.
4. Solve a small coarse graph using footprint repulsion and weighted aggregate connections between communities. Larger communities get more room; strongly connected sounds remain closer. Iterations are bounded by `min(600, floor(12000000 / activeCommunityCount²))`.
5. Supply the resulting centers to native `setClusterPositions`, and per-album strengths to `setPointClusterStrength`. Album-level springs and native GPU collision continue operating.

The coarse solve runs when graph/geometry settings change, not on each simulation frame or camera movement. Its centers remain fixed between those changes; this is not a continuously simulated second GPU layer. Initial album positions use the model; subsequent geometry changes update attractions without repeatedly reseeding the whole live map. The cache key includes data generation, accepted graph revision, layout mode, size metric, artwork scale, geometry scale and padding. Accepted worker results invalidate geometry appropriately; initial positions preserve filtering via NaN coordinates.

For connected albums, `affinity = internalConnectionWeight / totalConnectionWeight` and `clusterStrength = 0.12 + 0.88 * affinity²`. Core albums have stronger community attraction; mixed-affinity albums can follow their cross-community connections into corridors. Edge-free albums use strength 1, because they have no springs to stop repulsion carrying them toward world bounds. An earlier 0.2 isolate strength left seven boundary albums in a trial; the final controlled layout had zero.

All album links remain in the graph. Cross-community raw spring strength is multiplied by 0.25 in community mode. Cosmos takes the square root of that value, so this halves the physical cross spring. Aggregate community springs already account for cross-community attraction; retaining full strength at both levels caused unnecessary compression. Within-community springs retain their existing degree-normalized strength.

The default is **Connected communities**. **Album forces only** remains available to compare native album forces without explicit coarse centers/affinity strengths; it also restores the full cross-community album spring. This comparison changes a bundle of related behaviors, not just one scalar.

### Final force and geometry defaults

| Parameter | Original behavior | Final behavior |
| --- | --- | --- |
| Relative repulsion default | 40, count-only scaling | 44, scaled by density/world area |
| Repulsion scale | Count term × distance scale² | `min(1, 400 * (spaceSize / 4096)² / max(1, albumCount)) * distanceScale²` |
| Gravity | 0.008 | 0.004 |
| Cluster force | 0.001 | 0.006 |
| Native collision strength | 2 | 4 |
| Collision area budget | Previous geometry budget | 55% of seeded interior, reserving 45% for irregular packing |
| Maximum computed padding | 40 | 12; budget can reduce it before artwork is reduced |
| Link spring / friction | 0.05 / 0.5 | Unchanged |

For the actual full export, final effective repulsion is **18.6203661809678**, effective collision padding **4.24016139130435**, and link distance **127.20484173913**. Computed raw padding is about 4.71; the UI rounds it down to its scaled slider step to remain within the budget. Geometry scale remains 1.

The user's final request for a little more separation led to raising the interim area budget from 50% to 55% and relative repulsion from 40 to 44. This increased effective padding from about 1.696 to 4.240. Footprint radii grew naturally by roughly 5–6%; no independent arbitrary radius multiplier was added. In a focused trial, the increased padding at relative repulsion 40 yielded 1,161 overlap pairs; adding repulsion 44 yielded 1,053 at roughly 4% more bounding area. Do not claim that padding alone reduced total overlaps.

The initial camera now fits the largest community so artwork is useful on entry. **Fit view** still gives the whole-library overview. This is a camera change, not a hidden alternate graph.

## Tier 2 Covers and zoom

### Confirmed cause and renderer fix

The old renderer used `GL_POINTS`. Chrome reported `ALIASED_POINT_SIZE_RANGE = [1, 511]` physical pixels. At DPR 2 that limits a visible point to 255.5 CSS pixels even when zoom scaling is enabled. There were corresponding shader and CPU size caps. Changing only the zoom option could not fix this.

The existing guarded Cosmos adapter now draws albums as instanced four-vertex triangle strips, including the core and picking paths. The quads sample native GPU position textures and use the same camera and atlas; there is no second DOM-cover layer or zoom-driven CPU layout. Per-corner attributes use a divisor-zero buffer and album attributes are per-instance. Empty initial shape buffers and buffer lifetime were handled after real Chrome failures exposed those cases.

The adapter removes the shared shader/sprite/CPU point cap. Picking uses square corners for covered albums and preserves circular picking for dots, including the native 0.8 square footprint. A shared frame rule caps the visible colored frame at four CSS pixels across the square, keeping borders thin at close zoom. Conservative logical collision and CPU radius/label obstacles can still include more padding than the painted frame.

The adapter is pinned to Cosmos **3.4.2** and upstream bundle SHA256:

```text
4ad56e0d6ddb6ad483baee7464b6ab0dd88b31c6af7f049408ad50574b8f1ff2
```

An upgrade must re-audit shader sections, attribute divisors, picking, frame parity and buffer lifecycle. Do not merely replace the SHA to make the build pass. Source guard tests do not substitute for a real GPU/browser run.

### Resolution and zoom behavior

- Size demand uses actual uncapped cover size × DPR. A 512px detail tier was added within the existing bounded pool/atlas architecture; the desktop atlas budget remains 16 MiB, with the existing split between base and detail allocations.
- Map detail uses explicit `cover_variants[tier]` when available, otherwise the original `cover`. It does not silently substitute `cover_large`.
- Actual legacy map sources in this export are 256px. Some 512px card covers have different matte/composition; substituting them made the image jump/change apparent scale. A 512px decode of a 256px original does not create detail.
- Cover-geometry caching avoids new native size uploads for ordinary atlas upgrades or zoom-only refreshes. In default **Covers** mode, zoom changes rendering/detail without reheating or moving the layout.
- **Known limitation:** optional **Automatic** mode switches between dot and cover geometry. Crossing that threshold can change native collision radii; if physics is running it can repack. Separating display sizes from stable collision footprints is future work.

For the same album at zoom 4, requested artwork width was 302.4184 CSS pixels. The baseline drew 255.5; the final renderer drew 302.4184. At zoom 8 it drew 604.8369 instead of remaining at 255.5. Native Chrome picking was also checked near a square corner outside the old inscribed circle: clicking about six pixels inside the top-left of a roughly 120px `channel ORANGE` cover selected the correct album.

## Tier 3 Sound-group labels

The previous path rebuilt label DOM every 250ms and anchored groups to the first four exported albums. That timing could visibly lag camera/simulation movement, and this sample was not necessarily a representative part of an irregular community.

Implemented behavior:

- Keep persistent label buttons instead of rebuilding them every timer cycle.
- Update after the native graph draw through the adapter's `onRenderFrame` callback. This hook is an extension in our pinned adapter, not an upstream Cosmos API. Apply native dragging before drawing/tracking so the labels and covers use the same rendered positions.
- Rank representatives using internal connectivity (`internalWeight² / totalWeight`) with stable album-ID ties. Use a core centroid and bounded visible representatives from the top 60% of the ranking, up to eight onscreen candidates.
- Track visible album positions once per render, up to all 2,719 in this export, so panning does not reveal untracked cover obstacles. Reuse the native paused-position cache; cache footprint arrays and cull by viewport.
- Place labels against artwork, other labels, search and bottom-navigation obstacles. Use 64px obstacle bins, previous anchor/offset first, cover-edge candidates and bounded search rings up to 120 CSS pixels.
- Show up to 12 labels at overview and 24 closer in. Single-album groups are omitted, as are labels where no collision-free placement exists.
- Replace truncated pills with concise main sound names and restrained typography. Preserve deduplicated longer descriptions in title/ARIA text. Clicking a label centers its community bounds at explicit zoom 1 without reseeding world positions. This is not fit-to-bounds with a maximum zoom: `focusCommunity` passes an explicit scale to `setZoomTransformByPointPositions`.

Repeated main names such as **Indie Rock** remain possible. Descriptions distinguish them on interaction, but naming could be improved. The descriptions use native tooltips/accessibility text; a custom touch-friendly popover was not implemented. Label navigation centers bounds that may include distant mixed-affinity members, and large groups can extend outside the viewport at zoom 1. A genuine bounded fit, possibly to the representative core, is future work.

### Tracking measurement caveat

Do not use an earlier raw “pan lag” number as a before/after result. D3 `interpolateZoom` briefly changed scale from about 1.3804 to 1.4 during a nominal pan, the label placer legitimately changed offsets, and a requestAnimationFrame sample could see a newer camera before its native draw. Comparing a label to its initial translated DOM position confounded all three effects.

The final probe wrapped the real production `onRenderFrame`, ran the unchanged label callback first, then compared each DOM center with its **current projected chosen anchor plus current placement offset**. Physics was paused during this camera-pan probe. Across 15 rendered frames and 77 samples: median **0.082**, p95 **0.2109**, maximum **0.211 CSS pixels**. This supports camera/placement synchronization in that probe, not measured accuracy during running simulation/drag or a universal latency/FPS claim. The raw, confounded measurements remain in the JSON for transparency.

## Tier 4 Edges and alternatives

`bridgeLinks` retains the strongest visible representative for each connected community pair. Here “bridge” means a visual representative, not a graph-theoretic bridge or bundled edge. The default edge view combines strongest local neighbors with these bridge representatives. **All connections** and **Selected only** remain available; graph data and physics links are not deleted to simplify rendering.

`edgeStyles` uses quiet local/background edges, more readable bridge edges, and stronger focused detail. On hover/selection, the six strongest incident links get the main emphasis; all other incident links remain faint and thin. Nonincident context opacity is multiplied by 0.45. Hover takes precedence over selection and filtering remains respected. The previous native bright-fan override is no longer used.

Detail changes continuously using a smoothstep over cover sizes from 10 to 72 CSS pixels. Close views can show stronger local relationships without thick bright fans overwhelming tiny overview albums. In the full-data overview, represented connected community pairs increased from 189 to 430, with 2,335 versus 2,660 drawn edges. This is an edge-coverage measure, not proof that every bridge is visually readable or musically meaningful.

`channel ORANGE` by Frank Ocean, album ID 169, provided an interaction check with 54 connections. Search, selection, filtering/clear round trips, community-label navigation, and restrained selection edges were checked in the packaged viewer.

### Approaches compared or rejected

| Approach | Evidence and decision |
| --- | --- |
| Tune existing album forces | Tested on the actual full graph. Much better than original defaults; still more overlap and local community mixing than connected-community mode. Retained as a selectable comparison. |
| Footprint community centers plus native album simulation | Tested and shipped. Improves separation while letting mixed-affinity albums follow cross-community springs. |
| Footprint-weighted spiral instead of shelf-like coarse seed | Coarse-model experiments reduced aggregate spring stress by about 9.7% and footprint penalty by about 19%. Shipped, then validated in Chrome. Those percentages are solver diagnostics, not pixel metrics. |
| More gravity, including 0.012 | Trial barely helped bounds and worsened overlap; rejected. |
| Contact-only collision damping | CPU approximation gave roughly 6% fewer overlaps but roughly 67% more motion; rejected. This was not a final native-GPU benchmark. |
| Weak isolate attraction | Let disconnected albums drift toward world bounds; replaced with core-strength attraction. |
| Trimmed core contours | Prototyped on full data using affinity ≥0.65 and a 75th-percentile distance-trimmed hull. Added overlapping boundaries without a clear readability gain; not shipped. |
| Fully collapsed community overview expanding into albums | Considered conceptually; no complete working prototype was built. It risks hiding bridge albums and adding disruptive layout transitions. Clickable community labels provide a smaller, stable drilldown now. |
| Higher-resolution legacy card images as map mips | Inspected and rejected because composition/matte changes can alter apparent artwork size. Explicit matching variants are supported instead. |

Primary references consulted during implementation:

- [Cosmos graph source and examples](https://github.com/cosmosgl/graph): native clustering, GPU simulation and rendering architecture.
- [Cosmograph configuration reference](https://cosmograph.app/docs-lib/api/interfaces/CosmographConfig/): configuration context; verify behavior against the actual pinned Cosmos library rather than assuming wrapper parity.
- [Sigma cluster-label example](https://github.com/jacomyal/sigma.js/blob/main/packages/storybook/stories/2-advanced-usecases/cluster-label/index.ts): labels/annotations as a view layer.
- [Sigma renderer architecture](https://www.sigmajs.org/docs/advanced/renderers/): rendering and interaction-layer separation.
- [D3 density contours](https://d3js.org/d3-contour/density): possible density-based regions; a reference for future experiments, not the implementation of the tested hull prototype.
- [Cytoscape expand-collapse extension](https://github.com/iVis-at-Bilkent/cytoscape.js-expand-collapse): compound-node overview/expansion ideas; not integrated.

## Controlled full-library results

### Method

The baseline was built from the baseline commit's viewer. The final variant was built from the working tree. Temporary audit code was appended to separate copies in `/private/tmp/album-readability/`, not shipped in the viewer.

Each trial reset native positions to the stored CPU seed, cleared velocity resources by disabling/re-enabling simulation, and executed **600 manual native simulation steps**, four per animation-frame batch, then paused for measurement. Baseline used its original seed. The final forces-only and connected-community comparison used the same final coarse seed, so the latter comparison asks what the native behavior does from that common starting point. It does not establish that a forces-only graph started from the old seed would converge to the same result.

The native graph viewport was 819 × 614 CSS pixels, DPR 2. Overview fit all albums. The audit's community view fit the same community members in both variants; its camera scale therefore differed. This audit camera action differs from the production label click's fixed zoom 1. Close views centered the same album ID 1, **Magic Lighthouse On The Infinite Sea** by **All in the Golden Afternoon**, in community 2 with 40 members, at zoom 4 and 8.

Overlap counts use actual artwork rectangles, excluding colored frames. The close baseline count accounts for the GPU cap; requested-size and renderer-size counts are both retained in raw metrics. Nearest-neighbor community mixing is a geometric diagnostic, not a musical quality score. Native randomness and different normal settling durations can yield variation. These numbers are controlled 600-step snapshots, not guaranteed automatic-final-settle values.

### Whole-graph comparison

| Metric | Original defaults | Tuned album forces only | Final connected communities |
| --- | ---: | ---: | ---: |
| Artwork overlap pairs | 7,613 | 1,371 | 1,053 |
| Albums involved in overlaps | 2,456 | 1,585 | 1,317 |
| Nearest neighbor from another community | 65.80% | 56.49% | 48.44% |
| World bounds width | 3,796.34 | 5,761.64 | 6,207.64 |
| World bounds height | 4,658.78 | 7,329.93 | 6,990.55 |
| World bounding area | 17,686,281 | 42,232,402 | 43,394,866 |

The final result has approximately **86.2% fewer overlap pairs than original defaults** and **23.2% fewer than tuned forces only**. This is a substantial improvement, but 1,317 albums still participate in at least one overlap. Native grid collision is approximate, not exact square packing.

Breathing room has a real cost: final bounding area is about **2.45×** the original and the longest span is about **1.50×**. Both use the same 8,192-unit world and geometry scale 1. Fitting all albums necessarily makes individual overview covers smaller; the labels/bridge hierarchy and community entry view are intended to keep that scale useful. Do not claim the gain is free of map expansion.

### Camera and interaction results

| Check | Original | Final |
| --- | ---: | ---: |
| Overview labels | 0 | 12 |
| Overview label/cover intersections | 0 with no labels | 0 |
| Overview label/label intersections | 0 with no labels | 0 |
| Community-view visible overlap pairs | 4,936 | 164 |
| Community-view labels | 0 | 4, with no measured collisions |
| Zoom 4 chosen cover width in CSS pixels | 255.5, capped | 302.4184 |
| Zoom 4 viewport artwork overlaps | 183 pairs, 46 albums | 1 pair, 2 albums |
| Zoom 4 label/cover intersections | 6 from one label | 0; no label placed in that close viewport |
| Zoom 8 chosen cover width in CSS pixels | 255.5, capped | 604.8369 |
| Represented community pairs in default overview edges | 189 | 430 |

The same-region close results combine a different layout with a corrected renderer; they are not isolated evidence for the renderer alone. The width measurements separately establish cap removal. Community-fit screenshots compare the same member set at different camera scales; do not present them as fixed-pixel-density comparisons.

Chrome Energy Saver, background scheduling and asset loading affected frame cadence. The recorded rAF intervals are not isolated GPU timings, so there is **no defensible 60 FPS or performance-speedup claim**. Final packaged inspection had no Chrome console errors/warnings. Interaction checks were visual/functional, not a cross-platform latency benchmark.

## Validation and operational state

| Check | Outcome |
| --- | --- |
| `nix build .#beets-album-graph --print-build-logs` | Passed on unchanged retry; 68 JavaScript tests and 4 Python HTTP/supervisor tests. |
| `nix flake check --print-build-logs` | Passed for the host aarch64-darwin evaluation/check; incompatible systems were omitted. Not an all-platform build pass. |
| `nix build .#packages.x86_64-linux.default --print-build-logs` | Attempted, failed with configured Linux builder architecture mismatch; x86_64 Linux CI validation remains outstanding. |
| `git diff --check` | Clean after implementation; checked again for this documentation. |
| Full export in Chrome | Loaded 2,719 albums, 2,689 covers; final source and packaged viewer both inspected. |
| Packaged interactions | Search, filter/clear, 54-link selection, pan/zoom, square-corner picking and community navigation checked. |

One final viewer build attempt hit an existing Python process-cleanup `PermissionError` at `os.killpg(child.pid, SIGKILL)`. An unchanged retry passed. An earlier idle-unload timing failure also passed on retry. No unrelated supervisor-test change was made; keep those flakes separate from the readability implementation.

Final successful package:

```text
/nix/store/0l3kjq6gzq1gyakw5bzza571m4dv9ij6-beets-album-graph-0.1.0
```

The final packaged viewer was left running on port 8772 at handoff:

```text
http://127.0.0.1:8772/?data=data.json&v=readability-final
```

Treat process state as historical and verify it before reuse. The user's original server on 8765 was left alone. Temporary comparison servers were stopped. A reused local URL initially served stale Chrome-cached HTML, causing a misleading schema/version failure; the server assets were correct, and a fresh top-level query loaded the rebuilt version. If the UI looks stale, verify the served build and cache before changing code.

## Reproduce or continue safely

1. Read AGENTS.md and the current diff. Check whether the implementation has since been committed or changed; this document records a dated state, not authority to overwrite later work.
2. Verify the export SHA and loaded counts. Do not benchmark an earlier 177/462-album dataset as the full library.
3. Build/run the packaged viewer from the repository root, selecting a free port:

   ```sh
   nix run .#beets-album-graph -- --data beets-album-graph/albums.json --covers beets-album-graph/covers --port 8772
   ```

4. Use the Google Chrome extension, not a substitute browser engine. Read page state, check console and cover status, and capture the native viewport. The Nix viewer serves built assets with no hot reload; rebuild/restart after source changes.
5. For a quick suite, use `npm test` from `plugins/embed/viewer/` in the project development environment. The packaged Nix build runs that suite plus `python -m unittest discover -s tests -v`. Do not install system packages ad hoc.
6. Compare overview, the same community, the same close album at zoom 4/8, a mixed-affinity bridge region and the 54-link selection. Check overlap, bridge routes, labels during active movement, picking corners and zoom stability.
7. For controlled metrics, reconstruct the reset/600-step method above or inspect the temporary harness while available. A future repeatable harness should pin export hash, positions, native random inputs where possible, force settings, camera, viewport and DPR. Record both rendered and requested geometry.
8. Validate force-only versus community mode from identical positions and velocity state. Switching a dropdown mid-settle is not a fair comparison by itself.
9. Measure label error after the actual production render callback against the current anchor/offset. Do not revive the invalid translation-only pan metric.
10. Run appropriate Nix checks and report Linux/platform limitations honestly. Read-only inspection and local reversible fixes fit the original scope; commit, deployment and system configuration are not completed actions in this record.

## Evidence locations

The durable numerical record is in this Markdown file. Raw evidence below is local and may be absent on another machine or after temporary-directory cleanup. Do not silently invent missing screenshots or claim a rerun from this text alone.

Local artifact directory:

```text
/Users/tunnel/.codex/visualizations/2026/10/07/01a11405-b762-7143-8aa3-1f42cde2474a
```

| Files in that directory | Use |
| --- | --- |
| `baseline-overview.jpg`, `after-overview.jpg` | Final native-size before/after overview captures. |
| `baseline-community.jpg`, `after-community.jpg` | Same community before/after, each fitted to its members. |
| `baseline-close4.jpg`, `after-close4.jpg`, `after-close8.jpg` | Reliable native close-view screenshots. |
| `baseline-overview-metrics.json`, `after-overview-metrics.json`, `force-only-metrics.json` | Authoritative final whole-graph comparison metrics. The force-only JSON was captured at zoom 1.4; its whole-world overlap/bounds remain comparable. |
| `baseline-community-metrics.json`, `after-community-metrics.json` | Same-community measurements. |
| `baseline-close4-metrics.json`, `after-close4-metrics.json`, `baseline-close8-metrics.json`, `after-close8-metrics.json` | Native camera and requested/rendered artwork geometry. |
| `after-pan-metrics.json` | Final corrected `panTracking.renderFrameResidual`; retains confounded raw fields with explanatory descriptions. |
| `packaged-selection.jpg`, `packaged-community.jpg` | Native packaged interaction examples from before the last modest spacing tweak; renderer/interaction behavior matches, spacing is not the final controlled snapshot. |
| `contours-prototype.jpg` | Exploratory earlier layout with rejected contour overlay, not shipped UI. |
| `album-readability.html` | Existing self-contained visual report with embedded images; this Markdown handoff is the agent-facing engineering record. |

Some other files are stale: `after-initial-*`, `baseline-close.jpg`, the image `baseline-close8.jpg`, `force-only-overview.jpg` and raw `baseline-pan-metrics.json` should not replace the authoritative final comparisons. In particular, the zoom-8 baseline **JSON** is current, while its image was not recaptured at the final native viewport.

Temporary work directory `/private/tmp/album-readability/` contains:

- `audit.mjs`: instrumentation appended to temporary app copies; exposes controlled settling, camera targets, metrics and prototype overlays through an audit panel.
- `prepare.mjs`: builds `before-source` from `git show HEAD` and `after-source` from the working viewer, then injects the audit. **Caution:** HEAD was the baseline when used. After a commit, this helper would need the explicit baseline commit instead. It also recreates its own temporary variant directories; inspect before rerunning.
- `before-source/` and `after-source/`: temporary source/build copies, not production source.
- `viewer-build-retry.log`: successful final build and 68/4 test results.
- `viewer-build.log`: preceding process-cleanup failure.
- `flake-check.log`, `default-build.log`: host check and failed Linux build evidence.
- `final-viewer.log`: final server request log.
- `report.py`: generator for the existing HTML visual report.

No audit code, dataset, screenshots or logs were added to the production viewer package. A future durable benchmark should deliberately preserve the useful harness rather than depending on `/tmp`.

## Prioritized next steps

These are proposals, not completed work or automatic instructions to start changing code.

### 1 Reduce residual local overlap without inflating the entire map

This is the most direct continuation of the user's remaining concern. First instrument the native collision grid, residual overlap depth, contact count and local velocity. Compare stronger/adaptive native collision with a bounded local square-contact relaxation only if the audit justifies it. The current collision force already exists and was increased; avoid stacking another generic force blindly.

Acceptance: materially fewer/deeper-overlap reductions at the same artwork sizes and a comparable world footprint; stable motion; mixed-affinity bridges still connect meaningful regions. Use identical seeds and native step counts, plus ordinary interactive settling. Do not optimize overlap count alone by making all covers smaller or pushing the whole graph outward.

### 2 Make the comparison reproducible

Promote the useful parts of the temporary harness into an opt-in development benchmark or test fixture, separate from production UI. Record the export hash, source revision, initial positions/velocity, force values, viewport, DPR, camera targets and step count. Add overlap depth/area and normalized contact metrics, representative bridge coverage, frame-synchronized label residual and controlled frame/memory measurements.

Acceptance: another agent can produce comparable baseline/variant results without this chat or old temporary files. Keep the personal library export out of the repository unless separately authorized. Check ordinary startup/settling too; the 600-step benchmark is not the entire user experience.

### 3 Separate Auto-mode display size from collision geometry

Give the native physics path stable world footprints while render/pick/detail paths change smoothly between dots and covers. Keep hit targets honest and preserve existing size controls. Test hysteresis, active simulation, dragging and repeated threshold crossings.

Acceptance: changing zoom alone does not shift world positions or reheat/repack the graph in Auto mode, while square picking and mip demand stay aligned with the visible cover. Default Covers already avoids the known transition issue.

### 4 Export composition-matching high-resolution map variants

Generate explicit map mip variants with consistent framing, including genuine 512px sources when available. Reuse the exporter's ownership/atomic-write rules. Do not substitute legacy `cover_large` merely because it is larger; it can have a different matte/crop. Verify memory/request budgets and Retina sharpness.

Acceptance: detail improves as covers grow, without image composition jumps, excessive atlas growth or breaking old exports. This requires exporter/data work beyond the viewer changes recorded here.

### 5 Refine community names and navigation

Disambiguate repeated short names using a concise distinctive descriptor from the existing sound labels. Replace the production label click's fixed zoom 1 with a genuine fit subject to an appropriate zoom limit; consider fitting the representative core while retaining a way to reach outlying bridge members. Inspect anchor swaps and edge-of-viewport placement during active simulation; a tiny screen error can coexist with legitimate placement jumps.

Acceptance: communities are distinguishable at overview, label/cover and label/label collisions remain controlled, full descriptions remain accessible, and navigation does not obscure bridges or create abrupt layout changes.

### 6 Prototype overview treatments only against the current baseline

If structure remains difficult at overview, compare gently weighted density contours or an aggregate overview that preserves world coordinates and keeps important bridge albums visible. The trimmed-hull trial already failed to add clarity; do not reintroduce it as an assumed improvement. A fully collapsed overview still needs an actual prototype and evaluation.

Acceptance: better navigation/region recognition on the same full data without more visual clutter, fabricated hard boundaries or disruptive expand/collapse movement. Keep this behind a development option until it beats the shipped view.

### 7 Complete platform and release validation

Run the x86_64 Linux build on a compatible builder/CI. Test another GPU/driver and DPR configuration, constrained devices, small/empty libraries, filtering, artwork/size changes, pause/resume and bridge-heavy selections. Benchmark label readback/DOM placement and coarse-solve time with browser energy/background conditions controlled and documented. The observed coarse solve was roughly 200–240ms on this library, but that was not a formal performance study.

Acceptance: no renderer/picking regressions across supported environments, known limits documented, checks pass on their intended systems. Treat the existing Python cleanup/idle-unload flakes as a separate maintenance issue. Review and commit/deploy only when requested; nothing in this handoff claims those steps have happened.

## Documentation debt

The older [embed README](../plugins/embed/README.md) contains historical rendering descriptions and validation counts. Its map paragraph still mentions the hardware point-size cap and older tier/cache behavior. This handoff records the new behavior; a future user-documentation pass should reconcile those paragraphs with the current implementation rather than treating old prose as a renderer constraint.
