import base64
import hashlib
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

import numpy as np
from beets.library import Album, Item, Library
from beetsplug.embed import EmbedPlugin
from beets_embed.graph_export import (AlbumStatistics, export_albums, file_size,
                                     plays, protect_output, utc_timestamp)
from beets_embed.store import Store, fingerprint


class GraphExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.lib = Library(str(self.root / 'library.db'), directory=str(self.root))
        self.addCleanup(self.lib._close)
        self.store_path = self.root / 'vectors.sqlite3'
        self.output = self.root / 'albums.json'
        self.items = []
        for i in range(4):
            path = self.root / f'{i}.wav'
            path.write_bytes(b'audio')
            self.items.append(Item(path=os.fsencode(path), title=f'Track {i}', artist='Finn',
                                   albumartist='Finn', album='First' if i < 3 else 'Missing',
                                   genres=['Folk'], year=2001))
        self.first = self.lib.add_album(self.items[:3])
        self.missing = self.lib.add_album(self.items[3:])
        for item, fields in zip(self.items, [dict(lastfm_play_count='10', play_count='99'),
                                            dict(play_count='6'), {}, {}]):
            item.update(fields)
            item.store()
        with Store(self.store_path) as store:
            for item, vector in zip(self.items, [[1, 0], [0, 1]]):
                store.put(item.id, fingerprint(item.path), 'style:v1', vector, [0, 0])

    def export(self, selected=None, model='style:v1'):
        return export_albums(self.lib, selected if selected is not None else
                             {self.first.id, self.missing.id}, self.store_path, model, self.output)

    def test_pooling_plays_and_missing_vectors(self):
        result = self.export()
        self.assertEqual({k: result['summary'][k] for k in ('selected_albums', 'exported_albums', 'skipped_albums')},
                         dict(selected_albums=2, exported_albums=1, skipped_albums=1))
        self.assertIsNone(result['albums'][0]['cover'])
        self.assertIsNone(result['albums'][0]['text_vector'])
        self.assertFalse(result['summary']['covers_enabled'])
        album = result['albums'][0]
        self.assertEqual(album['id'], self.first.id)
        self.assertEqual(album['album'], 'First')
        self.assertEqual(album['genre'], 'Folk')
        self.assertEqual(album['year'], 2001)
        self.assertEqual(album['track_count'], 3)
        self.assertEqual(album['embedded_tracks'], 2)
        self.assertEqual(album['summed_plays'], 16)
        self.assertAlmostEqual(album['mean_plays'], 16 / 3)
        np.testing.assert_array_equal(np.frombuffer(base64.b64decode(album['vector']), dtype='i1'), [127, 127])
        self.assertEqual(result['vector_encoding'], 'int8-base64')
        self.assertEqual(result['vector_dimension'], 2)
        self.assertEqual(result['model_id'], 'style:v1')
        self.assertEqual(result['schema_version'], 3)
        self.assertIn('+00:00', result['exported_at'])
        self.assertEqual(json.loads(self.output.read_text()), result)

    def quality_items(self, fields):
        for item, values in zip(self.items, fields):
            item.update(values)
            item.store()

    def test_album_quality_release_and_library_totals(self):
        self.quality_items([
            dict(format='FLAC', bitrate=1000000, samplerate=44100, bitdepth=16, length=60),
            dict(format='FLAC', bitrate=900000, samplerate=48000, bitdepth=24, length=90),
            dict(format='FLAC', bitrate=1100000, samplerate=44100, bitdepth=16, length=120),
            dict(format='AAC', bitrate=320000, samplerate=44100, bitdepth=0, length=30),
        ])
        self.first.update(dict(added=1709294400, albumtype='album', label='Island',
                               country='GB', original_year=1969, mb_albumid='release-id'))
        self.first.store()
        result = self.export({self.first.id})
        album = result['albums'][0]
        expected = dict(added='2024-03-01T12:00:00Z', format='FLAC', formats={'FLAC': 3},
                        lossless=True, bitrate_kbps=1000, samplerate_hz=44100,
                        bitdepth=16, size_bytes=15,
                        release=dict(albumtype='album', label='Island', country='GB',
                                     original_year=1969, mb_albumid='release-id'))
        self.assertEqual({key: album[key] for key in expected}, expected)
        library = result['library']
        self.assertEqual({key: library[key] for key in library if key != 'computed_at'},
                         dict(albums=2, tracks=4, size_bytes=20, duration_seconds=300.0,
                              listened_seconds_estimate=1140.0, lossless_albums=1,
                              formats={'AAC': dict(albums=1, tracks=1, size_bytes=5),
                                       'FLAC': dict(albums=1, tracks=3, size_bytes=15)},
                              missing_files=0))
        self.assertIsInstance(library['duration_seconds'], float)
        self.assertIsInstance(library['listened_seconds_estimate'], float)
        self.assertRegex(library['computed_at'], r'^\d{4}-\d\d-\d\dT.*Z$')
        self.assertNotIn(str(self.root), self.output.read_text())
        self.assertNotIn('path', album)
        self.assertEqual(json.loads(self.output.read_text()), result)

    def test_mixed_formats_known_quality_and_dominant_album_buckets(self):
        self.quality_items([
            dict(format='FLAC', bitrate=1000000, samplerate=48000, bitdepth=24),
            dict(format='FLAC', bitrate=0, samplerate=0, bitdepth=0),
            dict(format='MP3', bitrate=320000, samplerate=44100, bitdepth=0),
            dict(format='MP3', bitrate=320000, samplerate=44100, bitdepth=0),
        ])
        result = self.export()
        album = result['albums'][0]
        self.assertEqual(album['format'], 'Mixed')
        self.assertEqual(album['formats'], {'FLAC': 2, 'MP3': 1})
        self.assertFalse(album['lossless'])
        self.assertEqual(album['bitrate_kbps'], 660)
        self.assertEqual(album['samplerate_hz'], 44100)  # Ties use the smaller value.
        self.assertEqual(album['bitdepth'], 24)
        self.assertEqual(result['library']['formats'],
                         {'FLAC': dict(albums=0, tracks=2, size_bytes=10),
                          'MP3': dict(albums=1, tracks=2, size_bytes=10),
                          'Mixed': dict(albums=1, tracks=0, size_bytes=0)})

    def test_lossy_bitdepth_and_empty_release_values_are_null(self):
        self.quality_items([dict(format='MP3', bitdepth=0)] * 3)
        self.first.update(dict(added=0, albumtype='', label=' ', country='',
                               original_year=0, mb_albumid=''))
        self.first.store()
        album = self.export()['albums'][0]
        self.assertEqual(album['format'], 'MP3')
        self.assertFalse(album['lossless'])
        for key in ('added', 'bitdepth', 'bitrate_kbps', 'samplerate_hz'):
            self.assertIsNone(album[key])
        self.assertEqual(album['release'], dict(albumtype=None, label=None, country=None,
                                               original_year=None, mb_albumid=None))

    def test_unknown_formats_and_numeric_metadata(self):
        album = self.export()['albums'][0]
        self.assertIsNone(album['format'])
        self.assertEqual(album['formats'], {})
        self.assertFalse(album['lossless'])
        self.assertEqual(self.export()['library']['formats'], {})
        self.assertEqual(self.export()['library']['lossless_albums'], 0)
        for value in (None, '', 0, -1, 'nan', 'inf', 'bad', 1e100):
            with self.subTest(timestamp=value):
                self.assertIsNone(utc_timestamp(value))

    def test_format_threshold_includes_unknown_tracks_and_all_lossless_formats(self):
        for last, expected, lossless in [('MP3', 'FLAC', False),
                                         ('', 'FLAC', False), ('ALAC', 'FLAC', True)]:
            with self.subTest(last=last):
                stats = AlbumStatistics()
                for format in ['FLAC'] * 9 + [last]:
                    stats.add({}, format or None, 0, 0)
                self.assertEqual(stats.export()['format'], expected)
                self.assertEqual(stats.export()['lossless'], lossless)
                stats.add({}, 'MP3', 0, 0)
                self.assertEqual(stats.export()['format'], 'Mixed')
        stats = AlbumStatistics()
        for format in ('FLAC', 'ALAC', 'WAV', 'AIFF', 'APE', 'WavPack'):
            stats.add({}, format, 1, 0)
        self.assertTrue(stats.export()['lossless'])
        self.assertEqual(stats.export()['format'], 'Mixed')
        self.assertFalse(AlbumStatistics().export()['lossless'])

    def test_missing_audio_partial_and_all_failed_sizes(self):
        Path(os.fsdecode(self.items[2].path)).unlink()
        result = self.export()
        self.assertEqual(result['albums'][0]['size_bytes'], 10)
        self.assertEqual(result['library']['size_bytes'], 15)
        self.assertEqual(result['library']['missing_files'], 1)
        original = file_size
        def unavailable(item, directory):
            return None if item.album_id == self.first.id else original(item, directory)
        with patch('beets_embed.graph_export.file_size', side_effect=unavailable):
            result = self.export()
        self.assertIsNone(result['albums'][0]['size_bytes'])
        self.assertEqual(result['library']['size_bytes'], 5)
        self.assertEqual(result['library']['missing_files'], 3)
        with patch('beets_embed.graph_export.os.stat', side_effect=PermissionError):
            self.assertIsNone(file_size(self.items[0], self.lib.directory))

    def test_filesize_read_once_and_real_zero_byte_file(self):
        standalone_path = self.root / 'empty.wav'
        standalone_path.touch()
        standalone = Item(path=os.fsencode(standalone_path), format='WAV', length=10,
                          play_count='2')
        self.lib.add(standalone)
        with patch('beets_embed.graph_export.file_size', wraps=file_size) as sizes, \
             patch('beets_embed.graph_export.plays', wraps=plays) as play_counts:
            result = self.export()
        self.assertCountEqual([call.args[0].id for call in sizes.call_args_list],
                              [item.id for item in self.items] + [standalone.id])
        self.assertEqual(play_counts.call_count, 5)
        self.assertEqual(result['library']['albums'], 2)
        self.assertEqual(result['library']['tracks'], 5)
        self.assertEqual(result['library']['duration_seconds'], 10.0)
        self.assertEqual(result['library']['listened_seconds_estimate'], 20.0)
        self.assertEqual(result['library']['missing_files'], 0)
        self.assertEqual(result['library']['formats']['WAV'], dict(albums=0, tracks=1, size_bytes=0))
        with patch('beets_embed.graph_export.os.stat', return_value=SimpleNamespace(st_size=0)) as stat:
            self.assertEqual(file_size(SimpleNamespace(path=b'empty.wav'), self.root), 0)
        stat.assert_called_once_with(str(standalone_path))

    def test_library_totals_ignore_selection_and_embedding_availability(self):
        first = self.export()
        empty = self.export(set())
        stale = self.export(model='absent:model')
        for result in (empty, stale):
            self.assertEqual(result['albums'], [])
            self.assertEqual({k: v for k, v in result['library'].items() if k != 'computed_at'},
                             {k: v for k, v in first['library'].items() if k != 'computed_at'})
        # Candidates whose current vectors are stale still contribute once.
        for item in self.items[:2]:
            Path(os.fsdecode(item.path)).write_bytes(b'changed')
        with patch('beets_embed.graph_export.file_size', wraps=file_size) as sizes:
            result = self.export()
        self.assertEqual(result['albums'], [])
        self.assertEqual(sizes.call_count, 4)
        self.assertEqual(result['library']['size_bytes'], 24)

    def test_empty_library_totals(self):
        for album in (self.first, self.missing):
            album.remove(delete=False)
        result = self.export()
        self.assertEqual({k: v for k, v in result['library'].items() if k != 'computed_at'},
                         dict(albums=0, tracks=0, size_bytes=0, duration_seconds=0.0,
                              listened_seconds_estimate=0.0, lossless_albums=0,
                              formats={}, missing_files=0))

    def test_query_selects_whole_album_without_writes_or_inference(self):
        standalone = Item(path=b'/unused.wav', artist='Finn', album='Single')
        self.lib.add(standalone)
        store_hash = hashlib.sha256(self.store_path.read_bytes()).hexdigest()
        command = next(cmd for cmd in EmbedPlugin().commands() if cmd.name == 'embed-graph-export')
        self.set_art()
        opts, args = command.parser.parse_args(['-o', str(self.output), '--store', str(self.store_path),
                                               '--covers-dir', str(self.root / 'covers'), f'id:{self.items[0].id}'])
        before = list(self.lib._connection().iterdump())
        with patch('beetsplug.embed.model_ids', return_value={'style': 'style:v1', 'text': 'text:v1'}), \
             patch.object(Item, 'store', side_effect=AssertionError('item write')), \
             patch.object(Album, 'store', side_effect=AssertionError('album write')), \
             patch.object(Item, 'write', side_effect=AssertionError('tag write')), \
             patch.object(Store, 'put', side_effect=AssertionError('vector write')), \
             patch('beetsplug.embed.select_worker', side_effect=AssertionError('inference probe')), \
             patch('beetsplug.embed.run_worker', side_effect=AssertionError('inference')):
            command.func(self.lib, opts, args)
        result = json.loads(self.output.read_text())
        self.assertEqual(result['summary']['selected_albums'], 1)
        self.assertEqual(result['albums'][0]['track_count'], 3)
        self.assertEqual(result['albums'][0]['summed_plays'], 16)
        self.assertEqual(result['summary']['covers_generated'], 1)
        self.assertEqual(before, list(self.lib._connection().iterdump()))
        self.assertEqual(store_hash, hashlib.sha256(self.store_path.read_bytes()).hexdigest())
        opts, args = command.parser.parse_args(['-o', str(self.output), '--store', str(self.store_path),
                                               f'id:{standalone.id}'])
        with patch('beetsplug.embed.model_ids', return_value={'style': 'style:v1'}):
            command.func(self.lib, opts, args)
        self.assertEqual(json.loads(self.output.read_text())['albums'], [])

    def test_v3_export_labels_and_encoder_failure_remain_readonly(self):
        from beets_embed.store import model_ids
        identities = model_ids()
        self.items[0]['danceable'] = '.8'
        self.items[0].store()
        with Store(self.store_path) as store:
            item = self.items[0]
            store.put(item.id, fingerprint(item.path), identities['style'], [1, 0], [0, 0],
                      {'discogs400': {'labels': ['Hip Hop---Boom Bap'], 'scores': [.7]}})
            store.put(item.id, fingerprint(item.path), identities['text'], np.ones(512), np.zeros(512))
        before = self.store_path.read_bytes()
        with patch('beets_embed.descriptors.encode_phrases', side_effect=OSError('no encoder')), \
             patch.object(Item, 'store', side_effect=AssertionError('item write')), \
             patch.object(Album, 'store', side_effect=AssertionError('album write')):
            with self.assertLogs('beets_embed.graph_export', level='WARNING'):
                result = export_albums(self.lib, {self.first.id}, self.store_path,
                                       identities['style'], self.output, cache_dir=self.root / 'cache')
        self.assertEqual(result['summary']['descriptor_cache'], 'unavailable')
        self.assertEqual(result['text_vector_dimension'], 512)
        self.assertEqual(result['text_vector_encoding'], 'int8-base64')
        np.testing.assert_array_equal(np.frombuffer(base64.b64decode(result['albums'][0]['text_vector']), dtype='i1'),
                                      np.full(512, 127))
        self.assertEqual(result['albums'][0]['sound']['style']['count'], 1)
        reference = result['albums'][0]['sound']['style']['labels'][0][0]
        self.assertEqual(result['labels'][reference]['label'], 'Hip Hop---Boom Bap')
        field = result['essentia_fields'].index('danceable')
        self.assertEqual(result['albums'][0]['essentia'][field], [.8, 1])
        self.assertEqual(result['labels'][0]['source'], 'essentia')
        self.assertEqual(self.store_path.read_bytes(), before)

    def test_zero_lastfm_does_not_fall_back_and_missing_plays(self):
        for item, expected in [({'lastfm_play_count': '0', 'play_count': '9'}, 0),
                               ({'lastfm_play_count': None, 'play_count': '9'}, 9),
                               ({}, 0), ({'play_count': 'nan'}, 0), ({'play_count': '-1'}, 0)]:
            self.assertEqual(plays(item), expected)

    def test_text_vectors_pool_current_tracks_independently_of_layout(self):
        from beets_embed.store import model_ids
        model = model_ids()['text']
        with Store(self.store_path) as store:
            for i, item in enumerate(self.items[:2]):
                vector = np.zeros(512, dtype='f4')
                vector[i] = 1
                store.put(item.id, fingerprint(item.path), model, vector, np.zeros(512))
        with patch('beets_embed.graph_export.phrase_embeddings', side_effect=OSError('missing model')):
            first = self.export()['albums'][0]
            self.assertEqual(first['text_embedded_tracks'], 2)
            decoded = np.frombuffer(base64.b64decode(first['text_vector']), dtype='i1')
            np.testing.assert_array_equal(decoded[:2], [127, 127])
            self.assertEqual(len(decoded), 512)
            self.assertEqual(len(base64.b64decode(first['vector'])), 2)
            Path(os.fsdecode(self.items[0].path)).write_bytes(b'changed audio')
            second = self.export()['albums'][0]
            self.assertEqual(second['text_embedded_tracks'], 1)
            self.assertEqual(list(base64.b64decode(second['text_vector']))[:2], [0, 127])

    def test_fingerprint_model_and_missing_store(self):
        self.assertEqual(self.export(model='text:v1')['albums'], [])
        Path(os.fsdecode(self.items[0].path)).write_bytes(b'changed audio')
        result = self.export()
        self.assertEqual(result['albums'][0]['embedded_tracks'], 1)
        self.assertEqual(list(base64.b64decode(result['albums'][0]['vector'])), [0, 127])
        absent = self.root / 'absent.sqlite3'
        with self.assertRaises(sqlite3.OperationalError):
            export_albums(self.lib, {self.first.id}, absent, 'style:v1', self.output)
        self.assertFalse(absent.exists())
        with self.assertRaises(ValueError):
            export_albums(self.lib, set(), self.root / 'library.db', 'style:v1', self.output)

    def test_output_guards_include_aliases_and_sidecars(self):
        for source in [Path(self.lib.path), self.store_path]:
            for suffix in ['', '-wal', '-shm', '-journal']:
                with self.assertRaises(ValueError):
                    protect_output(str(source) + suffix, self.lib.path, self.store_path)
            symlink = self.root / 'alias.json'
            symlink.symlink_to(source)
            with self.assertRaises(ValueError):
                self.export_to(symlink)
            symlink.unlink()
            hardlink = self.root / 'hardlink.json'
            os.link(source, hardlink)
            with self.assertRaises(ValueError):
                self.export_to(hardlink)
            hardlink.unlink()

    def export_to(self, output):
        return export_albums(self.lib, {self.first.id}, self.store_path, 'style:v1', output)

    def test_invalid_vector_does_not_replace_existing_output(self):
        self.output.write_text('keep me')
        with patch('beets_embed.graph_export.album_vectors',
                   return_value=iter([({'embedded_tracks': 1}, np.array([float('nan'), 1]))])):
            with self.assertRaisesRegex(ValueError, 'Invalid embedding'):
                self.export()
        self.assertEqual(self.output.read_text(), 'keep me')
        self.assertEqual(list(self.root.glob('.album-graph-*')), [])


    def set_art(self, path=None):
        path = path or self.root / 'art.png'
        Image.new('RGBA', (300, 150), (200, 40, 20, 255)).save(path)
        self.first.artpath = os.fsencode(path)
        self.first.store()
        return path

    def export_covers(self, selected=None):
        return export_albums(self.lib, selected if selected is not None else {self.first.id},
                             self.store_path, 'style:v1', self.output, self.root / 'covers')

    def test_thumbnails_preserve_art_and_reuse_then_prune_changed_and_removed(self):
        source = self.set_art()
        original = source.read_bytes()
        result = self.export_covers()
        name = result['albums'][0]['cover']
        variants = result['albums'][0]['cover_variants']
        self.assertEqual(set(variants), {'32', '64', '128', '256', '512'})
        self.assertEqual(variants['256'], name)
        for size in (32, 64, 128):
            with Image.open(self.root / 'covers' / variants[str(size)]) as image:
                self.assertEqual(image.size, (size, size))
                self.assertLess(max(image.getpixel((size // 2, 0))), 40)
        sheet = result['cover_atlases'][0]
        self.assertEqual(sheet['album_ids'], [self.first.id])
        with Image.open(self.root / 'covers' / sheet['file']) as image:
            self.assertEqual(image.size, (32, 32))
        self.assertRegex(name, r'^cover-[0-9a-f]{64}\.jpg$')
        thumbnail = self.root / 'covers' / name
        with Image.open(thumbnail) as image:
            self.assertEqual(image.size, (256, 256))
            self.assertEqual(image.format, 'JPEG')
            self.assertLess(max(image.getpixel((128, 8))), 40)  # Padding rather than cropping.
            self.assertGreater(image.getpixel((128, 128))[0], 180)
        self.assertEqual(thumbnail.stat().st_mode & 0o777, 0o640)
        large = self.root / 'covers' / result['albums'][0]['cover_large']
        self.assertNotEqual(large.name, name)
        with Image.open(large) as image:
            self.assertEqual(image.size, (512, 512))
            self.assertLess(max(image.getpixel((256, 8))), 40)
            self.assertGreater(image.getpixel((256, 256))[0], 180)
        large_stamp = large.stat().st_mtime_ns
        stamp = thumbnail.stat().st_mtime_ns
        with patch('beets_embed.covers.Image.open', side_effect=AssertionError('decoded unchanged art')):
            repeated = self.export_covers()
        self.assertEqual(repeated['summary']['covers_reused'], 1)
        self.assertEqual(repeated['summary']['covers_large_reused'], 1)
        self.assertEqual(repeated['summary']['cover_atlases_reused'], 1)
        self.assertEqual(repeated['albums'][0]['cover_variants'], variants)
        self.assertEqual(large.stat().st_mtime_ns, large_stamp)
        self.assertEqual(thumbnail.stat().st_mtime_ns, stamp)
        self.assertEqual(source.read_bytes(), original)
        unrelated = self.root / 'covers' / ('cover-' + 'f' * 64 + '.jpg')
        unrelated.write_bytes(b'not owned by exporter')
        Image.new('RGB', (130, 200), (30, 100, 200)).save(source)
        changed = self.export_covers()
        self.assertNotEqual(changed['albums'][0]['cover'], name)
        self.assertEqual(changed['summary']['covers_generated'], 1)
        self.assertEqual(changed['summary']['covers_pruned'], 6)
        self.assertFalse(thumbnail.exists())
        self.assertFalse(large.exists())
        self.assertTrue(unrelated.exists())
        removed = self.export_covers(set())
        self.assertEqual(removed['summary']['covers_pruned'], 6)
        self.assertEqual(list((self.root / 'covers').glob('cover-*.jpg')), [unrelated])
        self.assertEqual(json.loads(self.output.read_text()), removed)
        self.assertFalse(list((self.root / 'covers').glob('.cover-*')))

    def test_missing_unreadable_and_corrupt_art_do_not_fail_export(self):
        self.assertEqual(self.export_covers()['summary']['covers_missing'], 1)
        source = self.set_art()
        source.write_bytes(b'corrupt image')
        result = self.export_covers()
        self.assertIsNone(result['albums'][0]['cover'])
        self.assertEqual(result['summary']['covers_missing'], 1)
        source.unlink()
        self.assertIsNone(self.export_covers()['albums'][0]['cover'])
        source = self.set_art()
        original_open = Path.open
        def unreadable(path, *args, **kwargs):
            if path == source:
                raise PermissionError('no read permission')
            return original_open(path, *args, **kwargs)
        with patch.object(Path, 'open', unreadable):
            self.assertIsNone(self.export_covers()['albums'][0]['cover'])

    def test_shared_art_and_atomic_failure_preserve_previous_export(self):
        source = self.set_art()
        with Store(self.store_path) as store:
            store.put(self.items[3].id, fingerprint(self.items[3].path), 'style:v1', [1, 1], [0, 0])
        self.missing.artpath = os.fsencode(source)
        self.missing.store()
        result = self.export_covers({self.first.id, self.missing.id})
        self.assertEqual(result['albums'][0]['cover'], result['albums'][1]['cover'])
        self.assertEqual(result['summary']['covers_generated'], 1)
        self.assertEqual(result['summary']['covers_reused'], 1)
        previous_files = set((self.root / 'covers').glob('cover-*.jpg'))
        before = self.output.read_bytes()
        old_cover = self.root / 'covers' / result['albums'][0]['cover']
        old_large = self.root / 'covers' / result['albums'][0]['cover_large']
        self.assertEqual(result['albums'][0]['cover_large'], result['albums'][1]['cover_large'])
        self.assertEqual(result['summary']['covers_large_generated'], 1)
        self.assertEqual(result['summary']['covers_large_reused'], 1)
        Image.new('RGB', (200, 200), 'blue').save(source)
        with patch('beets_embed.graph_export.write_export', side_effect=OSError('cannot publish')):
            with self.assertRaises(OSError):
                self.export_covers()
        self.assertEqual(self.output.read_bytes(), before)
        self.assertTrue(old_cover.exists())
        self.assertEqual(set((self.root / 'covers').glob('cover-*.jpg')), previous_files)
        with patch('beets_embed.covers.atomic_write', side_effect=OSError('cannot encode/write')):
            failed = self.export_covers()
        self.assertIsNone(failed['albums'][0]['cover'])
        self.assertEqual(failed['summary']['covers_missing'], 1)

    def test_exif_orientation_and_alpha_padding_for_both_variants(self):
        source = self.set_art()
        exif = Image.Exif()
        exif[274] = 6
        Image.new('RGB', (300, 150), (200, 40, 20)).save(source, 'JPEG', exif=exif)
        result = self.export_covers()
        for field, size in [('cover', 256), ('cover_large', 512)]:
            with Image.open(self.root / 'covers' / result['albums'][0][field]) as image:
                self.assertEqual(image.size, (size, size))
                self.assertLess(max(image.getpixel((8, size // 2))), 40)
                self.assertGreater(image.getpixel((size // 2, size // 2))[0], 180)
        Image.new('RGBA', (300, 150), (255, 0, 0, 0)).save(source, 'PNG')
        transparent = self.export_covers()
        for field, size in [('cover', 256), ('cover_large', 512)]:
            with Image.open(self.root / 'covers' / transparent['albums'][0][field]) as image:
                self.assertLess(max(image.getpixel((size // 2, size // 2))), 40)

    def test_recipe_change_regenerates_both_variants_once(self):
        self.set_art()
        with patch('beets_embed.covers.RECIPE', 'jpeg-128-contain-rgb-10151c-q82-v1'):
            old = self.export_covers()
        changed = self.export_covers()
        self.assertNotEqual(old['albums'][0]['cover'], changed['albums'][0]['cover'])
        self.assertNotEqual(old['albums'][0]['cover_large'], changed['albums'][0]['cover_large'])
        self.assertEqual(changed['summary']['covers_generated'], 1)
        self.assertEqual(changed['summary']['covers_large_generated'], 1)
        self.assertEqual(changed['summary']['covers_pruned'], 6)
        warm = self.export_covers()
        self.assertEqual(warm['summary']['covers_generated'], 0)
        self.assertEqual(warm['summary']['covers_large_generated'], 0)
        self.assertEqual(warm['summary']['covers_reused'], 1)
        self.assertEqual(warm['summary']['covers_large_reused'], 1)

    def test_large_variant_failure_keeps_map_thumbnail(self):
        self.set_art()
        save = Image.Image.save
        def fail_large(image, *args, **kwargs):
            if image.size == (512, 512):
                raise OSError('cannot encode large variant')
            return save(image, *args, **kwargs)
        with patch.object(Image.Image, 'save', fail_large):
            result = self.export_covers()
        self.assertIsNotNone(result['albums'][0]['cover'])
        self.assertIsNone(result['albums'][0]['cover_large'])
        self.assertEqual(result['summary']['covers_large_missing'], 1)
        self.assertEqual(len(list((self.root / 'covers').glob('cover-*.jpg'))), 5)
        self.assertFalse(list((self.root / 'covers').glob('.cover-*')))

    def test_bomb_and_source_change_do_not_publish_thumbnails(self):
        self.set_art()
        # 45,000 pixels: trigger both Pillow warning and error without a large fixture.
        for limit in (30000, 10000):
            with patch.object(Image, 'MAX_IMAGE_PIXELS', limit):
                result = self.export_covers()
            self.assertIsNone(result['albums'][0]['cover'])
            self.assertIsNone(result['albums'][0]['cover_large'])
        from beets_embed.covers import identity
        source = self.root / 'art.png'
        initial = identity(source)
        changed = (*initial[:3], initial[3] + 1)
        for observations in ([initial, changed], [initial, initial, changed]):
            with patch('beets_embed.covers.identity', side_effect=observations):
                result = self.export_covers()
            self.assertIsNone(result['albums'][0]['cover'])
            self.assertFalse(list((self.root / 'covers').glob('cover-*.jpg')))
            self.assertFalse(list((self.root / 'covers').glob('.cover-*')))

    def test_art_and_manifest_aliases_are_protected(self):
        source = self.set_art()
        before = source.read_bytes()
        with self.assertRaises(ValueError):
            self.export_to(source)
        covers = self.root / 'covers'
        covers.mkdir()
        (covers / '.album-graph-covers.json').symlink_to(source)
        with self.assertRaises(ValueError):
            self.export_covers()
        self.assertEqual(source.read_bytes(), before)
        (covers / '.album-graph-covers.json').unlink()
        result = self.export_covers()
        cover = covers / result['albums'][0]['cover']
        cover.unlink()
        os.link(source, cover)
        self.assertIsNone(self.export_covers()['albums'][0]['cover'])
        self.assertEqual(source.read_bytes(), before)
        self.assertTrue(cover.exists())


if __name__ == '__main__':
    unittest.main()
