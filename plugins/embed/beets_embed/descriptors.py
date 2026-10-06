"""Bounded CPU text encoding, atomic vocabulary cache and calibrated CLAP scores."""

import hashlib
import json
import logging
import os
import signal
import subprocess
import tempfile
import zipfile
from pathlib import Path

import numpy as np

from .retrieval import unit
from .sounds import zscores

LOGGER = logging.getLogger(__name__)
AXES = ('genre/style flavor', 'instrumentation', 'production/texture', 'mood/energy', 'vocals', 'tempo-feel')


def vocabulary(path=None):
    raw = (Path(path).expanduser() if path else Path(__file__).with_name('descriptors.json')).read_bytes()
    groups = json.loads(raw)
    if not isinstance(groups, dict) or set(groups) != set(AXES):
        raise ValueError('Descriptors must be a JSON object with the six documented axes')
    rows = []
    for axis, phrases in groups.items():
        if not isinstance(phrases, list):
            raise ValueError('Descriptor axes must contain lists of short phrases')
        for phrase in phrases:
            if not isinstance(phrase, str) or not phrase.strip() or len(phrase) > 240:
                raise ValueError('Descriptors must be nonempty strings of at most 240 characters')
            rows.append({'axis': axis, 'label': phrase.strip()})
    if not 1 <= len(rows) <= 256 or len({row['label'] for row in rows}) != len(rows):
        raise ValueError('Expected 1–256 distinct descriptor phrases')
    return rows, hashlib.sha256(raw).hexdigest()


def encode_phrases(worker, phrases, directory, timeout=120):
    if not worker or str(worker).startswith('@'):
        raise OSError('Packaged CPU embedding worker is unavailable')
    env = os.environ.copy()
    env.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', TOKENIZERS_PARALLELISM='false',
               HF_HOME=str(directory / 'hf'), HF_HUB_CACHE=str(directory / 'hf' / 'hub'),
               TORCH_HOME=str(directory / 'torch'), XDG_CACHE_HOME=str(directory / 'runtime'),
               MPLCONFIGDIR=str(directory / 'matplotlib'), OMP_NUM_THREADS='2', OPENBLAS_NUM_THREADS='2')
    with tempfile.TemporaryDirectory(prefix='.text-encode-', dir=directory) as temp:
        manifest = Path(temp) / 'phrases.json'
        manifest.write_text(json.dumps(phrases))
        child = subprocess.Popen([str(worker), 'encode-text', '--device', 'cpu', '--threads', '2',
                                  '--batch-size', '8', '--manifest', str(manifest)],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
                                 start_new_session=True, text=True)
        previous = {}
        def interrupted(signum, frame):
            raise SystemExit(128 + signum)
        try:
            for signum in (signal.SIGTERM, signal.SIGINT):
                previous[signum] = signal.signal(signum, interrupted)
            output, error = child.communicate(timeout=timeout)
            if child.returncode:
                raise ValueError(f'Text encoder exited {child.returncode}: {error[-1200:]}')
            return np.asarray(json.loads(output), dtype='f4')
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
                child.communicate()
            for signum, handler in previous.items():
                signal.signal(signum, handler)


def phrase_embeddings(rows, digest, model, directory, worker, protected=(), encoder=None):
    # Local import avoids a graph_export/descriptors import cycle.
    from .graph_export import protect_output
    directory = Path(directory).expanduser().absolute()
    directory.mkdir(mode=0o750, parents=True, exist_ok=True)
    key = hashlib.sha256((digest + '\n' + model).encode()).hexdigest()
    target = protect_output(directory / f'phrases-{key}.npz', *protected)
    def validate(values):
        values = np.asarray(values, dtype='f4')
        if values.shape != (len(rows), 512) or not np.isfinite(values).all() or np.any(
                np.linalg.norm(values, axis=1) < 1e-8) or not np.allclose(
                np.linalg.norm(values, axis=1), 1, rtol=1e-4):
            raise ValueError('Invalid phrase embedding matrix')
        return values.astype('f4')
    if target.is_file():
        try:
            with np.load(target, allow_pickle=False) as cached:
                if str(cached['model']) != model or str(cached['vocabulary']) != digest:
                    raise ValueError('Cache identity mismatch')
                return validate(cached['vectors']), 'hit'
        except (OSError, ValueError, TypeError, KeyError, EOFError, zipfile.BadZipFile):
            LOGGER.warning('Invalid phrase cache; regenerating %s', target.name)
    values = validate(unit(np.asarray((encoder or encode_phrases)(
        worker, [row['label'] for row in rows], directory), dtype='f4')))
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=directory, prefix='.phrases-', delete=False) as file:
            temporary = Path(file.name)
            np.savez(file, vectors=values, model=model, vocabulary=digest)
            file.flush()
            os.fsync(file.fileno())
            os.fchmod(file.fileno(), 0o640)
        protect_output(target, *protected)
        os.replace(temporary, target)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)
    return values, 'miss'


def add_descriptors(albums, text_vectors, rows, embeddings, columns):
    eligible = [i for i, vector in enumerate(text_vectors) if vector is not None]
    if not eligible:
        return
    scores = zscores(unit(np.stack([text_vectors[i] for i in eligible])) @ embeddings.T)
    for index, values in zip(eligible, scores):
        ranked = []
        for row, score in zip(rows, values):
            identity = columns.put(index, 'clap', row['label'], score, 'zscore', row['axis'])
            if score >= 0.5:
                ranked.append({'id': identity, 'label': row['label'], 'score': round(float(score), 3),
                               'axis': row['axis']})
        ranked.sort(key=lambda label: (-label['score'], label['label']))
        top, axes = [], {}
        for label in ranked:
            if axes.get(label['axis'], 0) < 2:
                top.append(label)
                axes[label['axis']] = axes.get(label['axis'], 0) + 1
            if len(top) == 5:
                break
        albums[index]['sound']['flavor'] = {'labels': top, 'count': albums[index]['text_embedded_tracks'],
                                          'total': albums[index]['track_count']}
