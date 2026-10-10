"""Small wall-time samples, with aggregation only at reporting boundaries."""

import json
import sys
import time
from array import array

STAGES = ("prep_wait", "prep", "decode", "resample", "style", "text", "store")


def stage_stats(values):
    if not values:
        return {"n": 0, "mean": 0.0, "p50": 0.0, "p95": 0.0}
    import numpy as np
    samples = np.frombuffer(values, dtype="float64")
    p50, p95 = np.percentile(samples, [50, 95])
    return {"n": len(values), "mean": float(samples.mean()),
            "p50": float(p50), "p95": float(p95)}


class Profile:
    def __init__(self, every=100):
        if every < 1:
            raise ValueError("profile interval must be positive")
        self.every = every
        self.started = self.window_started = time.perf_counter()
        self.samples = {stage: array("d") for stage in STAGES}
        self.window = {stage: array("d") for stage in STAGES}
        self.computed = self.window_computed = 0
        self.loop_seconds = self.window_loop_seconds = 0.0
        self.wait_seconds = self.window_wait_seconds = 0.0

    def iteration(self, seconds, waited):
        self.loop_seconds += seconds
        self.window_loop_seconds += seconds
        self.wait_seconds += waited
        self.window_wait_seconds += waited

    def computed_track(self, stages):
        for stage, seconds in stages.items():
            self.samples[stage].append(seconds)
            self.window[stage].append(seconds)
        self.computed += 1
        self.window_computed += 1
        if self.window_computed == self.every:
            report = self.summary(interval=True)
            print(json.dumps(dict(event="embed_profile", scope="interval", **report),
                             separators=(",", ":"), allow_nan=False), file=sys.stderr, flush=True)
            self.window_started = time.perf_counter()
            self.window = {stage: array("d") for stage in STAGES}
            self.window_computed = 0
            self.window_loop_seconds = self.window_wait_seconds = 0.0

    def summary(self, interval=False):
        elapsed = time.perf_counter() - (self.window_started if interval else self.started)
        computed = self.window_computed if interval else self.computed
        loop = self.window_loop_seconds if interval else self.loop_seconds
        wait = self.window_wait_seconds if interval else self.wait_seconds
        samples = self.window if interval else self.samples
        return {"computed": computed, "seconds": elapsed,
                "tracks_per_second": computed / elapsed if elapsed else 0.0,
                "prep_wait_fraction": wait / loop if loop else 0.0,
                "loop_seconds": loop, "prep_wait_seconds": wait,
                "stages_seconds": {stage: stage_stats(values) for stage, values in samples.items()}}
