import base64
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

from beets_embed.descriptors import add_descriptors, encode_phrases, phrase_embeddings, vocabulary
from beets_embed.sounds import LabelColumns, aggregate_essentia, pool_heads, quantize_vector, zscores
from beets_embed.store import Store, fingerprint


class SoundTests(unittest.TestCase):
    def test_direction_quantization_preserves_cosines_and_signs(self):
        random = np.random.default_rng(42)
        vectors = random.normal(size=(20, 1280)).astype('f4')
        encoded = [quantize_vector(vector) for vector in vectors]
        decoded = np.stack([np.frombuffer(base64.b64decode(value), dtype='i1') for value in encoded]).astype('f4')
        original = vectors / np.linalg.norm(vectors, axis=1, keepdims=True)
        normalized = decoded / np.linalg.norm(decoded, axis=1, keepdims=True)
        np.testing.assert_allclose(original @ original.T, normalized @ normalized.T, atol=.002)
        self.assertEqual(len(base64.b64decode(encoded[0])), 1280)
        self.assertGreater((decoded < 0).sum(), 0)
        with self.assertRaises(ValueError):
            quantize_vector(np.zeros(1280))

    def test_worker_batches_cpu_text_without_probe_audio_or_store(self):
        import io
        import os
        from contextlib import redirect_stdout
        from beets_embed.worker import main
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / 'phrases.json'
            manifest.write_text(json.dumps(['gritty', 'lush', 'chiptune']))
            with patch('sys.argv', ['worker', 'encode-text', '--manifest', str(manifest),
                                   '--assets', '/assets', '--device', 'cpu', '--batch-size', '2']), \
                 patch.dict(os.environ, {'BEETS_EMBED_BACKEND': 'rocm'}), \
                 patch('beets_embed.worker.select_worker', side_effect=AssertionError('GPU selection')), \
                 patch('beets_embed.worker.probe_worker', side_effect=AssertionError('GPU probe')), \
                 patch('beets_embed.worker.Store', side_effect=AssertionError('store opened')), \
                 patch('beets_embed.audio.PreparedAudio', side_effect=AssertionError('audio prepared')), \
                 patch('beets_embed.inference.Models') as models, redirect_stdout(io.StringIO()) as output:
                models.return_value.text_batch.side_effect = [np.ones((2, 512)), np.ones((1, 512))]
                self.assertEqual(main(), 0)
            models.assert_called_once_with('/assets', 2, 'cpu', text_only=True)
            self.assertEqual([call.args[0] for call in models.return_value.text_batch.call_args_list],
                             [['gritty', 'lush'], ['chiptune']])
            self.assertEqual(len(json.loads(output.getvalue())), 3)

    def test_heads_mean_not_softmax_and_fingerprint_model_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tracks = []
            with Store(root / 'store.db') as store:
                for i, scores in enumerate(([.9, .8], [.3, .2])):
                    path = root / f'{i}.wav'
                    path.write_bytes(b'fixture')
                    tracks.append({'id': i + 1, 'path': str(path)})
                    store.put(i + 1, fingerprint(path), 'style:test', [1, 0], [0, 0],
                              {'discogs400': {'labels': ['A', 'B'], 'scores': scores},
                               'engagement': {'labels': ['engagement'], 'scores': [-.1 + i]}},
                              windows=1 + i * 9)
                pooled = pool_heads(store, tracks, 'style:test')
                np.testing.assert_allclose(pooled['style']['scores'], [.6, .5])
                self.assertEqual(pooled['style']['count'], 2)
                self.assertAlmostEqual(pooled['engagement']['scores'][0], .4)
                self.assertEqual(pool_heads(store, tracks, 'style:other'), {})
                Path(tracks[0]['path']).write_bytes(b'changed')
                self.assertEqual(pool_heads(store, tracks, 'style:test')['style']['count'], 1)
                store.db.execute('UPDATE vectors SET heads=? WHERE item_id=2', (b'bad',))
                self.assertEqual(pool_heads(store, tracks, 'style:test'), {})

    def test_essentia_observed_means_zero_categories_and_ties(self):
        items = [{'danceable': '0', 'danceability': '1.6', 'is_voice': '.8', 'gender': 'female',
                  'voice_instrumental': 'voice', 'mood_mirex': 'Cluster2'},
                 {'danceable': '.8', 'danceability': 'nan', 'gender': 'male',
                  'voice_instrumental': 'voice'}, {'danceable': None, 'danceability': '1.2'},
                 {'danceable': 'invalid', 'voice_instrumental': 'instrumental'}]
        fields = aggregate_essentia(items)
        self.assertEqual(fields['danceable']['value'], .4)
        self.assertEqual(fields['danceable']['count'], 2)
        self.assertEqual(fields['danceability']['value'], 1.4)
        self.assertEqual(fields['gender']['value'], None)
        self.assertEqual(fields['gender']['count'], 2)
        self.assertEqual(fields['voice_instrumental']['value'], 'voice')
        self.assertAlmostEqual(fields['voice_instrumental']['support'], 2 / 3, places=5)
        self.assertIsNone(fields['is_instrumental']['value'])
        self.assertEqual(fields['mood_mirex']['value'], 'Cluster2')
        self.assertEqual(fields['mood_happy']['count'], 0)

    def test_zscores_missing_constant_and_quantized_columns(self):
        scores = zscores([[1, 2, float('nan')], [2, 2, 4], [3, 2, 4]])
        np.testing.assert_allclose(scores[:, 0], [-1.22474487, 0, 1.22474487])
        np.testing.assert_array_equal(scores[:, 1], [0, 0, 0])
        self.assertTrue(np.isnan(scores[0, 2]))
        np.testing.assert_array_equal(scores[1:, 2], [0, 0])
        columns = LabelColumns(3)
        columns.put(0, 'style', 'A', 0)
        columns.put(1, 'style', 'A', 1)
        packed = columns.export()[0]
        self.assertEqual(list(base64.b64decode(packed['scores'])), [1, 255, 0])

    def test_cache_hit_miss_model_vocab_corruption_and_guard(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rows = [{'label': 'gritty', 'axis': 'production/texture'}]
            calls = []
            def encoder(worker, phrases, cache):
                calls.append(phrases)
                return np.ones((1, 512), dtype='f4')
            args = (rows, 'hash', 'text:test', root, 'worker')
            values, status = phrase_embeddings(*args, encoder=encoder)
            self.assertEqual(status, 'miss')
            with patch('beets_embed.descriptors.encode_phrases', side_effect=AssertionError('encoder loaded')):
                cached, status = phrase_embeddings(*args)
            self.assertEqual(status, 'hit')
            np.testing.assert_array_equal(values, cached)
            phrase_embeddings(rows, 'hash2', 'text:test', root, 'worker', encoder=encoder)
            phrase_embeddings(rows, 'hash', 'text:other', root, 'worker', encoder=encoder)
            import hashlib
            target = root / ('phrases-' + hashlib.sha256(b'hash\ntext:test').hexdigest() + '.npz')
            target.write_bytes(b'corrupt')
            # The first file is the original hash/model entry.
            phrase_embeddings(*args, encoder=encoder)
            self.assertEqual(len(calls), 4)
            self.assertFalse(list(root.glob('.phrases-*')))
            with self.assertRaises(ValueError):
                phrase_embeddings(*args, protected=[target], encoder=encoder)

    def test_encoder_unavailable_and_bounded_timeout(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(OSError):
                encode_phrases('@worker@', ['gritty'], root)
            # No model needed to exercise process-group timeout cleanup.
            worker = root / 'slow-worker'
            # Use the current interpreter so this test remains portable in Nix.
            import sys
            worker.write_text(f'#!{sys.executable}\nimport time\ntime.sleep(10)\n')
            worker.chmod(0o700)
            import subprocess
            with self.assertRaises(subprocess.TimeoutExpired):
                encode_phrases(worker, ['gritty'], root, timeout=.1)
            self.assertFalse(list(root.glob('.text-encode-*')))

    def test_encoding_uses_offline_state_paths_and_cpu_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch('beets_embed.descriptors.subprocess.Popen') as launch:
                child = launch.return_value
                child.communicate.return_value = (json.dumps(np.ones((1, 512)).tolist()), '')
                child.returncode = 0
                child.poll.return_value = 0
                self.assertEqual(encode_phrases('/worker', ['gritty'], root).shape, (1, 512))
            args, kwargs = launch.call_args
            self.assertEqual(args[0][:8], ['/worker', 'encode-text', '--device', 'cpu', '--threads', '2', '--batch-size', '8'])
            self.assertTrue(kwargs['start_new_session'])
            self.assertEqual(kwargs['env']['HF_HUB_OFFLINE'], '1')
            self.assertEqual(kwargs['env']['HF_HOME'], str(root / 'hf'))
            self.assertEqual(kwargs['env']['MPLCONFIGDIR'], str(root / 'matplotlib'))

    def test_vocabulary_and_descriptor_top_labels(self):
        rows, digest = vocabulary()
        self.assertEqual(len(rows), 144)
        self.assertEqual(len(digest), 64)
        albums = [{'sound': {}, 'text_embedded_tracks': 1, 'track_count': 5} for _ in range(3)]
        columns = LabelColumns(3)
        rows = [{'label': 'gritty', 'axis': 'production/texture'}, {'label': 'lush', 'axis': 'production/texture'}]
        add_descriptors(albums, [np.array([1, 0]), np.array([0, 1]), None], rows, np.eye(2), columns)
        self.assertEqual(albums[0]['sound']['flavor']['labels'][0]['label'], 'gritty')
        self.assertEqual(albums[1]['sound']['flavor']['labels'][0]['label'], 'lush')
        self.assertNotIn('flavor', albums[2]['sound'])
        self.assertEqual(albums[0]['sound']['flavor']['count'], 1)
