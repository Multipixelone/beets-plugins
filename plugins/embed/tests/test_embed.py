import json
import os
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from scipy.signal import resample_poly

from beets_embed.audio import amclap_windows, effnet_patches, musicnn_frames, resample_file
from beets_embed.inference import Moments, strict_checkpoint
from beets_embed.retrieval import album_vectors, rank, similar
from beets_embed.store import Store, count_pending, fingerprint, model_ids
from beets_embed.worker import process
from beets_embed.devices import PROBE_TIMEOUT, probe_worker, select_worker


class DeviceTests(unittest.TestCase):
    def test_cpu_does_not_discover_or_probe(self):
        with patch("beets_embed.devices.shutil.which") as discover, \
             patch("beets_embed.devices.probe_worker") as probe:
            self.assertEqual(select_worker("cpu", "/cpu"), ("/cpu", "cpu"))
            discover.assert_not_called()
            probe.assert_not_called()

    def test_missing_variant_and_legacy_gpu_fall_back(self):
        with patch("beets_embed.devices.shutil.which", return_value=None):
            for device in ("auto", "gpu"):
                self.assertEqual(select_worker(device, "/cpu"), ("/cpu", "cpu"))
            with self.assertRaisesRegex(ValueError, "not installed"):
                select_worker("rocm", "/cpu")

    def test_installed_variant_requires_successful_probe(self):
        with patch("beets_embed.devices.shutil.which", return_value="/rocm"), \
             patch("beets_embed.devices.probe_worker", return_value={"ok": True}) as probe:
            for device in ("auto", "rocm", "gpu"):
                self.assertEqual(select_worker(device, "/cpu"), ("/rocm", "rocm"))
            probe.assert_called_with(["/rocm"])
        with patch("beets_embed.devices.shutil.which", return_value="/rocm"), \
             patch("beets_embed.devices.probe_worker", side_effect=ValueError("kernel mismatch")):
            self.assertEqual(select_worker("auto", "/cpu"), ("/cpu", "cpu"))
            with self.assertRaisesRegex(ValueError, "kernel mismatch"):
                select_worker("rocm", "/cpu")

    def test_probe_is_bounded_and_validates_response(self):
        success = SimpleNamespace(returncode=0, stdout='{"backend":"rocm","ok":true}', stderr="")
        with patch("beets_embed.devices.subprocess.run", return_value=success) as run:
            self.assertTrue(probe_worker(["/rocm"])["ok"])
            self.assertEqual(run.call_args.args[0], ["/rocm", "probe-rocm"])
            self.assertEqual(run.call_args.kwargs["timeout"], PROBE_TIMEOUT)
        for output in ("garbage", "[]", '{"backend":"cpu","ok":true}',
                       '{"backend":"rocm","ok":false}'):
            with self.subTest(output=output), patch("beets_embed.devices.subprocess.run",
                    return_value=SimpleNamespace(returncode=0, stdout=output, stderr="")):
                with self.assertRaises(ValueError):
                    probe_worker(["/rocm"])

    def test_probe_timeout_crash_and_launch_failure(self):
        for error in (subprocess.TimeoutExpired("probe", PROBE_TIMEOUT), OSError("missing")):
            with self.subTest(error=error), patch("beets_embed.devices.subprocess.run", side_effect=error):
                with self.assertRaises(ValueError):
                    probe_worker(["/rocm"])
        with patch("beets_embed.devices.subprocess.run",
                   return_value=SimpleNamespace(returncode=-11, stdout="", stderr="GPU fault")):
            with self.assertRaisesRegex(ValueError, "status -11"):
                probe_worker(["/rocm"])

    def test_unknown_config_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Unknown embedding device"):
            select_worker("typo", "/cpu")

    def test_direct_rocm_worker_probe_failure_policy(self):
        from beets_embed.worker import main
        class StopBeforeInference(Exception):
            pass
        with patch.dict(os.environ, {"BEETS_EMBED_BACKEND": "rocm"}), \
             patch("beets_embed.worker.probe_worker", side_effect=ValueError("GPU fault")), \
             patch("beets_embed.inference.Models", side_effect=StopBeforeInference) as models:
            with patch("sys.argv", ["worker", "smoke", "--assets", "/assets", "--device", "rocm"]):
                with self.assertRaisesRegex(ValueError, "GPU fault"):
                    main()
                models.assert_not_called()
            with patch("sys.argv", ["worker", "smoke", "--assets", "/assets", "--device", "auto"]):
                with self.assertRaises(StopBeforeInference):
                    main()
                self.assertEqual(models.call_args.args[2], "cpu")

    def test_direct_rocm_worker_maps_device_and_cpu_bypasses_probe(self):
        from beets_embed.worker import main
        class StopBeforeInference(Exception):
            pass
        with patch.dict(os.environ, {"BEETS_EMBED_BACKEND": "rocm"}), \
             patch("beets_embed.worker.probe_worker", return_value={"ok": True}) as probe, \
             patch("beets_embed.inference.Models", side_effect=StopBeforeInference) as models:
            for requested, expected in (("cpu", "cpu"), ("rocm", "cuda:0")):
                probe.reset_mock()
                with patch("sys.argv", ["worker", "smoke", "--assets", "/assets", "--device", requested]):
                    with self.assertRaises(StopBeforeInference):
                        main()
                self.assertEqual(models.call_args.args[2], expected)
                if requested == "cpu":
                    probe.assert_not_called()
                else:
                    probe.assert_called_once()

    def test_verified_worker_handoff_does_not_repeat_probe(self):
        from beets_embed.worker import main
        class StopBeforeInference(Exception):
            pass
        with patch.dict(os.environ, {"BEETS_EMBED_BACKEND": "cpu"}), \
             patch("sys.argv", ["worker", "smoke", "--assets", "/assets"]), \
             patch("beets_embed.worker.select_worker", return_value=("/rocm", "rocm")), \
             patch("beets_embed.worker.os.execv", side_effect=StopBeforeInference) as launch:
            with self.assertRaises(StopBeforeInference):
                main()
            self.assertIn("--probe-passed", launch.call_args.args[1])
        with patch.dict(os.environ, {"BEETS_EMBED_BACKEND": "rocm"}), \
             patch("sys.argv", ["worker", "smoke", "--assets", "/assets", "--device", "rocm", "--probe-passed"]), \
             patch("beets_embed.worker.probe_worker") as probe, \
             patch("beets_embed.inference.Models", side_effect=StopBeforeInference) as models:
            with self.assertRaises(StopBeforeInference):
                main()
            probe.assert_not_called()
            self.assertEqual(models.call_args.args[2], "cuda:0")


class FakePrepared:
    def __init__(self, path):
        self.path = path
        self.closed = False

    def close(self):
        self.closed = True


class FakeModels:
    def __init__(self):
        self.calls = 0

    def style(self, prepared, batch):
        self.calls += 1
        return np.array([1., 0.]), np.array([.5, .25]), {}, 3

    audio_text = style


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = Store(self.root / "vectors.db")
        self.addCleanup(self.store.close)
        self.models = {"style": "style:v1", "text": "text:v1"}
        self.tracks = []
        for i in range(1, 5):
            path = self.root / f"{i}.wav"
            path.write_bytes(b"audio")
            self.tracks.append({"id": i, "path": str(path), "album_id": i,
                                "artist": "Artist", "title": str(i), "album": str(i)})

    def put(self, track, vector, model="style:v1"):
        self.store.put(track["id"], fingerprint(track["path"]), model,
                       vector, np.zeros(len(vector)))

    def test_round_trip_and_versions(self):
        track = self.tracks[0]
        content = fingerprint(track["path"])
        heads = {"mood": {"labels": ["happy", "sad"], "scores": [.1, .9]}}
        self.store.put(1, content, "v1", [1.234, 2.5], [.2, .3], heads, 9)
        row = self.store.get(1, content, "v1")
        np.testing.assert_allclose(row["mean"], [1.234, 2.5], atol=.001)
        np.testing.assert_allclose(row["std"], [.2, .3], atol=.0003)
        np.testing.assert_allclose(row["heads"]["mood"]["scores"], [.1, .9], atol=1e-7)
        self.assertEqual(row["heads"]["mood"]["labels"], ["happy", "sad"])
        self.assertEqual(row["windows"], 9)
        self.assertFalse(self.store.has(1, content, "v2"))

    def test_incremental_fingerprint_and_checkpoint_changes(self):
        engine = FakeModels()
        self.assertEqual(process(self.tracks, self.store, self.models, engine, FakePrepared)["computed"], 4)
        self.assertEqual(engine.calls, 8)
        self.assertEqual(process(self.tracks, self.store, self.models, engine, FakePrepared)["skipped"], 4)
        Path(self.tracks[0]["path"]).write_bytes(b"changed audio")
        self.assertEqual(process(self.tracks, self.store, self.models, engine, FakePrepared)["computed"], 1)
        self.assertEqual(engine.calls, 10)
        models = dict(self.models, text="text:v2")
        process(self.tracks, self.store, models, engine, FakePrepared)
        self.assertEqual(engine.calls, 14)

    def test_file_changed_during_inference_not_committed(self):
        track = self.tracks[0]
        engine = FakeModels()
        def changed(prepared, batch):
            Path(track["path"]).write_bytes(b"retagged")
            return [1., 0.], [0., 0.], {}, 1
        engine.style = changed
        result = process([track], self.store, {"style": "v1"}, engine, FakePrepared)
        self.assertEqual(result["failed"], 1)
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM vectors").fetchone()[0], 0)

    def test_termination_retains_first_family_and_resumes(self):
        stopped = False
        engine = FakeModels()
        method = engine.style
        def stop_after_family(prepared, batch):
            nonlocal stopped
            result = method(prepared, batch)
            stopped = True
            return result
        engine.style = stop_after_family
        prepared = []
        def prepare(path):
            obj = FakePrepared(path)
            prepared.append(obj)
            return obj
        process(self.tracks, self.store, self.models, engine, prepare, stopping=lambda: stopped)
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM vectors").fetchone()[0], 1)
        self.assertTrue(all(obj.closed for obj in prepared))
        engine = FakeModels()
        process(self.tracks, self.store, self.models, engine, FakePrepared)
        self.assertEqual(engine.calls, 7)

    def test_count_only_does_not_create_store(self):
        path = self.root / "absent.db"
        counts = count_pending(self.tracks, path, self.models)
        self.assertEqual(counts["pending"], 4)
        self.assertFalse(path.exists())

    def test_exact_ranking_ignores_stale_vectors(self):
        for track, vector in zip(self.tracks, [[1, 0], [.8, .2], [0, 1], [-1, 0]]):
            self.put(track, vector)
        results = rank(album_vectors(self.store, self.tracks, "style:v1"), [1, 0], 3)
        self.assertEqual([r["id"] for r in results], [1, 2, 3])
        Path(self.tracks[0]["path"]).write_bytes(b"new")
        results = rank(album_vectors(self.store, self.tracks, "style:v1"), [1, 0], 3)
        self.assertEqual([r["id"] for r in results], [2, 3, 4])

    def test_equal_seed_album_weight_and_partial_coverage(self):
        self.tracks[1]["album_id"] = 1
        vectors = [[1, 0], [1, 0], [0, 1], [1, 1]]
        for track, vector in zip(self.tracks, vectors):
            self.put(track, vector)
        results = similar(self.store, self.tracks, "style:v1", {1, 2, 3}, 1)
        self.assertEqual(results[0]["id"], 4)
        self.assertAlmostEqual(results[0]["score"], 1., places=5)
        Path(self.tracks[1]["path"]).unlink()
        album = next(info for info, _ in album_vectors(self.store, self.tracks, "style:v1") if info["album_id"] == 1)
        self.assertEqual((album["embedded_tracks"], album["total_tracks"]), (1, 2))

    def test_invalid_vectors_and_schema(self):
        with self.assertRaises(ValueError):
            self.store.put(1, "x", "v1", [np.nan], [0])
        path = self.root / "future.db"
        with sqlite3.connect(path) as db:
            db.execute("PRAGMA user_version=99")
        with self.assertRaises(ValueError):
            Store(path)
        with sqlite3.connect(path) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 99)


class AudioTests(unittest.TestCase):
    def test_resampling_blocks_equal_whole_signal(self):
        signal = np.random.default_rng(42).normal(size=129003).astype("<f4")
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "source"
            signal.tofile(source)
            for divisor in (2, 3):
                target = Path(temp) / f"{divisor}"
                resample_file(source, target, divisor, block=6000)
                np.testing.assert_allclose(np.fromfile(target, dtype="<f4"),
                                           resample_poly(signal, 1, divisor), atol=1e-6)

    def test_frames_silence_and_frequency_locality(self):
        silence = np.zeros(16000, dtype="f4")
        frames = musicnn_frames(silence, np.array([0, 256, 512]))
        self.assertEqual(frames.shape, (3, 96))
        np.testing.assert_array_equal(frames, 0)
        tone = np.sin(2 * np.pi * 1000 * np.arange(16000) / 16000).astype("f4")
        frames = musicnn_frames(tone, np.array([1000]))
        self.assertTrue(29 <= frames.argmax() <= 33)

    def test_short_audio_and_tail_windows(self):
        signal = np.ones(100, dtype="f4")
        patches = list(effnet_patches(signal))
        self.assertEqual(len(patches), 1)
        self.assertEqual(patches[0].shape, (128, 96))
        windows = list(amclap_windows(np.arange(240001, dtype="f4")))
        self.assertEqual(len(windows), 2)
        self.assertEqual(windows[-1][-1], 240000)
        self.assertEqual(list(amclap_windows(signal))[0].shape, (240000,))

    def test_population_moments_match_numpy(self):
        values = np.random.default_rng(2).normal(size=(33, 4))
        stats = Moments()
        stats.add(values[:7])
        stats.add(values[7:])
        mean, std = stats.result()
        np.testing.assert_allclose(mean, values.mean(axis=0), atol=1e-7)
        np.testing.assert_allclose(std, values.std(axis=0), atol=1e-7)

    def test_frontend_matches_essentia_reference(self):
        # Essentia 2.1b6.dev1438 TensorflowInputMusiCNN, without a model.
        frame = (np.sin(np.arange(512, dtype="f4") * .071) * .25 +
                 np.cos(np.arange(512, dtype="f4") * .037) * .1).astype("f4")
        expected = json.loads(Path(__file__).with_name("musicnn-golden.json").read_text())
        actual = musicnn_frames(frame, np.array([256]))[0]
        np.testing.assert_allclose(actual, expected, atol=2e-5, rtol=1e-5)

    def test_strict_checkpoint_maps_audio_and_requires_text(self):
        class Module:
            def state_dict(self):
                return {"audio_encoder.model.net.weight": 1, "text_encoder.weight": 2}
            def load_state_dict(self, values, strict):
                self.values = values
                if set(values) != set(self.state_dict()):
                    raise RuntimeError("missing weights")
                assert strict
        module = Module()
        strict_checkpoint(module, {"net.weight": 1, "text_encoder.weight": 2})
        self.assertEqual(module.values, module.state_dict())
        with self.assertRaises(RuntimeError):
            strict_checkpoint(module, {"net.weight": 1})
        with self.assertRaises(ValueError):
            strict_checkpoint(module, {"unknown": 1})


class BeetsTests(unittest.TestCase):
    def test_sigterm_is_forwarded_to_worker(self):
        import signal
        from beetsplug.embed import run_worker
        received = []
        class Child:
            def poll(self):
                return None
            def send_signal(self, signum):
                received.append(signum)
            def wait(self):
                signal.raise_signal(signal.SIGTERM)
                return 143
        previous = signal.getsignal(signal.SIGTERM)
        with patch("beetsplug.embed.subprocess.Popen", return_value=Child()):
            self.assertEqual(run_worker(["fake-worker"]), 143)
        self.assertEqual(received, [signal.SIGTERM])
        self.assertEqual(signal.getsignal(signal.SIGTERM), previous)

    def test_snapshot_query_releases_beets_before_worker(self):
        from beets.library import Item, Library
        from beetsplug.embed import EmbedPlugin, snapshot
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "library.db"
            lib = Library(str(path))
            lib.add(Item(path=b"/some/file.wav", title="Seed", artist="A"))
            lib.add(Item(path=b"/another/file.wav", title="Other", artist="B"))
            self.assertEqual([t["title"] for t in snapshot(lib, ["artist:A"])], ["Seed"])
            self.assertEqual(len(list(snapshot(lib))), 2)
            first = lib.get_item(1)
            first["favorite"] = "yes"
            first.store()
            with patch.object(lib, "items", wraps=lib.items) as reads:
                self.assertEqual([t["title"] for t in snapshot(lib, ["favorite:yes"])], ["Seed"])
                self.assertTrue(all(call.args[0].clause()[0] is not None for call in reads.call_args_list))
            plugin = EmbedPlugin()
            cmd = plugin.commands()[0]
            opts, args = cmd.parser.parse_args(["--store", str(Path(temp) / "vectors"), "artist:A"])
            def worker(command):
                # Read the immutable manifest and write to the *test* beets DB
                # from another connection while inference is being invoked.
                rows = Path(command[command.index("--manifest") + 1]).read_text().splitlines()
                self.assertEqual(len(rows), 1)
                with sqlite3.connect(path, timeout=.1) as other:
                    other.execute("BEGIN EXCLUSIVE")
                    other.execute("UPDATE items SET title='Updated' WHERE artist='A'")
                self.assertFalse(lib._connections)
                return 0
            def select(device, cpu):
                self.assertFalse(lib._connections)
                return cpu, "cpu"
            with patch("beetsplug.embed.run_worker", worker), \
                 patch("beetsplug.embed.select_worker", select):
                cmd.func(lib, opts, args)


if __name__ == "__main__":
    unittest.main()
