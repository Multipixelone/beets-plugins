import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { atlasLayout, createAtlasDataFromImageData } from '../atlas.mjs';
import { patchCosmosAtlas } from '../cosmos-atlas-patch.mjs';

test('atlas packs mixed sizes with stable input indices, correct pixels and extruded gutters', () => {
  const images = [2, 4, 1].map((size, index) => ({ width: size, height: size,
    data: new Uint8ClampedArray(size ** 2 * 4).fill(50 + index * 50) }));
  const packed = createAtlasDataFromImageData(images);
  const layout = atlasLayout(images);
  assert.equal(packed.atlasData.length, layout.bytes);
  assert.equal(packed.atlasCoordsSize, 2);
  images.forEach((image, index) => {
    const [x, y] = layout.positions[index];
    assert.deepEqual([...packed.atlasCoords.slice(index * 4, index * 4 + 4)],
      [x, y, x + image.width, y + image.height].map(value => Math.fround(value / layout.side)));
    for (const [dx, dy] of [[0, 0], [-1, -1], [image.width, image.height]]) {
      assert.equal(packed.atlasData[((y + dy) * layout.side + x + dx) * 4], 50 + index * 50);
    }
  });
  assert.deepEqual([...packed.atlasCoords.slice(12)], [-1, -1, -1, -1]);
  assert.equal(createAtlasDataFromImageData([], 2048), null);
  assert.equal(atlasLayout([{ width: 256, height: 256 }], 128), null);
});
test('pinned Cosmos adapter replaces exactly its atlas helper and rejects changed versions/bundles', async () => {
  const source = await readFile(new URL('../node_modules/@cosmos.gl/graph/dist/index.js', import.meta.url), 'utf8');
  const patched = patchCosmosAtlas(source, '3.4.2', '/tmp/atlas.mjs');
  assert.ok(patched.includes('function Ai(a, e = 16384) { return albumAtlas(a, e); }'));
  assert.ok(!patched.includes('Atlas scaling required'));
  assert.throws(() => patchCosmosAtlas(source, '3.4.3', '/tmp/atlas.mjs'), /exact pinned/);
  assert.throws(() => patchCosmosAtlas(source + '\n', '3.4.2', '/tmp/atlas.mjs'), /exact pinned/);
});
