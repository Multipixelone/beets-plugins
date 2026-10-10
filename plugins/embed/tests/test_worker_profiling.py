import contextlib
import io
import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from beets_embed.audio import PreparedAudio
from beets_embed.profiling import Profile
from beets_embed.worker import process


class ProfileTests(unittest.TestCase):
    def test_exact_interval_and_whole_run_statistics(self):
        output = io.StringIO()
        with patch("beets_embed.profiling.time.perf_counter", side_effect=[100, 110, 111, 120]), \
             contextlib.redirect_stderr(output):
            profile = Profile(2)
            profile.iteration(6, 2)
            profile.computed_track({"prep": 1, "style": 2})
            profile.iteration(4, 1)
            profile.computed_track({"prep": 3, "text": 4})
            profile.iteration(5, 0)
            profile.computed_track({"prep": 5})
            final = profile.summary()
        interval = json.loads(output.getvalue())
        self.assertEqual(interval["scope"], "interval")
        self.assertEqual(interval["computed"], 2)
        self.assertEqual(interval["tracks_per_second"], .2)
        self.assertEqual(interval["prep_wait_fraction"], .3)
        self.assertEqual(interval["stages_seconds"]["prep"]["mean"], 2)
        self.assertAlmostEqual(interval["stages_seconds"]["prep"]["p95"], 2.9)
        self.assertEqual(final["computed"], 3)
        self.assertEqual(final["tracks_per_second"], .15)
        self.assertEqual(final["prep_wait_fraction"], .2)
        self.assertEqual(final["stages_seconds"]["prep"]["p50"], 3)
        self.assertEqual(final["stages_seconds"]["style"]["n"], 1)
        self.assertEqual(final["stages_seconds"]["text"]["n"], 1)
        self.assertEqual(final["stages_seconds"]["decode"]["n"], 0)

    def test_empty_summary_and_invalid_interval(self):
        with self.assertRaises(ValueError):
            Profile(0)
        summary = Profile().summary()
        self.assertEqual(summary["tracks_per_second"], 0)
        self.assertEqual(summary["prep_wait_fraction"], 0)
        json.dumps(summary, allow_nan=False)

    def test_decode_and_resample_are_measured_in_preparation(self):
        def decode(command, stdout, **kwargs):
            stdout.write(b"audio")
        with patch("beets_embed.audio.subprocess.run", side_effect=decode), \
             patch("beets_embed.audio.resample_file") as resample, \
             patch("beets_embed.audio.time.perf_counter", side_effect=[10, 12, 20, 23]):
            prepared = PreparedAudio("/music/track.flac")
        try:
            self.assertEqual(prepared.timings, {"decode": 2, "resample": 3})
            self.assertEqual(resample.call_count, 2)
        finally:
            prepared.close()


class ProcessProfileTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.tracks = []
        for index in range(3):
            path = Path(temp.name) / str(index)
            path.write_bytes(b"audio")
            self.tracks.append({"id": index, "path": str(path)})
        self.store = SimpleNamespace(has=Mock(return_value=False), put=Mock())
        self.engine = SimpleNamespace(style=Mock(return_value=([1], [0], {}, 1)),
                                      audio_text=Mock(return_value=([1], [0], {}, 1)))
        self.prepared = []

    def prepare(self, path):
        obj = SimpleNamespace(timings={"decode": .1, "resample": .2}, close=Mock())
        self.prepared.append(obj)
        return obj

    def test_failures_are_excluded_and_per_track_lines_are_preserved(self):
        def prepare(path):
            if path == self.tracks[1]["path"]:
                raise ValueError("bad audio")
            return self.prepare(path)
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            counts = process(self.tracks, self.store, {"text": "v1"}, self.engine,
                             prepare, profile_every=2)
        self.assertEqual((counts["computed"], counts["failed"]), (2, 1))
        stages = counts["profiling"]["stages_seconds"]
        for stage in ("prep_wait", "prep", "decode", "resample", "text", "store"):
            self.assertEqual(stages[stage]["n"], 2)
        self.assertEqual(stages["style"]["n"], 0)
        self.assertIn("Embedded item 0 (1 computed)", output.getvalue())
        self.assertIn('"event":"embed_profile"', output.getvalue())
        self.assertGreater(counts["profiling"]["prep_wait_seconds"], 0)
        self.assertLessEqual(counts["profiling"]["prep_wait_fraction"], 1)
        for prepared in self.prepared:
            prepared.close.assert_called_once()

    def test_preparation_of_next_track_overlaps_inference(self):
        next_prepared = threading.Event()
        def prepare(path):
            if path == self.tracks[1]["path"]:
                next_prepared.set()
            return self.prepare(path)
        def style(*args):
            self.assertTrue(next_prepared.wait(5), "next preparation was blocked by inference")
            return [1], [0], {}, 1
        self.engine.style.side_effect = style
        counts = process(self.tracks[:2], self.store, {"style": "v1"}, self.engine, prepare)
        self.assertEqual(counts["computed"], 2)

    def test_skips_do_not_prepare_or_add_samples(self):
        self.store.has.return_value = True
        prepare = Mock()
        counts = process(self.tracks, self.store, {"style": "v1"}, self.engine, prepare)
        self.assertEqual(counts["skipped"], 3)
        prepare.assert_not_called()
        self.assertEqual(counts["profiling"]["stages_seconds"]["prep"]["n"], 0)

    def test_interruption_preserves_commit_and_closes_prefetch(self):
        stopped = False
        def style(*args):
            nonlocal stopped
            stopped = True
            return [1], [0], {}, 1
        self.engine.style.side_effect = style
        counts = process(self.tracks, self.store, {"style": "v1", "text": "v2"},
                         self.engine, self.prepare, stopping=lambda: stopped)
        self.store.put.assert_called_once()
        self.engine.audio_text.assert_not_called()
        self.assertEqual(counts["computed"], 0)
        self.assertEqual(counts["profiling"]["stages_seconds"]["style"]["n"], 0)
        for prepared in self.prepared:
            prepared.close.assert_called_once()

    def test_wait_fraction_includes_draining_prefetch_on_shutdown(self):
        clock = [0.0]
        delays = iter((2.0, 5.0))
        stopped = False
        def submit(function, job):
            result, delay = function(job), next(delays)
            def wait():
                clock[0] += delay
                return result
            return SimpleNamespace(result=wait)
        def style(*args):
            nonlocal stopped
            clock[0] += 3.0
            stopped = True
            return [1], [0], {}, 1
        self.engine.style.side_effect = style
        with patch("beets_embed.worker.ThreadPoolExecutor") as executor, \
             patch("beets_embed.worker.time.perf_counter", side_effect=lambda: clock[0]):
            executor.return_value.__enter__.return_value.submit.side_effect = submit
            counts = process(self.tracks[:2], self.store, {"style": "v1"}, self.engine,
                             self.prepare, stopping=lambda: stopped)
        self.assertEqual(counts["profiling"]["prep_wait_seconds"], 7)
        self.assertEqual(counts["profiling"]["loop_seconds"], 10)
        self.assertEqual(counts["profiling"]["prep_wait_fraction"], .7)
        self.assertEqual(counts["computed"], 0)
