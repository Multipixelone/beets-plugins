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

The worker uses ONNX Runtime for EffNet and its heads, and CPU PyTorch for
AMCLAP, in a separate Python 3.13 environment. Beets keeps its existing Python
environment. AMCLAP/OMAR source commits, checkpoints, tokenizer files,
configuration and MPNet initialization weights are fixed-output Nix fetches in
`runtime.nix` and `models.nix`. Runtime downloads are disabled. The loader remaps
OMAR keys, removes its unused pretraining logit head, then strictly loads every
audio projection, text projection and fine-tuned text tensor. An upstream
partial-load fallback would otherwise risk silently using base MPNet weights.

`link` has an RX 7800 XT (`gfx1101`), but cache preflights at the repository pin
`e554fab72f81915600f3f449b786fd9af40439a5` and infra pin
`4975466d324710c576dc11ad614684e6bd8cad8e` require a local ROCm Torch source
build. The repository pin's ONNX Runtime MIGraphX variant also requires a local
source build. Those paths would fetch roughly 3.4 GiB / 12 GiB unpacked for
Torch, or 2.2 GiB / 7.3 GiB for ONNX Runtime, before compilation. They were not
built. `auto` selects the working cached CPU runtime; `--device gpu` reports
that choice and falls back to CPU. No GPU benchmark or gfx spoofing is claimed.
Infra's beets input retains this repository's own nixpkgs pin. Infra was only
read; wiring into its host configuration and timers remains separate work.

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
generated with Essentia 2.1b6.dev1438. The separate smoke command runs all real
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
under the same conditions. No GPU runtime was built or benchmarked.

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
