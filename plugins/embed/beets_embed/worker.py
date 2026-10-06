"""Persistent inference process with per-track commits and graceful termination."""

import argparse
import json
import os
import signal
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .store import Store, fingerprint, model_ids
from .devices import DEVICES, probe_rocm, probe_worker, select_worker


def process(tracks, store, models, engine, prepare, batch_size=8, stopping=lambda: False):
    counts = {"selected": 0, "computed": 0, "skipped": 0, "failed": 0}

    def pending():
        for track in tracks:
            if stopping():
                break
            counts["selected"] += 1
            try:
                content = fingerprint(track["path"])
                missing = [family for family, model in models.items()
                           if not store.has(track["id"], content, model)]
            except OSError as exc:
                counts["failed"] += 1
                print(f"Item {track['id']}: {exc}", file=sys.stderr)
                continue
            if not missing:
                counts["skipped"] += 1
                continue
            yield track, content, missing

    def preparation(job):
        try:
            return prepare(job[0]["path"]), None
        except Exception as exc:
            return None, exc

    # One preparation overlaps one inference. At most two tracks' temporary
    # audio exists; inference itself always has a single writer/model instance.
    jobs = iter(pending())
    with ThreadPoolExecutor(max_workers=1) as pool:
        job = next(jobs, None)
        future = pool.submit(preparation, job) if job is not None else None
        while job is not None:
            prepared, error = future.result()
            following = next(jobs, None) if not stopping() else None
            next_future = pool.submit(preparation, following) if following is not None else None
            track, content, missing = job
            try:
                if error is not None:
                    raise error
                if stopping():
                    break
                for family in missing:
                    if stopping():
                        break
                    method = engine.style if family == "style" else engine.audio_text
                    mean, std, heads, windows = method(prepared, batch_size)
                    if fingerprint(track["path"]) != content:
                        raise ValueError("File changed during inference; retry on the next run")
                    store.put(track["id"], content, models[family], mean, std, heads, windows)
                if not stopping():
                    counts["computed"] += 1
                    print(f"Embedded item {track['id']} ({counts['computed']} computed)", file=sys.stderr)
            except Exception as exc:
                counts["failed"] += 1
                print(f"Item {track['id']}: {type(exc).__name__}: {exc}", file=sys.stderr)
            finally:
                if prepared is not None:
                    prepared.close()
                # On termination clean an already scheduled preparation too.
                if stopping() and next_future is not None:
                    extra, _ = next_future.result()
                    if extra is not None:
                        extra.close()
            job, future = following, next_future
            if stopping():
                break
    return counts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["embed", "search", "similar", "smoke", "probe-rocm", "encode-text", "serve-text"])
    parser.add_argument("--manifest")
    parser.add_argument("--store")
    parser.add_argument("--assets", default=os.environ.get("BEETS_EMBED_MODELS"))
    parser.add_argument("--ffmpeg", default=os.environ.get("BEETS_EMBED_FFMPEG", "ffmpeg"))
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--device", choices=DEVICES, default="auto")
    parser.add_argument("--probe-passed", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--top-k", type=int, default=20)
    parser.add_argument("--text")
    parser.add_argument("--seeds", default="")
    parser.add_argument("--albums", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    if args.mode == "probe-rocm":
        print(json.dumps(probe_rocm()))
        return 0
    if not args.assets:
        parser.error("The packaged model assets are required")
    if not 1 <= args.threads <= 16 or not 1 <= args.batch_size <= 128 or args.top_k < 1:
        parser.error("Invalid processing bounds")
    if args.mode == "serve-text":
        if args.device != "cpu" or args.threads != 2:
            parser.error("serve-text requires --device cpu --threads 2")
        from .inference import Models
        engine = Models(args.assets, 2, "cpu", text_only=True)
        for line in iter(lambda: sys.stdin.readline(4097), ''):
            if len(line) > 4096 or not line.endswith('\n'):
                raise ValueError('Invalid text request size')
            request = json.loads(line)
            text = request.get('q') if isinstance(request, dict) else None
            if not isinstance(text, str) or not text.strip() or len(text.strip()) > 240:
                raise ValueError('Invalid text query')
            vector = engine.text(text.strip())
            if vector.shape != (512,):
                raise ValueError('Invalid text embedding dimension')
            print(json.dumps({'vector': vector.tolist(), 'model_id': model_ids()['text']},
                             allow_nan=False), flush=True)
        return 0
    if args.mode == "encode-text":
        # Deliberately precede all device selection, store and audio processing.
        if args.device != "cpu" or not args.manifest:
            parser.error("encode-text requires --device cpu and --manifest")
        phrases = json.loads(Path(args.manifest).read_text())
        if not isinstance(phrases, list) or not 1 <= len(phrases) <= 256 or any(
                not isinstance(text, str) or not text.strip() or len(text) > 240 for text in phrases):
            parser.error("Invalid text vocabulary")
        from .inference import Models
        engine = Models(args.assets, args.threads, "cpu", text_only=True)
        vectors = []
        for first in range(0, len(phrases), args.batch_size):
            vectors.extend(engine.text_batch(phrases[first:first + args.batch_size]).tolist())
        print(json.dumps(vectors, allow_nan=False))
        return 0
    device = "cpu"
    if os.environ.get("BEETS_EMBED_BACKEND") == "rocm" and args.device != "cpu":
        try:
            if not args.probe_passed:
                probe_worker([sys.executable, "-s", "-m", "beets_embed.worker"])
            device = "rocm"
        except ValueError as exc:
            if args.device == "rocm":
                raise
            print(f"Embedding device: cpu ({exc})", file=sys.stderr)
    elif args.device != "cpu":
        candidate, device = select_worker(args.device, None)
        if candidate:
            os.execv(candidate, [candidate, *sys.argv[1:], "--device", "rocm", "--probe-passed"])
    print(f"Embedding device: {device}", file=sys.stderr)
    from .inference import Models
    from .audio import PreparedAudio
    from .retrieval import available, album_vectors, rank, similar
    engine = Models(args.assets, args.threads, "cuda:0" if device == "rocm" else "cpu",
                    text_only=args.mode in ("search", "similar"))
    if args.mode == "smoke":
        import numpy as np
        import tempfile
        import wave
        with tempfile.TemporaryDirectory() as temp:
            path = str(Path(temp) / "tone.wav")
            with wave.open(path, "wb") as out:
                out.setnchannels(1)
                out.setsampwidth(2)
                out.setframerate(48000)
                out.writeframes((np.sin(np.arange(48000 * 3) * 440 * 2 * np.pi / 48000)
                                 * 10000).astype("<i2").tobytes())
            audio = PreparedAudio(path, args.ffmpeg)
            try:
                style = engine.style(audio, 2)
                text = engine.audio_text(audio, 1)
                query = engine.text("warm lo-fi folk with brushed drums")
                assert style[0].shape == (1280,) and text[0].shape == query.shape == (512,)
                assert all(np.isfinite(v).all() for v in (style[0], style[1], text[0], text[1], query))
                assert sum(len(h["scores"]) for h in style[2].values()) == 498
                print(json.dumps({"style": len(style[0]), "text": len(text[0]), "heads": 498,
                                  "audio_text_cosine": float(text[0] @ query)}))
            finally:
                audio.close()
        return 0
    if not args.manifest or not args.store:
        parser.error("manifest and store are required")
    models = model_ids()
    if args.mode == "embed":
        stopped = False
        def stop(*_):
            nonlocal stopped
            stopped = True
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        started = time.monotonic()
        with Store(args.store) as store, open(args.manifest) as rows:
            counts = process((json.loads(row) for row in rows), store, models, engine,
                             lambda path: PreparedAudio(path, args.ffmpeg),
                             args.batch_size, lambda: stopped)
        counts.update(seconds=round(time.monotonic() - started, 3), device=device,
                      interrupted=stopped)
        if device == "rocm":
            import torch
            counts.update(gpu_peak_allocated_bytes=torch.cuda.max_memory_allocated(),
                          gpu_peak_reserved_bytes=torch.cuda.max_memory_reserved())
        print(json.dumps(counts, sort_keys=True))
        return 143 if stopped else (1 if counts["failed"] else 0)
    with open(args.manifest) as rows:
        tracks = [json.loads(row) for row in rows]
    with Store(args.store, readonly=True) as store:
        if args.mode == "search":
            if not args.text:
                parser.error("text is required")
            candidates = album_vectors if args.albums else available
            results = rank(candidates(store, tracks, models["text"]), engine.text(args.text), args.top_k)
        else:
            seeds = {int(value) for value in args.seeds.split(",") if value}
            results = similar(store, tracks, models["style"], seeds, args.top_k)
    if args.json:
        print(json.dumps(results, ensure_ascii=True))
    else:
        for result in results:
            title = result["album"] if "embedded_tracks" in result else result["title"]
            coverage = (f" [{result['embedded_tracks']}/{result['total_tracks']} tracks]"
                        if "embedded_tracks" in result else "")
            print(f"{result['score']:.4f}\t{result['id']}\t{result['artist']} — {title}{coverage}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError) as exc:
        print(f"embed: {exc}", file=sys.stderr)
        sys.exit(1)
