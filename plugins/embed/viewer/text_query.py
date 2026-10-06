"""Bounded supervision of one offline CPU text encoder; no model imports here."""

import collections
import json
import math
import os
import selectors
import signal
import subprocess
import threading
import time
from pathlib import Path


class QueryError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


class TextQuery:
    def __init__(self, worker, cache_dir, idle_seconds=600, timeout=120):
        self.worker = worker
        self.cache_dir = Path(cache_dir)
        self.idle_seconds = idle_seconds
        self.timeout = timeout
        self.child = None
        self.gate = threading.Lock()
        self.requests = collections.deque(maxlen=2)
        self.last_used = time.monotonic()
        self.closed = threading.Event()
        self.reaper = threading.Thread(target=self._idle, daemon=True)
        self.reaper.start()

    def _stop(self):
        child, self.child = self.child, None
        if child is not None:
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            child.wait()
            child.stdin.close()
            child.stdout.close()

    def close(self):
        self.closed.set()
        child = self.child
        if child is not None and child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        with self.gate:
            self._stop()
        self.reaper.join()

    def _idle(self):
        interval = min(30, max(.05, self.idle_seconds / 2)) if self.idle_seconds else 30
        while not self.closed.wait(interval):
            if self.idle_seconds and self.gate.acquire(blocking=False):
                try:
                    if time.monotonic() - self.last_used >= self.idle_seconds:
                        self._stop()
                finally:
                    self.gate.release()

    def query(self, text):
        if not self.worker or self.closed.is_set():
            raise QueryError(503, 'Text search is unavailable: packaged CPU worker is missing.')
        if not self.gate.acquire(blocking=False):
            raise QueryError(429, 'Text encoder is busy; try again shortly.')
        try:
            started = time.monotonic()
            if len(self.requests) == 2 and started - self.requests[0] < 1:
                raise QueryError(429, 'Text query rate limit reached; try again shortly.')
            self.requests.append(started)
            if self.child is None or self.child.poll() is not None:
                self._stop()
                self.cache_dir.mkdir(parents=True, exist_ok=True, mode=0o750)
                # Exporter and viewer run as different users. Isolate runtime
                # caches so restrictive service umasks cannot block each other.
                runtime = self.cache_dir / 'query'
                runtime.mkdir(exist_ok=True, mode=0o750)
                env = os.environ.copy()
                env.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', TOKENIZERS_PARALLELISM='false',
                           HF_HOME=str(runtime / 'hf'), HF_HUB_CACHE=str(runtime / 'hf' / 'hub'),
                           TORCH_HOME=str(runtime / 'torch'), XDG_CACHE_HOME=str(runtime / 'runtime'),
                           MPLCONFIGDIR=str(runtime / 'matplotlib'), OMP_NUM_THREADS='2', OPENBLAS_NUM_THREADS='2')
                self.child = subprocess.Popen([str(self.worker), 'serve-text', '--device', 'cpu', '--threads', '2'],
                                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env,
                                              start_new_session=True)
            if self.closed.is_set():
                raise QueryError(503, 'Text encoder is shutting down.')
            child = self.child
            child.stdin.write((json.dumps({'q': text}, ensure_ascii=False) + '\n').encode())
            child.stdin.flush()
            output = bytearray()
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout, selectors.EVENT_READ)
                while b'\n' not in output:
                    remaining = self.timeout - (time.monotonic() - started)
                    if remaining <= 0 or not selector.select(remaining):
                        raise QueryError(504, 'Text encoder timed out; the next query will reload it.')
                    part = os.read(child.stdout.fileno(), 16385 - len(output))
                    if not part or len(output) + len(part) > 16384:
                        raise ValueError('Invalid encoder response')
                    output.extend(part)
            result = json.loads(output)
            vector = result['vector']
            if (not isinstance(vector, list) or len(vector) != 512 or
                    any(type(x) not in (int, float) or not math.isfinite(x) for x in vector) or
                    not math.isclose(math.sqrt(sum(x*x for x in vector)), 1, abs_tol=1e-4) or
                    not isinstance(result.get('model_id'), str) or not result['model_id'].startswith('text:')):
                raise ValueError('Invalid encoder vector')
            return result
        except QueryError as exc:
            if exc.status != 429:
                self._stop()
            raise
        except (OSError, ValueError, KeyError, TypeError) as exc:
            self._stop()
            raise QueryError(503, 'Text encoder unavailable; check the packaged model files and cache permissions.') from exc
        finally:
            self.last_used = time.monotonic()
            self.gate.release()
