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
and a 2D map are deferred. Search uses means; stored standard deviations are
available for later analysis. Scores are similarities, not calibrated relevance
probabilities.

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
`beets-embed-worker-rocm` is intended to accelerate AMCLAP on `link`'s RX 7800 XT (`gfx1101`),
while EffNet and its heads still use CPU ONNX Runtime. Add this package separately
to the host's declarative package list to put its executable on `PATH`; it is
not a dependency of the default beets package. For a temporary invocation:

```sh
nix shell .#default .#beets-embed-worker-rocm --command beet embed --device rocm
```

The ROCm source build is currently blocked, as recorded below. No working GPU
worker or GPU benchmark has been verified on this host yet.

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
`attention_backward.hip` and `sdp_utils.cpp` translation units. ROCm libraries retain their original
hashes, and torchaudio, torchcodec and other Torch consumers share the same
ROCm Torch. Torchcodec's upstream tests are disabled in this variant to avoid
a test-only torchvision GPU build; its import check remains enabled, and the
worker smoke covers actual audio/text inference. No global ROCm target setting,
MIGraphX, system configuration change, or binary-cache publication is involved.
Native gfx1101 is the intended target; no `HSA_OVERRIDE_GFX_VERSION` is set.

Before a source build, inspect its complete build/fetch list:

```sh
nix build .#beets-embed-worker-rocm --dry-run
agent-run-long --label embed-rocm-build --timeout 12h -- \
  nix build .#beets-embed-worker-rocm --no-link --print-out-paths \
  --print-build-logs --max-jobs 1 --cores 4 \
  --option substituters https://cache.nixos.org
nix run .#beets-embed-worker-rocm -- probe-rocm
nix run .#beets-embed-worker-rocm -- smoke --device rocm
```

On `link`, start compilation only between 09:00 and 21:00 America/New_York and
shorten the timeout to stop by 00:45, leaving the 01:00–08:59 xtractor backfill
its CPU window. Preflight on October 5, 2026 confirmed unchanged `clr`,
`rocblas`, `miopen`, and `hipblaslt` outputs on cache.nixos.org. Torch was the
only large compilation; other builds were small Python packages, torchcodec,
and environment helpers. The initial fetch list was 3.3 GiB download /
11.3 GiB unpacked. The first eight-core attempt failed on the AOTriton API
mismatch after 77.1 minutes, with 15.3 GiB peak sampled aggregate builder RSS.
The restart uses four cores and the Torch-local fused-attention workaround.
Its dry-run list contains Torch and 13 small dependent packages/environment
helpers, with no ROCm library builds or further downloads.

**Provisional, pre-swap validation:** `link` has a confirmed failing CPU with
machine checks and crashed at 11:28 on October 5. The four-core restart and
all results from this run must be revalidated after the CPU replacement.
Passing GPU/CPU comparisons establish consistency for this run, not trust in
the build hardware. Preserve the exact Torch and AMCLAP output paths recorded
with the measurements so those outputs can be deleted and rebuilt after the
swap. Crashes, NaNs, mismatches or unexpected test failures during this run
or non-deterministic failures are potentially hardware-caused. Repeatable
compiler errors must instead be diagnosed from the source and build logs.

The four-core restart exited with status 1 after **6,385.925 seconds
(106.4 minutes)**, with **8.91 GiB peak sampled aggregate builder RSS**
(one-second samples of all `nixbld` processes). It reached step 2,968/3,311;
the compiler reported undeclared `cookie` in `aotriton_adapter.h` and missing
`attn_options::deterministic` while compiling `attention.hip` and
`attention_backward.hip`. Both attempts failed deterministically because
Torch expects AOTriton 0.12b but the pin supplies 0.11.1b. The initial
`USE_FLASH_ATTENTION=0` workaround omitted the memory-efficient attention
path; disabling `USE_MEM_EFF_ATTENTION` addresses that remaining path.
The earlier attribution to possible CPU failure was incorrect.
The log is `/tmp/opencode/agent-run-long.embed-rocm-restart.436PqtHHrn/output.log`.
No ROCm worker or closure was produced, so GPU median/p95, throughput, VRAM,
full-library projection and CPU/GPU vector comparison remain unmeasured.
The copied DB and exact 100-track manifest remain at
`/tmp/beets-embed-rocm-benchmark-tg54mx6t/`, with temporary `benchmark.py` and
`compare.py` measurement harnesses for a later run; inference never
opened the live beets database.

Exact planned outputs for this attempt are below. All were absent after the
failure, so there are no resulting Torch/AMCLAP binaries from this attempt to
delete. Retain this record when rebuilding after the CPU swap:

```text
Torch out:    /nix/store/8d6b1yhl90wlpagvc23lakpkf43v3c6d-python3.13-torch-2.13.0
Torch lib:    /nix/store/ay5jnmkdspnjkwskz6waxdvz2glavpmw-python3.13-torch-2.13.0-lib
Torch dev:    /nix/store/iccg94j1w12jr5cf59jblyly7b518q7m-python3.13-torch-2.13.0-dev
Torch cxxdev: /nix/store/1fzs19z6ga17slnqkiksyi0aphw44n71-python3.13-torch-2.13.0-cxxdev
Torch dist:   /nix/store/ydxxrs30zvfk07s9jkvavr1a9q4ri7nv-python3.13-torch-2.13.0-dist
AMCLAP out:   /nix/store/pmlvf4q1vcs4rmm08vsig2gdpxxl86c5-python3.13-amclap-0.1.0
AMCLAP dist:  /nix/store/1i5jaypj2r6rgngbs5b6crkfpsqxiydl-python3.13-amclap-0.1.0-dist
Worker:       /nix/store/wsvdp1hvw6p57pp8aaji0lnbj3a7hq4b-beets-embed-worker-rocm
```

Provisional pre-swap checks passed: all 25 plugin unit tests,
`nix flake check --print-build-logs`, and the default package build through
`agent-run-long`. The default closure contains no ROCm worker or checked ROCm
core libraries. These checks do not establish GPU correctness.

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
