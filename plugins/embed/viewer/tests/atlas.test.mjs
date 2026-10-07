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
  // All three GPU draw paths use the same unbounded geometry: visible covers,
  // opaque cores, and picking. A partial conversion causes capped hit targets,
  // missing art, or invalid element-index access when zoomed close.
  for (const command of ['drawCommand', 'drawCoreCommand', 'fillPickingBufferCommand']) {
    const model = patched.slice(patched.indexOf(`this.${command} = new k(e, {`));
    const options = model.slice(0, model.indexOf('\n    }))'));
    assert.match(options, /topology: "triangle-strip"/);
    assert.match(options, /vertexCount: 4,/);
    assert.match(options, /instanceCount: n.pointsNumber/);
    assert.match(options, /name: "pointIndices", format: "float32x2", stepMode: "instance"/);
    assert.match(options, /name: "albumCorner", format: "float32x2", stepMode: "vertex"/);
    assert.match(options, /albumCorner: this.dragPointVertexCoordBuffer/);
    assert.doesNotMatch(options, /indexBuffer:/);
    assert.ok(patched.includes(`this.${command}.setInstanceCount(`));
    assert.ok(!patched.includes(`this.${command}.setVertexCount(`));
    if (command === 'fillPickingBufferCommand') {
      // Programs are initialized before the first data set: never pass an
      // undefined shape buffer to luma's vertex-array binding.
      assert.match(options, /\.\.\.this.shapeBuffer && \{ shape: this.shapeBuffer \}/);
    }
  }
  assert.ok(!patched.includes('return min(size * ratio * zoom, maxPointSize * ratio);'));
  assert.ok(!patched.includes('overallSizeValue = min(overallSizeValue, maxPointSize * ratio)'));
  assert.ok(!patched.includes('Math.min(Math.max(s, 1 / i), n) / 2'));
  // The cosmetic border cap is shared by the visible and picking shaders,
  // independent of artwork zoom and the world's existing collision padding.
  assert.equal(patched.match(/shapeSizeValue = albumFrameSizePx\(shapeSizeValue, imageSizeValue, shape, hasImage, ratio\);/g).length, 2);
  assert.ok(patched.includes('hasImage && shape == 1.0 ? min(shapeSize, (imageSize + 4.0 * ratio) / 0.8) : shapeSize'));
  assert.ok(patched.includes('albumSquare < 0.5 && dot(fromCenter, fromCenter) > 1.0'));
  assert.ok(patched.includes('albumPointCoord = vec2(corner.x, -corner.y)'));
  assert.ok(patched.includes('L.end(), this.device.submit(), this.config.onRenderFrame?.();'));
  const frame = patched.slice(patched.indexOf('  renderFrame(e) {'), patched.indexOf('\n  stopFrames()'));
  assert.ok(frame.indexOf('C.drag()') < frame.indexOf('p.draw(L)'));
  assert.ok(patched.includes('finalImageColor.a * shapeColor.a'));
  assert.ok(patched.includes('albumVibeActive: i.albumVibeActive ? 1 : 0'));
  assert.ok(patched.includes('i.albumCollisionSizes?.[p] ?? i.getResolvedPointSize(p)'));
  assert.throws(() => patchCosmosAtlas(source, '3.4.3', '/tmp/atlas.mjs'), /exact pinned/);
  assert.throws(() => patchCosmosAtlas(source + '\n', '3.4.2', '/tmp/atlas.mjs'), /exact pinned/);
});
