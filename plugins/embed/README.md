# Offline music embeddings

Add `embed` to the `plugins` list in your beets configuration. The combined
package includes it, but it does no work on imports and starts no background
jobs. Existing xtractor behavior is unchanged.

```yaml
plugins: [embed]  # retain your other enabled plugins
embed:
  store: ~/.local/share/beets/embeddings.sqlite3
  device: auto
  threads: 2
  batch_size: 8
```

```sh
beet embed --count-only
beet embed                         # incremental, whole recordings
beet embed artist:"Nick Drake"     # ordinary beets item query
beet embed --limit 100             # bounded trial
beet embed-search "warm lo-fi folk with brushed drums" --top-k 20
beet embed-search "gentle acoustic music" --albums --json
beet embed-similar userrating:4..5 --top-k 20 --json
```

All commands accept `--store PATH`. Search returns current tracks, or album
centroids with `--albums`; similarity returns albums and excludes seed albums.
Each seed album has equal weight, after averaging its selected track vectors.
Album output includes embedded/total track coverage: incomplete albums remain
searchable. `--json` provides IDs, metadata, cosine scores, and coverage for
assistant use. Exact cosine search runs in chunks of 512; an approximate index
is deferred. Search uses means; stored standard deviations are
available for later analysis. Scores are similarities, not calibrated relevance
probabilities.

## Album similarity graph

For the October 2026 readability implementation, full-library comparisons,
known limitations and prioritized follow-up work, see the
[agent handoff](../../docs/album-graph-readability-handoff.md).

```sh
beet embed-graph-export -o albums.json --covers-dir covers --cache-dir graph-cache
beet embed-graph-export artist:"Nick Drake" -o drake.json
beet embed-graph-export --model text --store /path/to/vectors.sqlite3 -o albums.json
nix run .#beets-album-graph -- --data "$PWD/albums.json" --covers "$PWD/covers"
```

The exporter also prints the packaged viewer command. Open its localhost URL
(default port 8765; override with `--port`). The viewer accepts a file picker
or a `?data=` URL as well. It runs offline with bundled cosmos.gl 3.4.2.
Cover URLs use `/covers/<filename>` on the viewer's server, including when JSON
is loaded from the file picker or a different URL. For frontend development,
run `npm ci` and `npm run build` in `plugins/embed/viewer`, then
`python server.py --data /path/to/albums.json --covers /path/to/covers`.

### Publishing the viewer

The viewer ships ready for a public instance behind a proxy, as on
<https://albums.finnrut.is/>: `index.html` declares description, canonical,
robots, Open Graph and Twitter card metadata with absolute URLs, and links
`/favicon.ico` and `/social-card.png`, which `npm run build` copies from
`viewer/static/` into `dist/` for the server to publish. The favicon and the
card design (dark paper, accent band, Cooper faces, hostname wordmark) come
from [the author's blog](https://blog.finnrut.is); the card adds a quiet
constellation in the viewer's community palette and contains no album artwork
or library data. Regenerate it after palette or copy changes with any Python 3
that has Pillow installed:

```sh
python3 scripts/gen_social_card.py   # from plugins/embed/viewer
```

The script is deterministic and uses only the committed SIL-OFL Cooper faces
under `scripts/fonts/cooper/`; re-run it and commit the result rather than
editing the PNG by hand. When deploying your own instance, point the
metadata's absolute URLs at your origin and either keep the card or render
one with your own title and hostname.

For a public deployment, the privacy story visitors see in the sidebar is:
the library JSON and covers load from the same origin; the page itself has no
analytics; opening a file from the file picker stays in the browser tab; and
phrase search sends the phrase text to the server for embedding (`POST
/api/embed-text`, offline CPU model) while matching runs client-side. Keep
that wording honest if you front the API differently.

Track queries select whole albums. Every track contributes to track count and
play statistics, using `lastfm_play_count`, then legacy `play_count`, then zero.
Vectors use the existing mean pooling over currently embedded tracks only.
Albums with no current embeddings are skipped and counted; partial coverage is
shown in album details. `style` (Discogs-EffNet) is the default embedding family;
`text` selects AMCLAP. The exporter never modifies items, albums, tags, or the
embedding store; ordinary beets startup behavior still applies. Output cannot
overwrite either database or its SQLite sidecars, including aliases.

### Library and quality metadata

Every album row also contains these additive schema-v3 fields:

| Field | Value |
| --- | --- |
| `added` | Album addition time as an ISO-8601 UTC string ending in `Z`, or null |
| `format` | Format covering at least 90% of all tracks, `Mixed` otherwise, or null when all formats are unknown |
| `formats` | Known format names mapped to track counts |
| `lossless` | True only when every track is FLAC, ALAC, WAV, AIFF, APE, or WavPack |
| `bitrate_kbps` | Rounded integer mean of known positive track bitrates in kbps, or null |
| `samplerate_hz` | Integer mode of known positive sample rates, or null |
| `bitdepth` | Integer mode of known positive bit depths, or null; lossy zero values are excluded |
| `size_bytes` | Integer sum of successfully statted file sizes, or null when no stat succeeded |
| `release` | Object with `albumtype`, `label`, `country`, `original_year`, and `mb_albumid`; empty strings and zero become null |

Release values are strings except `original_year`, which is an integer.
Sample-rate and bit-depth ties choose the smaller value. Unknown formats count
against the 90% threshold and prevent an album from being marked lossless.

The top-level `library` object describes the **whole beets library**, regardless
of the graph query or embedding coverage. It contains integer `albums`,
`tracks`, `size_bytes`, `lossless_albums`, and `missing_files` totals; floating
point `duration_seconds` and `listened_seconds_estimate`; a `formats` object;
and `computed_at`, an ISO-8601 UTC string ending in `Z`. The listening estimate
sums each track's length multiplied by the same play-count fallback used for
album statistics. Standalone tracks contribute to track, size, duration, and
listening totals, but do not create albums.

Each library format entry contains integer `albums`, `tracks`, and `size_bytes`
counts. Albums count under their dominant format or `Mixed`; tracks and bytes
count under their actual formats. Consequently a `Mixed` entry can have albums
but zero tracks and bytes. Unknown formats have no format entry, while their
tracks and bytes still contribute to overall totals. Overall size is zero when
no files could be statted. Failed stats increment `missing_files`; valid empty
files contribute zero bytes without counting as missing.

Quality and library statistics share the existing selected-album item processing.
Remaining tracks are read in bounded batches, with one filesize stat per item;
the existing embedding fingerprint checks are separate. Export logs report the
time spent computing library totals, including selected-album contributions.
The export includes no file paths or directories. Schema version remains 3,
matching earlier additive v3 extensions and existing viewer/listen consumers.

An October 9, 2026 read-only benchmark used a temporary SQLite backup of the
real library and the NAS music mount: **6,396 albums / 93,765 tracks**. Computing
library totals took **29.853 seconds**, reporting **1,977,198,513,000 bytes**,
**19,208,908.05370401 seconds** of duration,
**18,998,313.2967483 seconds** of estimated listening, **5,036 lossless albums**,
and **100 missing files**. The single-album export took 30.924 seconds, excluding
the 7.593-second database snapshot; covers and descriptor inference were disabled.
This measures the cost of the required whole-library scan even for a narrow query.

`--covers-dir DIR` enables a dedicated incremental thumbnail cache. Pillow fits
full artwork into 256×256 map JPEGs and separate 512×512 card JPEGs with neutral
padding. Quality 85 retains more detail than 82 for about 10% more bytes at
256px; quality 88 costs another 13%. JPEG works without extra browser codecs.
Original
artwork is opened only for reading. Names hash the resolved source path, file
identity, size, nanosecond modification time, and thumbnail recipe; unchanged
sources skip decoding. Thumbnail and manifest writes are atomic. After publishing
the JSON, the exporter prunes only previously recorded cache files no longer
used by the export, leaving unrelated files alone. Use one cache directory per
export/query and serialize exports to that cache with the usual import lock.
Do not delete its `.album-graph-covers.json` ownership manifest.

Missing, unreadable or corrupt art produces `cover: null`, with counts in the
summary; thumbnail failures do not fail the export. An invalid or unwritable
cache directory is a configuration error. Exports use schema v3 and include a
relative `cover` and `cover_large` filenames or null on every album; omitting
`--covers-dir` disables covers. `cover_large` is an optional v3 extension; old
v1/v2/v3 exports remain usable, with cards falling back to `cover`. Both variants
use the same strict hashed filename format and manifest. `covers_*` summary
counters describe map thumbnails; `covers_large_*` counters describe card
variants, and `covers_pruned` counts files across both variants. A card variant
failure leaves a successful map thumbnail available. v1 shows colored dots.
`--covers DIR` serves only allowed hashed JPEG names, rejects symlinks and
traversal, and sets immutable cache headers. It never exposes original art paths.

Covers is the default rendering mode. Dots disables cover loading; Auto uses dots
below the adjustable zoom threshold (initially 1) or above 1,000 albums. Missing
and not-yet-loaded covers remain dots. Native GPU images retain a colored group
border and all picking/dragging behavior. Visible covers load lazily with at most
four concurrent requests/decodes on desktop, two on constrained devices;
off-screen images are evicted first. Click cards show 160px artwork from the
512px variant (enough for DPR 3); hover cards show 80px from the 256px thumbnail.
Larger variants load only when a click card opens, never into the GPU map atlas.
Closing/replacing cards drops their image references. Small originals cannot
gain detail; exports retain their original proportions and do not upscale them.

Map decoding chooses the smallest adequate 32/64/96/128/192/256px sprite tier
from the drawn image size × DPR, including sound-lens size emphasis, cosmos's
zoom rule and the hardware point-size cap. DPR changes also update the graph's
rendering pixel ratio. The pinned cosmos.gl 3.4.2 image path packs
`ceil(sqrt(count))` square cells at the largest sprite dimension. It does not
reduce images that fit; its RGBA8 texture has one mip level. Exceeding
`MAX_TEXTURE_SIZE` causes nearest-neighbor
downsampling. We avoid that path by capping the grid before upload. All cached
map sprites share a tier, so a single large image cannot inflate smaller cells.
Atlas uploads are batched and deferred during drag/zoom gestures; tier changes
cancel old decoding and drop old browser/cosmos image references.

Constrained devices are screens ≤700px wide, coarse-pointer devices, or devices
reporting ≤4 GiB RAM (missing memory information falls back to screen/pointer).
Each CPU sprite pool and GPU atlas is capped at **8 MiB** there, **16 MiB** on
desktop. Count limits are 128/256, further reduced by the byte and texture-size
limits: at 256px, 25 phone sprites or 64 desktop sprites. At 128px, phones allow
121 sprites. Excess nodes remain dots. The artwork allocation envelope is
**48 MiB phone / 96 MiB desktop**, allowing current/previous sprite references,
atlas packing, texture replacement, bounded decode scratch and two card images.
These are application buffer budgets, not total browser-memory limits: cosmos's
simulation/framebuffers, browser HTTP/decoded-image caches, and GC/driver
allocation timing are separate.

For systemd deployment, pass `--covers-dir /var/lib/beets-album-graph/covers` to
the export and `--covers /var/lib/beets-album-graph/covers` to the server. The
exporter needs read/traverse access to artwork directories as well as its usual
library and embedding-store access. Finn's stored art paths are relative to the
music root `/volume1/Media/Music`; resolved artwork there needs read access.
The cover directory needs exporter write access and server read/traverse access.
New cache directories use mode 0750 and thumbnails/manifest use 0640; share the
`album-graph` group as in the existing services. JSON permissions remain managed
by the existing publication wrapper. Keep this cache persistent across daily
runs, even if JSON is exported into a staging directory. The recipe changes
once, regenerating both variants; old recorded thumbnails are pruned only after
the new JSON is published. An interrupted export preserves the prior cache.

An October 6 sample of **406 real artworks** reproduced the old 128px/q82 total
of 2,232,567 bytes. Actual locked-launcher exports measured:

| Variant | Sample JPEG bytes | Projection for 6,400 artworks |
| --- | ---: | ---: |
| 256px/q85 map | 7,533,233 | 118,750,471 (119 MB) |
| 512px/q85 card | 21,846,375 | 344,376,355 (344 MB) |
| Both | 29,379,608 | 463,126,826 (463 MB / 442 MiB) |

The card variant adds about 344 MB but supplies the selected 160px cards at DPR
3; 256px alone would suffice for an 80px card. The sample's 812 JPEG files
allocated 31,014,912 bytes on this filesystem, projecting about 489 MB allocated.
These estimates exclude JSON, manifest and phrase-cache storage, assume one
unique artwork per album, and vary with artwork complexity/shared sources.
Generating both variants for the fixed 407-album snapshot (one missing cover)
took 29.7 seconds with a warm descriptor cache; the repeated export took 5.2
seconds and reused all 812 JPEGs. JSON measured 1,641,824 bytes. The smoke used
the normal locked launcher, copied databases and temporary output/cache paths;
checksums confirmed the copied inputs were unchanged. The final packaged warm
repeat took 5.5 seconds and again reused both variants.

Validation ran through `agent-run-long`: 49 plugin Python tests, one HTTP server
test, 23 Node tests, and the targeted `embed`/`beets-album-graph` package builds
passed. No heavy dependencies or aggregate package were compiled. The full
browser/GPU smoke remains unverified on this host: headless Chromium times out
navigating to the localhost viewer before it loads the application. Sprite byte
limits and the pinned atlas packing/downsampling path were checked through
unit tests and source inspection; browser/driver memory was not measured.

Tune kNN, cosine threshold, physics, node size, and color/grouping without
exporting again. With both edge rules enabled, the threshold filters each
album's top-k neighbors; undirected node degree may exceed k. Threshold alone
includes all qualifying pairs; disabling both rules removes links. Defaults
are k=8, cosine threshold=0.7, summed-play sizing, and automatic sound
communities. Automatic groups use deterministic weighted label propagation on
the current edges, so they can change when edge controls change. The selected
grouping also controls cluster attraction; unknown metadata has an Unknown
group. Friction is shown as damping (higher means quicker settling). Search
highlights album/artist matches, hover or click shows album information, and
dragged nodes settle back under physics. The viewer requires WebGL 2.

After a phrase search, **Gather matches** arranges the salient albums in slowly
rotating concentric rings at the map's center. Other albums remain draggable
and flow around the outside, retaining their mutual links and collisions.
Dragging a gathered album temporarily lifts it from its slot; releasing it
returns it to the ring. **Pause physics** also pauses rotation, and reduced
motion disables the automatic spin. **Ungather** restores the matches to their
original map positions and resumes the usual community forces.

### Sound labels, lens and filters

Schema v3 adds `sound`, `essentia` and text-track coverage per album, plus a
source-qualified `labels` catalog with packed score columns. Layout vectors use
`vector_encoding: int8-base64` and a shared `vector_dimension`: signed bytes
scaled per album to the full −127…127 range. The browser normalizes the decoded
vectors before cosine scoring; magnitude is unused. This keeps live edge sliders
while avoiding thousands of long JSON floats per album. Label/score pairs
reference the shared catalog, and Essentia uses positional fields with shared
`essentia_fields`; absent entries are null, observed entries carry value/count
and optional categorical support. Track count supplies coverage denominators.
The viewer expands this representation after loading, including in the worker. Existing v1/v2
exports remain usable without sound controls. Info cards show Style, Mood,
Instruments, Sounds like and Essentia only when available. The searchable sound
lens emphasizes matching albums; clear it to restore normal sizing. Top style,
mood and flavor are also grouping options. Community/group labels prefer main
styles and add CLAP flavor words; they hide below zoom 1 and avoid collisions.
On phones, the Controls button opens the sidebar over the full-width graph.

Head scores already include audio-window averaging. Export averages them equally
across current tracks, checking the same fingerprint/model keys as vectors.
Discogs400, mood/theme and instrument outputs are independent sigmoid
probabilities: no additional sigmoid, softmax or sum-to-one normalization is
applied. The top five per group are exported with coverage. Approachability and
engagement are linear regression values, preserved even outside 0–1; only their
visual bars are bounded.

Essentia fields use observed-value means for finite numbers and majority values
for categories, with ties null and per-field coverage. Numeric strings from flex
attributes are parsed; missing and invalid values stay null. The filter uses
`danceable` (0–1 classifier probability). Raw rhythm `danceability` is a distinct
measurement and can exceed 1. Vocal/instrumental filtering uses the observed
`voice_instrumental` category. Unknown values are dimmed only while a filter is
active, unless Include unknown is checked. Search, lens and filters intersect.
No complementary voice/gender probabilities or category labels are inferred.

CLAP descriptors use separately pooled current text-family album vectors. The
shipped `beets_embed/descriptors.json` has 144 short phrases across six axes.
Override it with `--descriptors FILE`: a JSON object whose keys are
`genre/style flavor`, `instrumentation`, `production/texture`, `mood/energy`,
`vocals` and `tempo-feel`, each holding a list of distinct nonempty strings.
There may be 1–256 phrases in total, each at most 240 characters. For example,
production phrases include gritty, lush, sample-heavy, lo-fi and glossy.

Each phrase's cosine scores are population z-scored across exported albums with
current text embeddings; constant columns become zero. These scores describe
relative salience within this export, not probabilities or factual tags. Up to
five labels above z = 0.5 are shown, with at most two per axis. The lens retains
all trained classes and phrases, including labels outside the displayed top five.
Score columns are base64 bytes in album order: zero means missing; 1–255 spans
0–1 for probabilities/category support, or −4…4 for CLAP z-scores. Regression
and raw rhythm lens columns use population z-scores while album values stay raw.

`--cache-dir DIR` stores phrase embeddings separately from both databases;
its default is `.album-graph-cache` beside the JSON. Cache keys include exact
vocabulary content and text model identity. A miss runs the packaged CPU worker
with two threads and batches of eight, bounded to 120 seconds. It uses the
existing text-only model path, with no GPU probe, style inference or audio reads.
A hit does not load Torch or the encoder. Missing/unloadable weights or an
encoding timeout produces a warning and skips CLAP without losing main labels,
Essentia or the graph. Cache entries are atomic float32 NPZ files (about 289 KiB
for 144 phrases), mode 0640 in a 0750 directory. Serialize runs using the usual
import lock.

For the export unit, use a persistent writable directory such as
`--cache-dir /var/lib/beets-album-graph/cache`, even when publishing JSON through
a staging directory. Existing art/library/store read permissions still apply.
Cold runs also read the CPU worker's Nix-store model link farm: `amclap.ckpt`,
`amclap.gin`, `omar.gin` and `mpnet/` (weights/config, pooling and tokenizer files).
These are pinned package dependencies, not files under HOME. HF_HOME,
HF_HUB_CACHE, TORCH_HOME, XDG_CACHE_HOME and MPLCONFIGDIR are redirected beneath
the selected cache directory;
HF_HUB_OFFLINE and TRANSFORMERS_OFFLINE are set. No runtime downloads are needed.
ProtectHome=read-only and ProtectSystem=strict work with the existing writable
state directory and readable Nix store; no writable home access is required.

The October 6 locked-launcher smoke used the real library and seeded store while
an existing embedding backfill was running: 330 albums cold, 331 warm. With two
CPU threads, the initial cold export took 26.7 s wall / 22.0 s CPU including
thumbnail generation; warm took 10.5 s wall / 5.5 s CPU and reused the phrase
cache. These are current partial-library measurements under contention, not a
full-library runtime prediction. After compaction, a fixed 407-album warm run
reused all 406 thumbnails and the phrase cache in 6.6 s wall / 6.5 s CPU, with
a 1,604,739-byte JSON. The encoder has a hard 120 s ceiling.

For the **same 100-album snapshot**, v2 with raw layout vectors was 2,614,230
bytes; v3 before compaction was 3,122,437 bytes (508,207 bytes added by sounds).
Final v3 is 461,972 bytes (0.44 MiB), including quantized vectors and sound data.
Keeping shared catalog metadata fixed and scaling albums/score columns projects
23.4 MB (22.3 MiB) at 6,400 albums; a conservative simple ×64 projection is
29.6 MB (28.2 MiB). Real-sample maximum cosine error was 0.00273, with 799 of
800 top-eight neighbor choices unchanged. The 330 thumbnails totaled 1.72 MiB;
the phrase cache was 296,206 bytes. Coverage is shown because recognizable albums
can still have only one embedded track.

Viewer assets and `data.json` send `Cache-Control: no-cache` and strong SHA-256
ETags, honoring If-None-Match with 304. This prevents heuristic caching of
Nix-store assets with epoch timestamps. Hashed covers retain one-year immutable
caching. The server keeps its localhost binding and explicit path allowlists.

### Free-text CLAP search

The separate **Describe a sound** field accepts phrases such as “rainy night jazz
piano” or “aggressive 90s boom bap”. After a 400 ms debounce, the viewer requests a
text embedding from its own server and computes every covered album's cosine in
the browser. The map uses the existing descriptor-lens convention: population
z-score ≥ 0.5 lights up relatively salient albums. This is relative salience,
not a probability. Constant score populations have no salient matches. The top
10 matching albums show raw cosines; clicking selects and zooms to the album.
Album/artist search, the descriptor lens and Essentia filters intersect with
phrase matches. Missing CLAP vectors remain dimmed. Clearing the phrase restores
rendering under the remaining controls. Superseded query responses are ignored.

Schema v3 now additionally exports nullable `text_vector` values, with shared
`text_vector_encoding: int8-base64` and `text_vector_dimension: 512`. These are
CLAP **audio** embeddings pooled from the current text-comparable family used
by descriptor scoring, independent of the selected layout family. Coverage uses
`text_embedded_tracks`, and `text_model_id` identifies the embedding space. They
remain available when descriptor encoding fails. The browser normalizes each
decoded vector once. Earlier v1/v2/v3 exports still load; phrase search explains
when an export has no compatible vectors. An old server, absent model files,
timeout or model identity mismatch produces a clear message without losing the
graph or other controls.

The x86_64-linux viewer package includes the CPU worker path; it needs no separate
HTTP service. Other platforms retain the viewer without a packaged query worker.
`--text-worker PATH` overrides that path. The server lazily starts one persistent
`serve-text --device cpu --threads 2` child on the first query. It skips ONNX/audio
processing and GPU discovery, validates the complete pinned checkpoint, then
releases the audio encoder/projection and checkpoint tensors. Only the text
encoder/projection are retained for queries. Idle unloading terminates the child
and releases its process memory after 600 seconds; use `--text-idle-seconds 0`
to keep it loaded. Server shutdown also terminates/reaps the child.

`POST /api/embed-text` accepts `{"q":"rainy night jazz piano"}` and returns
`{"vector":[...],"model_id":"text:..."}`: 512 finite unit-length floats. It
requires `application/json`, a body of at most 4 KiB, and a trimmed phrase of
1–240 characters. Request-body reads have a 10-second deadline. There is one
in-flight inference, no server queue, and at most two accepted queries in any
one-second window. Busy/rate-limited requests return 429 with `Retry-After: 1`;
unavailable workers/models return 503. A 120-second deadline includes cold
loading; timeout returns 504 and kills the child, allowing the next query to
reload. API responses use `Cache-Control: no-store`. The viewer allows one
request in flight and retains only the latest pending phrase.

The server still binds **127.0.0.1**, retains its asset allowlist and ETags, and
adds no CORS headers. POST requires a localhost Host header (including its port),
rejects cross-site Fetch Metadata, and checks supplied Origin against Host.
No database or music-directory access is needed by the viewer query service.
HF/Torch downloads remain disabled. `--cache-dir` defaults to `.album-graph-cache`
beside the selected JSON, or in the working directory without `--data`; production
should explicitly select the persistent path below. Query runtime caches live in
its `query/` subdirectory, separate from the exporter's runtime caches because
the services run as different users. HF_HOME, HF_HUB_CACHE, TORCH_HOME,
XDG_CACHE_HOME and MPLCONFIGDIR point beneath this query subdirectory.

#### Queued infra wiring (documentation only)

1. Bump the infra `beets-plugins` input to this feature commit. Both the exporter
   and `beets-album-graph.service` must use packages from that input. Re-export
   the graph so `albums.json` includes audio vectors; restarting only the viewer
   cannot add vectors to an older export.
2. Add `--cache-dir /var/lib/beets-album-graph/cache` to **both** the locked export
   launcher and viewer launcher. Retain the viewer's `--data`, `--covers` and
   `--port 8765` flags. The packaged viewer supplies `--text-worker` automatically;
   source/manual launchers must supply the packaged CPU worker's absolute path.
3. Prepare `/var/lib/beets-album-graph/cache` with owner `tunnel`, group
   `album-graph`, mode **2770**, allowing the exporter and viewer users to create
   their separate runtime directories. Retain exporter write access to graph
   state. Add `ReadWritePaths=/var/lib/beets-album-graph/cache` to the viewer unit,
   overriding its current `ReadOnlyPaths=/var/lib/beets-album-graph` for this
   subdirectory. JSON/covers remain read-only to the viewer. Keep
   `ProtectHome=true`, `ProtectSystem=strict`, `PrivateTmp=true` and the existing
   localhost address restriction; writable home access is unnecessary.
4. Any Nix-store sandbox allowlist must expose the packaged CPU worker's runtime
   closure and `${embed-models}` link farm **and its resolved symlink targets**:
   `amclap.ckpt`, `amclap.gin`, `omar.gin`, and all `mpnet/` files (weights,
   tokenizer/config, `modules.json`, pooling and normalization configs). Normal
   NixOS services can already read these through `/nix/store`; no HOME model path
   or runtime download is needed. Preserve current exporter library/store/music
   read paths; do not add those paths to the viewer.
5. Budget **3 GiB** for the viewer plus query child during loading (measured
   below), and retain two CPU threads. Set `MemoryDenyWriteExecute=false` on the viewer
   unit: a real query under kernel MDWE failed because Torch/oneDNN could not
   create an inference primitive. The current `true` setting blocks queries.
   Verify the complete systemd sandbox after rollout. No new listening
   port or separate text service is required.
6. If the existing private viewer proxy is used, forward **POST**
   `/api/embed-text` to the same loopback backend, permit a 4 KiB body, set its
   response timeout above 120 seconds (e.g. 130 seconds), and disable API caching.
   Validate the browser's Origin against the private viewer's public origin at
   the proxy, then rewrite Host and a supplied Origin to `127.0.0.1:8765` and
   `http://127.0.0.1:8765` respectively. Preserve `Sec-Fetch-Site`; do not expose
   this route through a new public listener or enable CORS. A plain localhost
   viewer or SSH tunnel needs no proxy rewrite.

#### CPU validation and size

On October 6, a locked-launcher export of a fixed **407-album** snapshot completed
in **5.61–5.67 seconds**, using copied databases and temporary output/cache paths;
the copied inputs were unchanged. New vectors/metadata added **285,372 bytes**,
projecting to **4,486,391 bytes (4.49 MB / 4.28 MiB)** at 6,400 covered albums.
This counts field overhead and shared metadata; base64 vector bytes alone are
4,377,600 bytes at that scale. Missing vectors add only null fields. Layout,
covers and descriptor data are unchanged by this size comparison.

Fresh-process first HTTP queries took **4.92–7.05 seconds**, including process
startup and cold model loading; warm queries took **54.6–65.8 ms** with two CPU
threads.
“Cold” means a fresh process, with pinned files already in the local Nix store;
it is not a measurement with OS filesystem caches flushed. One worker PID served
all four requests. Its peak RSS was **1,933 MiB**, and warm steady RSS was
**1,807 MiB**, including Torch/Python and their allocator retention. Idle process
termination releases this footprint. Quantization changed the two phrases'
cosines by at most **0.000917**; both top-five sets were unchanged versus original
float vectors. The retained text path matched the prior packaged encoder within
1e-6. A real text query under kernel `PR_SET_MDWE` failed with
`RuntimeError: could not create a primitive`; this establishes the required
`MemoryDenyWriteExecute=false` unit change. No systemd service was modified.
The final packaged endpoint repeated both phrases (5.11 s cold, 54.6 ms warm)
and verified that server termination left no encoder child behind.

| Phrase | Rank | Artist — album | Cosine |
| --- | ---: | --- | ---: |
| rainy night jazz piano | 1 | Makoto Terashita Meets Harold Land — Topology | 0.694290 |
| | 2 | Louie Zong — Jazz | 0.651841 |
| | 3 | Chet Baker Trio — Someday My Prince Will Come | 0.567227 |
| | 4 | Herb Ellis • Remo Palmier — Windflower | 0.548796 |
| | 5 | Kan Gao, feat. Laura Shigihara — To the Moon: Original Soundtrack | 0.525699 |
| aggressive 90s boom bap | 1 | A Tribe Called Quest — The Anthology | 0.402020 |
| | 2 | Various Artists — Bound Together: ReBound | 0.327404 |
| | 3 | Kanye West — My Beautiful Dark Twisted Fantasy | 0.316136 |
| | 4 | Earl Sweatshirt — SICK! | 0.298787 |
| | 5 | Childish Gambino — STN MTN | 0.282317 |

These rankings reflect the fixed partially embedded library, rather than all
6,400 albums. Validation used `agent-run-long` for **50 plugin Python tests,
four HTTP/supervisor Python tests and 27 Node tests**, targeted
`embed`, `embed-worker` and viewer package builds, the locked-launcher export,
and real endpoint/equivalence/MDWE checks. Heavy dependencies were already
cached; `nix flake check --no-build --print-build-logs` also passed on
x86_64-linux. No Torch/ROCm or aggregate package compilation was run. Browser/WebGL
interaction and the deployed systemd/proxy wiring remain rollout checks.

The style family is Discogs-EffNet v1 (1280 dimensions, 16 kHz), with Discogs-400
styles, MTG-Jamendo mood/theme (56) and instrument (40), and approachability and
engagement regression heads. Valence/arousal is deferred: the published DEAM
and EmoMusic heads require different encoders, rather than EffNet embeddings.
The text family is **AMCLAP AllMusicCaps TE-trained SigReg** (512 dimensions,
24 kHz), selected instead of LAION-CLAP. This is a two-family pipeline; neither
MAEST nor another encoder is added.

Model review, checked October 5, 2026 (costs below are relative architecture
costs, not measurements on this host). Tagging/probing scores and retrieval
scores measure different tasks; there is no common benchmark proving a single
best model for personal album similarity.

| Option and primary sources | Quality evidence and fit | Weights / personal local license | CPU, AMD and Nix feasibility |
| --- | --- | --- | --- |
| [Discogs-EffNet](https://essentia.upf.edu/models/feature-extractors/discogs-effnet/) | Editorial style representation, established cheap heads; official Discogs style ROC-AUC .954 / PR-AUC .206, not a nearest-neighbor score | Public ONNX, CC BY-NC-SA 4.0 | Small 18 MB encoder, inexpensive CPU; ONNX avoids TensorFlow. **Style pick.** |
| [MAEST](https://archives.ismir.net/ismir2023/paper/000098.pdf), [weights](https://huggingface.co/MTG/discogs-maest-30s-pw-129e) | Stronger Discogs tagging in its paper; no universal similarity win established | Public weights, CC BY-NC-SA 4.0 | Transformer, more expensive inference and preprocessing/export work; explicitly deferred |
| [MERT](https://huggingface.co/m-a-p/MERT-v1-330M), [paper](https://arxiv.org/abs/2306.00107) | Strong transferable music representations; not a joint text model or direct replacement for EffNet heads | Public 95M/330M checkpoints, CC BY-NC-SA 4.0 | Heavier CPU Torch; AMD depends on usable ROCm Torch cache; custom preprocessing/layer choice needed |
| [MuQ / MuQ-MuLan](https://github.com/tencent-ailab/MuQ), [paper](https://arxiv.org/abs/2501.01108) | Strong representation and text/music retrieval results against older baselines; AMCLAP's evaluation does not settle a head-to-head comparison | Public weights, CC BY-NC-SA 4.0 | Larger towers, substantial CPU/weight cost; Torch dependency stack and ROCm cache constraints |
| [LAION-CLAP music](https://huggingface.co/laion/larger_clap_music), [code](https://github.com/LAION-AI/CLAP) | Established open audio/text baseline, music-trained checkpoint; newer AMCLAP reports better music retrieval on its evaluated benchmarks | Public weights, CC0; code Apache-2.0 | 48 kHz HTSAT and text tower; relatively heavy CPU, export/frontend integration required; practical fallback candidate |
| [Microsoft CLAP](https://github.com/microsoft/CLAP), [weights](https://huggingface.co/microsoft/msclap) | General audio/text model; no clear advantage over newer music-specific retrieval models established here | Public 2023 weights, MS-PL; code MIT | Torch/audio dependencies and substantial encoder; same AMD cache limitation |
| [CLaMP3](https://github.com/sanderwood/clamp3), [paper](https://aclanthology.org/2025.findings-acl.133/) | Strong multimodal music retrieval; benchmark overlap and differing tasks complicate comparison | Public weights; code MIT, inherited MERT weights CC BY-NC-SA | Multiple encoders and larger packaging surface; costly CPU, no cheap EffNet-compatible heads |
| [AMCLAP](https://arxiv.org/abs/2608.25244), [code](https://github.com/MTG/allmusiccaps), [checkpoint](https://huggingface.co/mtg-upf/allmusiccaps_te_trained_sigreg) | Music-specific captions from album reviews; paper reports gains over open CLAP baselines, especially human-written Song Describer queries | Public weights, CC BY-NC-SA 4.0; code AGPL-3.0-or-later | 78M audio / MPNet text towers; pinned older text dependencies, cached CPU Torch. **Text pick.** |

AMCLAP is a practical improvement for descriptive music queries, without
claiming that it beats MuQ-MuLan on an unreported comparison. Newer model names
alone are insufficient: an available checkpoint, applicable retrieval evidence,
and a reproducible local runtime are required. Model licenses above permit
personal noncommercial local use; they are distinct from this plugin's
AGPL-3.0-or-later license. No AudioMuse-AI code is included.

The default worker uses ONNX Runtime for EffNet and its heads, and CPU PyTorch for
AMCLAP, in a separate Python 3.13 environment. Beets keeps its existing Python
environment. AMCLAP/OMAR source commits, checkpoints, tokenizer files,
configuration and MPNet initialization weights are fixed-output Nix fetches in
`runtime.nix` and `models.nix`. Runtime downloads are disabled. The loader remaps
OMAR keys, removes its unused pretraining logit head, then strictly loads every
audio projection, text projection and fine-tuned text tensor. An upstream
partial-load fallback would otherwise risk silently using base MPNet weights.

The default package retains the CPU worker. The optional x86_64-linux package
`beets-embed-worker-rocm` accelerates AMCLAP on `link`'s RX 7800 XT
(`gfx1101`), while EffNet and its heads still use CPU ONNX Runtime. Add this package separately
to the host's declarative package list to put its executable on `PATH`; it is
not a dependency of the default beets package. For a temporary invocation:

```sh
nix shell .#default .#beets-embed-worker-rocm --command beet embed --device rocm
```

The source build, native GPU probe, real-model smoke and 100-track comparison
passed on October 5, 2026. All results below are **provisional, pre-CPU-swap**.

`device: cpu` always uses the original worker. `auto` discovers the ROCm worker
on `PATH` and selects it only after a subprocess probe passes. The probe has a
30-second deadline, requires HIP-backed Torch, executes matrix multiplication,
convolution, and a Torch elementwise kernel on the GPU, synchronizes, and
compares finite results against CPU with `rtol=1e-4`, `atol=1e-4`.
Missing executables, crashes, timeouts, and
incorrect results fall back to CPU with a reason. Explicit `device: rocm` (or
`--device rocm`) instead fails clearly; `gpu` remains a compatibility alias for
automatic selection with fallback. Direct worker commands also probe before
GPU inference. Selection happens after beets connections close and before the
vector store opens; changing devices does not change model IDs or invalidate
existing vectors. Inference failures retain completed families for resume.

The worker uses nixpkgs Torch 2.13.0 built from source with only Torch's GPU
target list set to `gpuTargets = [ "gfx1101" ]`. This pin pairs Torch with
AOTriton 0.11.1b, whose fused-attention API fails to compile against Torch 2.13.
Torch's `cmake/External/aotriton.cmake` requests AOTriton 0.12b. The ROCm
Torch override disables both optional fused paths with
`USE_FLASH_ATTENTION=0` and `USE_MEM_EFF_ATTENTION=0`, preserving ordinary
GPU attention. The source guards exclude `mha_all_aot.hip` from the build
and all AOTriton includes/calls from the generic `attention.hip`,
`attention_backward.hip` and `sdp_utils.cpp` translation units. ROCm libraries
retain their original hashes, and torchaudio, torchcodec and other Torch consumers share the same
ROCm Torch. Torchcodec's upstream tests are disabled in this variant to avoid
a test-only torchvision GPU build; its import check remains enabled, and the
worker smoke covers actual audio/text inference. No global ROCm target setting,
MIGraphX, system configuration change, or binary-cache publication is involved.
Native gfx1101 was verified at runtime; no `HSA_OVERRIDE_GFX_VERSION` was
needed. Torch can emit an expected warning that memory-efficient attention
was not compiled, then use ordinary GPU attention.

Before a source build, inspect its complete build/fetch list:

```sh
nix build .#beets-embed-worker-rocm --dry-run
agent-run-long --label embed-rocm-build --timeout 3h -- \
  nix build .#beets-embed-worker-rocm --no-link --print-out-paths \
  --print-build-logs --max-jobs 1 --cores 4 \
  --option substituters https://cache.nixos.org
nix run .#beets-embed-worker-rocm -- probe-rocm
nix run .#beets-embed-worker-rocm -- smoke --device rocm
```

On `link`, start compilation only between 09:00 and 21:00 America/New_York and
keep the timeout ending by 00:45, leaving the 01:00–08:59 xtractor backfill
its CPU window. Preflight on October 5, 2026 confirmed unchanged `clr`,
`rocblas`, `miopen`, and `hipblaslt` outputs on cache.nixos.org. Torch was the
only large compilation; other builds were small Python packages, torchcodec,
and environment helpers. The initial fetch list was 3.3 GiB download /
11.3 GiB unpacked. The first eight-core attempt failed on the AOTriton API
mismatch after 77.1 minutes, with 15.3 GiB peak sampled aggregate builder RSS.
The successful rebuild used four cores and the Torch-local fused-attention
workaround.
Its dry-run list contains Torch and 13 small dependent packages/environment
helpers, with no ROCm library builds or further downloads.

**Provisional, pre-swap validation:** `link` has a confirmed failing CPU with
machine checks and crashed at 11:28 on October 5. The four-core restart and
all results from this run must be revalidated after the CPU replacement.
Passing GPU/CPU comparisons establish consistency for this run, not trust in
the build hardware. Preserve the exact Torch and AMCLAP output paths recorded
with the measurements so those outputs can be deleted and rebuilt after the
swap. Crashes, NaNs, vector mismatches, and non-deterministic failures during
this run are potentially hardware-caused. Repeatable
compiler errors must instead be diagnosed from the source and build logs.

The first four-core restart exited with status 1 after **6,385.925 seconds
(106.4 minutes)**, with **8.91 GiB peak sampled aggregate builder RSS**
(one-second samples of all `nixbld` processes). It reached step 2,968/3,311;
the compiler reported undeclared `cookie` in `aotriton_adapter.h` and missing
`attn_options::deterministic` while compiling `attention.hip` and
`attention_backward.hip`. Both attempts failed deterministically because
Torch expects AOTriton 0.12b but the pin supplies 0.11.1b. The initial
`USE_FLASH_ATTENTION=0` workaround omitted the memory-efficient attention
path; disabling `USE_MEM_EFF_ATTENTION` addresses that remaining path.
The earlier attribution to possible CPU failure was incorrect. That failure's
log is `/tmp/opencode/agent-run-long.embed-rocm-restart.436PqtHHrn/output.log`.

With both flags disabled, the four-core build succeeded in **7,767.246 seconds
(2 h 9 min 27 s)**, starting at 17:24 America/New_York and finishing at 19:33,
well before the 00:45 deadline. Peak sampled aggregate builder RSS was
**10.33 GiB**, including torchaudio's tests; the metric sums all `nixbld`
process RSS once per second, so shared pages can be counted more than once.
Both previously failing attention translation units compiled successfully.
Torchaudio reported 2,247 passed, 2,301 skipped, 270 deselected and one expected
failure; GPU access is validated separately outside the Nix sandbox. The
worker runtime closure is **18,377,677,144 bytes (17.1 GiB)** and contains one
ROCm Torch, shared by torchaudio, torchcodec and AMCLAP. The successful log is
`/tmp/opencode/agent-run-long.embed-rocm-both-attention.iJixU0rr3X/output.log`.
No build outputs were published to a binary cache.

Exact realized outputs from this **provisional, pre-CPU-swap** build follow.
Retain these paths so the Torch and AMCLAP outputs and their dependent worker
can be discarded and rebuilt after the CPU replacement:

```text
Torch out:    /nix/store/zvwnyi7rm8s4da3j8gvy6rb6m3hh974f-python3.13-torch-2.13.0
Torch lib:    /nix/store/fvksf8134gsiigng994yl4b64s92awva-python3.13-torch-2.13.0-lib
Torch dev:    /nix/store/xz482a5r9iam574a7vri1ag86ag2h4g2-python3.13-torch-2.13.0-dev
Torch cxxdev: /nix/store/gbci3vvaws211brdjmmdvbvxc4y8v5b5-python3.13-torch-2.13.0-cxxdev
Torch dist:   /nix/store/n13dlqmw1rgh4ccc5z09bj7p1mhs29xr-python3.13-torch-2.13.0-dist
AMCLAP out:   /nix/store/z0wrm3pwv4g7yj232cqpwnn71r4qlx6s-python3.13-amclap-0.1.0
AMCLAP dist:  /nix/store/d8vbkqp1wvvkrq6q1zpf9kfyhxbz1a3n-python3.13-amclap-0.1.0-dist
Worker:       /nix/store/sk6yp0wn39nkkp5nqxlifd8gdq7gszd4-beets-embed-worker-rocm
```

Provisional pre-swap checks passed: all 25 plugin unit tests,
`nix flake check --print-build-logs`, and the default package build through
`agent-run-long`. The default closure contains no ROCm worker or checked ROCm
core libraries. The bounded native probe completed in five seconds on
`AMD Radeon RX 7800 XT`, HIP `7.2.53211`, with CPU/GPU results within its
`1e-4` tolerances. An actual CPU-worker `smoke --device auto`, with the optional
worker on `PATH`, handed off to ROCm and completed real EffNet, AMCLAP audio
and text inference with finite outputs in ten seconds. GPU properties reported
native `gfx1101` and 17,163,091,968 bytes of VRAM.

FFmpeg decodes a track once to mono 48 kHz floating-point audio. A polyphase
resampler produces 16/24 kHz streams in 30-second blocks with filter halos.
Temporary audio is stored on disk, limiting RAM even for long recordings.
EffNet uses symmetric Hann FFT512, hop256, 96 Slaney mel bands, unit-area
triangles, and `log10(1 + 10000 * power)`, with 128-frame patches at hop62.
Final incomplete patches repeat their frames; AMCLAP uses consecutive 10-second
windows and a final full window aligned to the end (short recordings are
zero-padded). EffNet frame centers start at zero and continue at hop256 before
EOF; boundary frames are zero-padded. All recording audio is covered. Track vectors store population
mean and std; AMCLAP windows are normalized before pooling. Heads store means.
One preparation overlaps one inference, with at most two prepared tracks.

Worker stage profiling is always enabled. Every 100 computed tracks, stderr
receives a compact JSON line with `event: "embed_profile"` and `scope: "interval"`.
Use `--profile-every N` on the worker, or `BEETS_EMBED_PROFILE_EVERY=N` through a
launcher, to change this interval. Existing per-track progress lines are unchanged.
The final counts JSON on stdout contains `profiling` for the whole `process()` run,
including short, empty, failed and gracefully interrupted runs.

`stages_seconds` reports `n`, `mean`, `p50` and `p95` in wall-clock seconds:
`prep_wait` is the inference loop's wait for its prepared track; `prep` is total
audio preparation measured in its thread; `decode` is FFmpeg and `resample` is
both 16/24 kHz resamples; `style` and `text` cover their complete inference calls,
including frontend work and output transfers; `store` sums the track's family
commits. Decode and resample are components of prep, and prep overlaps inference,
so do not add every stage mean to estimate elapsed time. Samples cover successful
computed tracks; family stages count only tracks that needed that family. Zero
samples have zero statistics. Timing samples use seven compact numeric arrays
(at most 56 bytes per computed track, plus allocation overhead); percentiles are
exact and computed only at summary boundaries.

`tracks_per_second` is computed tracks divided by reporting-period elapsed time.
`prep_wait_fraction` divides all preparation waits, including unsuccessful attempts,
by `loop_seconds`, the time spent in inference-loop iterations. A high fraction
indicates preparation cannot keep up; high Style/Text times with low wait indicate
inference dominates. A high p95 reveals stalls or unusually long recordings. Lazy
AMCLAP initialization is included in the first Text timing; model construction
before `process()` is excluded. Skips and shutdown cleanup contribute to elapsed
time. Periodic statistics cover the latest interval; final statistics cover the
whole run. ONNX session threads block while idle, and Torch uses the configured
intra-op count with one inter-op thread.

The external SQLite store uses WAL and per-family commits. Mean/std blobs are
little-endian float16, head scores float32; labels and full model provenance
are shared in the `models` table. A vector key includes beets ID, absolute
path/size/mtime-ns fingerprint, and a model identity covering pinned asset
hashes, source versions and preprocessing. File stats are checked again before
commit. Moving, retagging, replacing or changing a checkpoint triggers
recomputation; old vectors are retained and excluded from current search.
This conservative stat fingerprint is not an audio-content hash: changes that
preserve both size and mtime cannot be detected. Back up the external store
with a SQLite-aware backup or while the worker is stopped, including its WAL.

Commands snapshot beets metadata in ID ranges of 512 and close all beets
connections before filesystem work or inference. Flex queries are matched
after each bounded page is fetched. No beets attributes, tags or transactions
are written by inference. SIGTERM/SIGINT are forwarded to the worker; completed
families stay committed and the next invocation resumes. A failed/changed
track is reported, processing continues, and the command returns a failure
status. `--count-only` opens no inference runtime and creates no vector store.

Build and verification:

```sh
nix flake check --print-build-logs
nix build .#packages.x86_64-linux.default --print-build-logs
nix run .#embed-worker -- smoke
```

Unit tests use synthetic vectors and fake inference. They cover float16/head
round trips, incremental skip, changed fingerprints/checkpoints, partial
termination/resume, ranking, album weights/coverage, actual beets lock release,
bounded flex queries, resampling seams, and a deterministic frontend fixture
generated with Essentia 2.1b6.dev1438. Device tests mock worker discovery and
probes, covering CPU bypass, ROCm selection, timeout/crash/malformed-response
fallback, explicit ROCm errors, and direct worker device mapping without a GPU.
The separate smoke command runs all real
models on a three-second tone, then a text query; it works with an empty model
cache. The supported packaged target is x86_64-linux.

On October 5, 2026, a benchmark on `link` (Ryzen 7 5800X) used **only a file
copy** of the live beets database, with a temporary configuration and vector
store. File metadata was checked around the copy and `integrity_check` ran on
the copy. The deterministic sample spanned the library's item IDs: 100 existing
tracks, 60–600 seconds long, averaging 203.93 seconds. Both families covered
whole recordings: 20,495 EffNet patches and 2,085 AMCLAP windows. With two CPU
threads and batch size eight, all 100 tracks completed without failures in
949.605 seconds of worker time (954 seconds including command setup), or
**9.50 seconds/track**. The 12-thread xtractor backfill and other CPU work were
running concurrently, so this is a measurement under contention, not an idle
CPU estimate. A linear projection for 93,600 similar tracks is **10.3 days**
under the same conditions. This baseline used no GPU runtime.

The sample was selected from the copied database with
`SELECT id,path,length FROM items WHERE length BETWEEN 60 AND 600 ORDER BY (id * 7919) % 100000`,
keeping the first 100 existing files, resolving relative paths against the
configured music directory, then processing in ascending ID order. The saved
sample at `/tmp/beets-embed-benchmark-v51vn3z5/sample.json` has SHA-256
`31e53cbebd274a118c44a980817a2aba6f2f85c94b2023570949d8af359c8849`;
the ROCm comparison reuses those exact IDs rather than sampling a changing
library again. Always use `cp` to create a temporary beets database and a fresh
temporary vector store; never point benchmark commands at the live database.

**Provisional, pre-CPU-swap ROCm benchmark:** the optional worker processed
those exact 100 tracks with two CPU threads and batch size eight, using a fresh
temporary vector store and only the copied database's saved manifest. All 100
completed, with zero failures and no skipped tracks, covering the same 20,495
EffNet patches and 2,085 AMCLAP windows. Worker processing took **88.601 seconds**;
total wall time, including subprocess probe and model startup, was **92.101
seconds**, or **0.921 seconds/track** on average. Successive track-completion
intervals measured **0.724 seconds median / 1.577 seconds p95**; the first
interval included startup and took 8.402 seconds. Preparation overlaps
inference, so these intervals describe pipeline throughput rather than isolated
AMCLAP kernel latency. Throughput was **3,909 tracks/hour**, projecting to
**23.95 hours for 93,600 similar tracks** using total wall time. This run had
desktop CPU activity but no xtractor backfill; the CPU baseline's backfill
contention means the approximately 10.4-fold wall-time improvement also
includes differing background load.

Whole-card VRAM, sampled every 0.2 seconds, peaked at **2,340,970,496 bytes
(2.18 GiB)** including a **969,437,184-byte (0.90 GiB)** desktop baseline.
Torch's peak tensor allocation was **869,698,048 bytes (0.81 GiB)** and peak
reserved memory **956,301,312 bytes (0.89 GiB)**. All 200 stored vectors had
matching fingerprints, model identities, dimensions and window counts and
finite means/stds. Minimum CPU/GPU AMCLAP cosine was **0.9999999990649152**,
above the required 0.999; EffNet means/stds and all heads were identical.
The copied database, manifest, measurement harnesses and `metrics.json` /
`comparison.json` remain under `/tmp/beets-embed-rocm-benchmark-tg54mx6t/`.
Runtime caches were isolated there via `XDG_CACHE_HOME`,
`MIOPEN_CUSTOM_CACHE_DIR` and `MIOPEN_USER_DB_PATH`, and are also provisional.
Inference and comparison never opened the live beets database. Rebuild and
repeat this validation after the CPU swap before relying on these artifacts.

The 100-track store contained 200 vectors and 916,000 bytes of vector/head
payload: **9,160 bytes/track**. The checkpointed SQLite file measured 1,294,336
bytes, approximately **12.6 KiB/track**, projecting to roughly **1.2 GB** for
the full library before retained versions and WAL growth. Pinned model assets
total about 1.20 GB. CPU Torch/ONNX Runtime came from the Nix cache; building the
small pinned Python overrides and worker took about 97 seconds, while the
combined package plus existing beets suite took about 141 seconds. Text search
and album similarity were exercised against the temporary store, including
JSON output and incomplete album coverage. A count scan of the copied full
library took six seconds and reported 100 existing unreadable paths separately.
Rerunning the same 100-track embedding command skipped all 100: zero inference
work, no failures, 0.037 seconds in the worker and two seconds for the command.
