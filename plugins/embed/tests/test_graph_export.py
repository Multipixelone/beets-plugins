import hashlib
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from beets.library import Album, Item, Library
from beetsplug.embed import EmbedPlugin
from beets_embed.graph_export import export_albums, plays, protect_output
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
        self.assertEqual(result['summary'], dict(selected_albums=2, exported_albums=1, skipped_albums=1))
        album = result['albums'][0]
        self.assertEqual(album['id'], self.first.id)
        self.assertEqual(album['album'], 'First')
        self.assertEqual(album['genre'], 'Folk')
        self.assertEqual(album['year'], 2001)
        self.assertEqual(album['track_count'], 3)
        self.assertEqual(album['embedded_tracks'], 2)
        self.assertEqual(album['summed_plays'], 16)
        self.assertAlmostEqual(album['mean_plays'], 16 / 3)
        np.testing.assert_array_equal(album['vector'], [.5, .5])
        self.assertEqual(result['model_id'], 'style:v1')
        self.assertEqual(result['schema_version'], 1)
        self.assertIn('+00:00', result['exported_at'])
        self.assertEqual(json.loads(self.output.read_text()), result)

    def test_query_selects_whole_album_without_writes_or_inference(self):
        standalone = Item(path=b'/unused.wav', artist='Finn', album='Single')
        self.lib.add(standalone)
        before = list(self.lib._connection().iterdump())
        store_hash = hashlib.sha256(self.store_path.read_bytes()).hexdigest()
        command = next(cmd for cmd in EmbedPlugin().commands() if cmd.name == 'embed-graph-export')
        opts, args = command.parser.parse_args(['-o', str(self.output), '--store', str(self.store_path),
                                               f'id:{self.items[0].id}'])
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
        self.assertEqual(before, list(self.lib._connection().iterdump()))
        self.assertEqual(store_hash, hashlib.sha256(self.store_path.read_bytes()).hexdigest())
        opts, args = command.parser.parse_args(['-o', str(self.output), '--store', str(self.store_path),
                                               f'id:{standalone.id}'])
        with patch('beetsplug.embed.model_ids', return_value={'style': 'style:v1'}):
            command.func(self.lib, opts, args)
        self.assertEqual(json.loads(self.output.read_text())['albums'], [])

    def test_zero_lastfm_does_not_fall_back_and_missing_plays(self):
        for item, expected in [({'lastfm_play_count': '0', 'play_count': '9'}, 0),
                               ({'lastfm_play_count': None, 'play_count': '9'}, 9),
                               ({}, 0), ({'play_count': 'nan'}, 0), ({'play_count': '-1'}, 0)]:
            self.assertEqual(plays(item), expected)

    def test_fingerprint_model_and_missing_store(self):
        self.assertEqual(self.export(model='text:v1')['albums'], [])
        Path(os.fsdecode(self.items[0].path)).write_bytes(b'changed audio')
        result = self.export()
        self.assertEqual(result['albums'][0]['embedded_tracks'], 1)
        self.assertEqual(result['albums'][0]['vector'], [0, 1])
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


if __name__ == '__main__':
    unittest.main()
