import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from beets_embed.covers import CoverCache


class CoverMipTests(unittest.TestCase):
    def test_overview_shards_mapping_reuse_abort_and_pruning(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'original.png'
            Image.new('RGB', (64, 64), 'red').save(source)
            cache = CoverCache(root / 'covers', [source], [])
            name = cache.cover(source, size=32)
            albums = [dict(id=i + 1, cover_variants={'32': name}) for i in range(6400)]
            sheets = cache.overview(albums)
            self.assertEqual([len(sheet['album_ids']) for sheet in sheets], [4096, 2304])
            self.assertEqual(sheets[1]['album_ids'][0], 4097)
            for sheet, size in zip(sheets, [(2048, 2048), (2048, 1152)]):
                with Image.open(cache.directory / sheet['file']) as image:
                    self.assertEqual(image.size, size)
            cache.finish()
            previous = {file.name for file in cache.directory.glob('cover-*.jpg')}
            warm = CoverCache(cache.directory, [source], [])
            with patch('beets_embed.covers.Image.open', side_effect=AssertionError('warm decode')):
                self.assertEqual(warm.cover(source, size=32), name)
                self.assertEqual(warm.overview(albums), sheets)
            self.assertEqual(warm.stats['cover_atlases_reused'], 2)
            warm.finish()
            failed = CoverCache(cache.directory, [source], [])
            failed.cover(source, size=64)
            failed.overview(albums[:3])
            failed.abort()
            self.assertEqual({file.name for file in cache.directory.glob('cover-*.jpg')}, previous)
            empty = CoverCache(cache.directory, [source], [])
            empty.finish()
            self.assertEqual(empty.stats['covers_pruned'], 3)
            self.assertEqual(json.loads((cache.directory / '.album-graph-covers.json').read_text())['files'], [])

    def test_sheet_failure_keeps_individual_mip_and_protects_alias(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'original.png'
            Image.new('RGB', (32, 32), 'blue').save(source)
            cache = CoverCache(root / 'covers', [source], [])
            name = cache.cover(source, size=32)
            albums = [dict(id=1, cover_variants={'32': name})]
            with patch('beets_embed.covers.atomic_write', side_effect=OSError('sheet failure')):
                self.assertEqual(cache.overview(albums), [])
            self.assertTrue((cache.directory / name).exists())
            sheet = cache.overview(albums)[0]
            target = cache.directory / sheet['file']
            target.unlink()
            target.symlink_to(source)
            self.assertEqual(cache.overview(albums), [])
            self.assertTrue(source.exists())
