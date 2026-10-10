"""Read-only feasibility tool: nix run .#beets-embed-style-benchmark -- --help.

For real audio, pass --worker-config /path/to/beets-embed-backfill.json. Reports
are JSON on stdout, with progress on stderr; no files or store rows are saved.
"""

import argparse
import json
import os
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import time
from collections import Counter, defaultdict
from contextlib import closing
from pathlib import Path

import numpy as np

from .audio import PreparedAudio, batches, effnet_patches
from .inference import Models, Moments, onnx_options
from .store import Store, fingerprint, model_ids


def metrics(reference, actual):
    reference, actual = np.asarray(reference, dtype="f8"), np.asarray(actual, dtype="f8")
    if reference.shape != actual.shape or not np.isfinite([reference, actual]).all():
        raise ValueError("Shape mismatch or nonfinite parity output")
    delta = np.abs(reference - actual)
    left, right = np.linalg.norm(reference), np.linalg.norm(actual)
    cosine = (float(np.clip(np.dot(reference.ravel(), actual.ravel()) / (left * right), -1, 1))
              if left and right else float(left == right))
    return {"max_abs": float(delta.max()),
            "max_rel": float((delta / np.maximum(np.abs(reference), 1e-8)).max()),
            "cosine": cosine,
            "close": bool(np.all(delta <= 1e-4 + 1e-4 * np.abs(reference)))}


def worst(rows):
    return {"max_abs": max(row["max_abs"] for row in rows),
            "max_rel": max(row["max_rel"] for row in rows),
            "min_cosine": min(row["cosine"] for row in rows),
            "close": all(row["close"] for row in rows)}


def verdict(tracks):
    if not tracks:
        return "broken"
    cosines = [track["aggregates"]["stored_mean"]["cosine"] for track in tracks]
    # Adjacent fp16 bins can differ by more than the fp32 operator tolerance.
    # Judge that representation by cosine; judge computation before quantizing.
    checks = [metric for track in tracks for name, metric in track["aggregates"].items()
              if not name.startswith("stored_")]
    patch_close = all(row["close"] for track in tracks for row in track["patch_summary"].values())
    if min(cosines) >= .9999 and patch_close and all(row["close"] for row in checks):
        return "identical-for-practical-purposes"
    head_errors = [row["max_abs"] for track in tracks
                   for name, row in track["patch_summary"].items()
                   if name not in ("embeddings", "discogs_logits")]
    if min(cosines) >= .999 and max(head_errors) <= .001:
        return "slightly-off-but-sane"
    return "broken"


def sample_candidates(library, directory, seed=20261010):
    """Stable genre/duration sampling; database and music are only read."""
    library = Path(library).expanduser().absolute()
    with closing(sqlite3.connect(library.as_uri() + "?mode=ro", uri=True, timeout=5)) as db:
        db.execute("PRAGMA query_only=ON")
        rows = db.execute("SELECT id,path,genre,length,artist,album,title FROM items "
                          "WHERE length > 0 ORDER BY id").fetchall()
    directory = Path(directory).expanduser().absolute()
    tracks = []
    for item_id, path, genre, length, artist, album, title in rows:
        # Beets stores relative paths; match the backfill worker's normalization.
        path = Path(os.path.normpath(os.path.join(str(directory), os.fsdecode(path))))
        if not path.is_relative_to(directory) or not np.isfinite(length):
            continue
        tracks.append({"id": item_id, "path": str(path), "genre": genre or "unknown",
                       "length": length, "artist": artist, "album": album, "title": title})
    if not tracks:
        raise ValueError("No library tracks under the configured music directory")
    boundaries = np.quantile([track["length"] for track in tracks], [.25, .5, .75])
    rng = np.random.default_rng(seed)
    rng.shuffle(tracks)
    buckets = defaultdict(list)
    for track in tracks:
        track["duration_quartile"] = int(np.searchsorted(boundaries, track["length"]))
        buckets[(track["genre"], track["duration_quartile"])].append(track)
    genre_counts, duration_counts, used = Counter(), Counter(), set()
    while buckets:
        key = min(buckets, key=lambda k: (genre_counts[k[0]], duration_counts[k[1]], k))
        bucket = buckets[key]
        index = next((i for i, track in enumerate(bucket)
                      if (track["artist"], track["album"]) not in used), 0)
        track = bucket.pop(index)
        if not bucket:
            del buckets[key]
        if not Path(track["path"]).is_file():
            continue
        genre_counts[key[0]] += 1
        duration_counts[key[1]] += 1
        used.add((track["artist"], track["album"]))
        yield track


class Logits:
    """Expose pre-sigmoid logits without changing production sessions/assets."""
    def __init__(self, assets, threads, torch_engine):
        import onnx
        import onnxruntime as ort
        from .torch_style import convert, discogs_logit_name
        path = Path(assets) / "effnet.onnx"
        name = discogs_logit_name(path)
        graph = onnx.load(str(path))
        graph.graph.output.append(onnx.helper.make_tensor_value_info(
            name, onnx.TensorProto.FLOAT, [None, 400]))
        options = onnx_options(threads)
        self.onnx = ort.InferenceSession(graph.SerializeToString(), options,
                                        providers=["CPUExecutionProvider"])
        self.name = name
        self.torch = convert(path, [name]).to(torch_engine.device)
        self.device = torch_engine.device

    def compare(self, batch):
        import torch
        reference = self.onnx.run([self.name], {"melspectrogram": batch})[0]
        with torch.inference_mode():
            actual = self.torch(torch.from_numpy(batch).to(self.device))[-1].cpu().numpy()
        return reference, actual


def parity(patches, onnx_engine, torch_engine, logits):
    patch_rows = []
    stats = [{}, {}]
    offset = 0
    for batch in patches:
        outputs = [engine.style_batch(batch) for engine in (onnx_engine, torch_engine)]
        logit_outputs = logits.compare(batch)
        for values, moments in zip(outputs, stats):
            for name, value in values.items():
                moments.setdefault(name, Moments()).add(value)
        for index in range(len(batch)):
            values = {name: metrics(outputs[0][name][index], outputs[1][name][index])
                      for name in outputs[0]}
            values["discogs_logits"] = metrics(logit_outputs[0][index], logit_outputs[1][index])
            patch_rows.append({"patch": offset + index, "outputs": values})
        offset += len(batch)
    results = [{name: moment.result() for name, moment in moments.items()} for moments in stats]
    aggregate = {}
    for name in results[0]:
        for index, suffix in enumerate(("mean", "std")):
            aggregate[f"{name}_{suffix}"] = metrics(results[0][name][index], results[1][name][index])
    for index, suffix in enumerate(("mean", "std")):
        quantized = [result["embeddings"][index].astype("<f2").astype("f4") for result in results]
        aggregate[f"stored_{suffix}"] = metrics(*quantized)
    summaries = {name: worst([row["outputs"][name] for row in patch_rows])
                 for name in patch_rows[0]["outputs"]}
    return patch_rows, summaries, aggregate, results[1]


def timed(function, synchronize):
    synchronize()
    started = time.perf_counter()
    function()
    synchronize()
    return time.perf_counter() - started


def benchmark_track(track, args, engines, logits, synchronize):
    start_fingerprint = fingerprint(track["path"])
    started = time.perf_counter()
    prepared = PreparedAudio(track["path"], args.ffmpeg)
    prep_seconds = time.perf_counter() - started
    try:
        patches = list(batches(effnet_patches(prepared.samples(16000)), args.batch_size))
        patch_rows, summaries, aggregate, torch_result = parity(patches, *engines, logits)
        inference, style = {"onnx": [], "torch": []}, {"onnx": [], "torch": []}
        for repeat in range(args.repeats):
            order = (0, 1) if (track["id"] + repeat) % 2 else (1, 0)
            for index in order:
                engine = engines[index]
                key = engine.style_backend
                inference[key].append(timed(lambda: engine.style_batches(patches), synchronize))
                style[key].append(timed(lambda: engine.style(prepared, args.batch_size), synchronize))
    finally:
        prepared.close()
    end_to_end = []
    for _ in range(args.repeats):
        def run():
            audio = PreparedAudio(track["path"], args.ffmpeg)
            try:
                engines[1].style(audio, args.batch_size)
                engines[1].audio_text(audio, args.batch_size)
            finally:
                audio.close()
        end_to_end.append(timed(run, synchronize))
    if fingerprint(track["path"]) != start_fingerprint:
        raise ValueError("Track changed during benchmark")
    result = dict(track, patches=patch_rows, patch_summary=summaries, aggregates=aggregate,
                  windows=len(patch_rows), initial_prep_seconds=prep_seconds,
                  timing={"inference_seconds": inference, "style_seconds": style,
                          "torch_end_to_end_seconds": end_to_end})
    if args.store and args.stored_limit > 0:
        with Store(args.store, readonly=True) as store:
            stored = store.get(track["id"], start_fingerprint, model_ids()["style"])
        if stored:
            result["stored_comparison"] = {
                suffix: metrics(stored[suffix], torch_result["embeddings"][index])
                for index, suffix in enumerate(("mean", "std"))}
            result["stored_comparison"].update({
                name: metrics(stored["heads"][name]["scores"], torch_result[name][0])
                for name in stored["heads"]})
            args.stored_limit -= 1
    return result


def run(args):
    import torch
    from .threads import configure_torch_threads
    configure_torch_threads(args.threads)
    import onnx
    import onnxruntime as ort
    if not torch.version.hip or not torch.cuda.is_available():
        raise ValueError("This experiment requires HIP-backed Torch and an accessible AMD GPU")
    synchronize = torch.cuda.synchronize
    started = time.perf_counter()
    engines = [Models(args.assets, args.threads, style_backend="onnx"),
               Models(args.assets, args.threads, "cuda:0", style_backend="torch")]
    engines[1].load_text()
    synchronize()
    initialization_seconds = time.perf_counter() - started
    logits = Logits(args.assets, args.threads, engines[1])
    # Warm both full batches and single-patch tails outside measured intervals.
    for size in (args.batch_size, 1):
        batch = np.ones((size, 128, 96), dtype="f4")
        for engine in engines:
            engine.style_batch(batch)
        logits.compare(batch)
    with torch.inference_mode():
        engines[1].amclap.forward_audio(torch.zeros((1, 24000 * 10), device="cuda:0"))
    synchronize()
    torch.cuda.reset_peak_memory_stats()
    tracks, failures = [], []
    for track in sample_candidates(args.library, args.directory, args.seed):
        try:
            result = benchmark_track(track, args, engines, logits, synchronize)
        except Exception as exc:
            failures.append({"id": track["id"], "error": f"{type(exc).__name__}: {exc}"})
            print(f"Track {track['id']} failed: {exc}", file=sys.stderr, flush=True)
            # Numerical/model failures should not be hidden by sample replacement.
            if not isinstance(exc, (OSError, subprocess.CalledProcessError)):
                raise
            continue
        tracks.append(result)
        timing = result["timing"]
        print(f"{len(tracks):2d}/{args.count} item {track['id']} ({track['length']:.0f}s, "
              f"{track['genre']}): style ONNX {statistics.median(timing['style_seconds']['onnx']):.3f}s, "
              f"Torch {statistics.median(timing['style_seconds']['torch']):.3f}s, "
              f"mean cosine {result['aggregates']['stored_mean']['cosine']:.9f}",
              file=sys.stderr, flush=True)
        if len(tracks) == args.count:
            break
    if len(tracks) != args.count:
        raise ValueError(f"Only {len(tracks)} readable tracks; requested {args.count}")
    summary = {name: worst([track["aggregates"][name] for track in tracks])
               for name in tracks[0]["aggregates"]}
    patch_summary = {name: {"max_abs": max(t["patch_summary"][name]["max_abs"] for t in tracks),
                            "max_rel": max(t["patch_summary"][name]["max_rel"] for t in tracks),
                            "min_cosine": min(t["patch_summary"][name]["min_cosine"] for t in tracks)}
                     for name in tracks[0]["patch_summary"]}
    times = {kind: {backend: statistics.mean(statistics.median(t["timing"][kind][backend])
                                            for t in tracks) for backend in ("onnx", "torch")}
             for kind in ("inference_seconds", "style_seconds")}
    times["torch_end_to_end_seconds"] = statistics.mean(
        statistics.median(t["timing"]["torch_end_to_end_seconds"]) for t in tracks)
    times["style_speedup"] = times["style_seconds"]["onnx"] / times["style_seconds"]["torch"]
    return {"verdict": verdict(tracks), "tracks": tracks, "failures": failures,
            "aggregate_summary": summary, "patch_summary": patch_summary, "timing_summary": times,
            "environment": {"torch": torch.__version__, "hip": torch.version.hip,
                            "onnx": onnx.__version__, "onnxruntime": ort.__version__,
                            "gpu": torch.cuda.get_device_name(0), "threads": args.threads,
                            "batch_size": args.batch_size, "repeats": args.repeats, "seed": args.seed,
                            "model_ids": model_ids(), "initialization_seconds": initialization_seconds,
                            "gpu_peak_allocated_bytes": torch.cuda.max_memory_allocated(),
                            "gpu_peak_reserved_bytes": torch.cuda.max_memory_reserved(),
                            "gpu_memory_note": "includes the auxiliary parity-only EffNet module",
                            "timing_note": "two-thread comparison; concurrent GPU/CPU load may affect timing",
                            "relative_error_floor": 1e-8,
                            "discogs_outputs": "published sigmoid scores and pre-sigmoid logits"}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker-config", help="existing backfill JSON configuration (read-only)")
    parser.add_argument("--library")
    parser.add_argument("--directory")
    parser.add_argument("--assets", default=os.environ.get("BEETS_EMBED_MODELS"))
    parser.add_argument("--ffmpeg", default=os.environ.get("BEETS_EMBED_FFMPEG", "ffmpeg"))
    parser.add_argument("--store", help="optional stored-value comparison; opened strictly mode=ro")
    parser.add_argument("--stored-limit", type=int, default=5)
    parser.add_argument("--count", type=int, default=20)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--seed", type=int, default=20261010)
    args = parser.parse_args()
    if args.worker_config:
        config = json.loads(Path(args.worker_config).read_text())
        args.library = args.library or config["library"]
        args.directory = args.directory or config["directory"]
    if not args.assets or not args.library or not args.directory:
        parser.error("assets, library and directory are required")
    if (args.count < 1 or not 1 <= args.threads <= 16 or not 1 <= args.batch_size <= 128 or
            args.repeats < 1 or args.stored_limit < 0):
        parser.error("Invalid benchmark processing bounds")
    # Never use the service's caches, scratch directory, lock, or write path.
    with tempfile.TemporaryDirectory(prefix="beets-style-benchmark-") as temp:
        for name, suffix in (("MIOPEN_CUSTOM_CACHE_DIR", "miopen"), ("MIOPEN_USER_DB_PATH", "miopen-db")):
            path = Path(temp) / suffix
            path.mkdir()
            os.environ[name] = str(path)
        report = run(args)
    print(json.dumps(report, allow_nan=False, sort_keys=True))
    return 1 if report["verdict"] == "broken" else 0


if __name__ == "__main__":
    sys.exit(main())
