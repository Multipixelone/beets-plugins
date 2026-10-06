import { test } from 'node:test';
import assert from 'node:assert/strict';
import { showCovers, coverCandidates } from '../logic.mjs';
import { CoverLoader, decodeCover, decodeOverview, drawnCoverPixels, coverPolicy, constrainedCovers,
  SPRITE_SIZES, mipTier, coverPriority } from '../covers.mjs';
import { atlasLayout } from '../atlas.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
const image = size => ({ width: size, height: size, data: new Uint8ClampedArray(size ** 2 * 4) });
const request = (key, tier) => ({ key, tier, baseURL: `${key}-32.jpg`, url: `${key}-${tier}.jpg` });

test('forced modes and automatic zoom hysteresis have no library-size cutoff', () => {
  assert.equal(showCovers('covers', .1, 6400, 5), true);
  assert.equal(showCovers('dots', 10, 1), false);
  assert.equal(showCovers('auto', 1, 6400), true);
  assert.equal(showCovers('auto', .99, 400), false);
  assert.equal(showCovers('auto', .85, 6400, 1, true), true);
  assert.equal(showCovers('auto', .79, 6400, 1, true), false);
});
test('visible candidates omit missing and offscreen art; priority combines center, size and plays', () => {
  const albums = [0, 1, 2].map(i => ({ id: i + 1, cover: `${i}.jpg`, summed_plays: i * 100 }));
  assert.deepEqual(coverCandidates(albums, [0, 1], [2, 1], Infinity), [1, 0]);
  assert.deepEqual(coverPriority(albums, [0, 1, 2], [0, 0, 50, 0, 100, 0], [32, 32, 32], [0, 0]), [0, 1, 2]);
  assert.equal(coverPriority(albums, [0, 1, 2], [0, 0, 50, 0, 100, 0], [32, 32, 32], [0, 0], [2])[0], 2);
  assert.equal(coverPriority(albums, [0, 1, 2], [0, 0, 0, 0, 0, 0], [32, 64, 32], [0, 0])[0], 1);
});
test('DPR, geometry and GPU cap determine per-album demand; hysteresis resists tiny zoom changes', () => {
  assert.equal(drawnCoverPixels(36, { dpr: 3 }), 108);
  assert.equal(drawnCoverPixels(36 * 1.75, { dpr: 3 }), 189);
  assert.equal(drawnCoverPixels(36, { dpr: 3, zoom: 500, maxPointPixels: 192 }), 192);
  assert.equal(drawnCoverPixels(12, { dpr: 2, zoom: 3, scaleOnZoom: true, scale: 2 }), 144);
  assert.equal(mipTier(68, 64), 64); assert.equal(mipTier(77, 64), 128);
  assert.equal(mipTier(55, 128), 128); assert.equal(mipTier(50, 128), 64);
  assert.equal(coverPolicy(189).spriteSize, 256);
});
test('16 MiB phone and desktop budgets support resident base tiers at library scale', () => {
  for (const constrained of [true, false]) for (const count of [400, 2719, 6400]) {
    const policy = coverPolicy(32, { constrained, count });
    assert.equal(policy.poolBytes, 16 * 1024 ** 2);
    assert.ok((Math.ceil(Math.sqrt(count)) * (policy.baseSize + 2)) ** 2 * 4 <= policy.poolBytes / 2);
    assert.ok(count * policy.baseSize ** 2 * 4 <= policy.poolBytes / 2);
  }
  assert.equal(coverPolicy(32, { count: 6400 }).baseSize, 16);
  assert.equal(coverPolicy(32, { count: 2719 }).baseSize, 24);
  assert.equal(constrainedCovers({ width: 390 }), true);
  assert.equal(constrainedCovers({ width: 1400 }), false);
  for (const poolBytes of [8, 16].map(mib => mib * 1024 ** 2)) for (const size of SPRITE_SIZES) {
    const side = Math.floor(Math.sqrt(poolBytes / 4));
    const capacity = Math.floor(side / (size + 2)) ** 2;
    assert.ok(atlasLayout(Array.from({ length: capacity }, () => ({ width: size, height: size })), 4096, poolBytes));
    assert.equal(atlasLayout(Array.from({ length: capacity + 1 }, () => ({ width: size, height: size })), 4096, poolBytes), null);
  }
});
test('base icons survive delayed and failed upgrades and cancelled resolution work', async () => {
  const pending = new Map(); let active = 0, maximum = 0, changes = 0;
  const loader = new CoverLoader((url, signal, size) => new Promise((resolve, reject) => {
    active++; maximum = Math.max(maximum, active);
    pending.set(url, { resolve: () => { active--; resolve(image(size)); }, reject: () => { active--; reject(Error('404')); } });
    signal.addEventListener('abort', () => { active--; reject(Error('abort')); });
  }), () => changes++, { baseSize: 16, concurrency: 2 });
  const base = image(16); loader.setBase('a', base);
  loader.setWanted([request('a', 64)]); await tick();
  assert.equal(loader.best('a'), base);
  pending.get('a-64.jpg').resolve(); await tick();
  const old = loader.best('a'); assert.equal(old.width, 64);
  loader.setWanted([request('a', 128)]); await tick(); assert.equal(loader.best('a'), old);
  pending.get('a-128.jpg').reject(); await tick(); assert.equal(loader.best('a'), old);
  loader.setWanted([request('a', 256)]); await tick();
  loader.setWanted([request('a', 64)]); pending.get('a-256.jpg').resolve(); await tick();
  assert.equal(loader.best('a'), old); assert.ok(maximum <= 2); assert.ok(changes >= 2);
  loader.destroy();
});
test('byte LRU evicts detailed tiers to resident bases and hidden covers lose detail', async () => {
  const loader = new CoverLoader(async (url, signal, size) => image(size), () => {},
    { baseSize: 1, poolBytes: 64 ** 2 * 4 * 2, concurrency: 1 });
  loader.setBase('a', image(1)); loader.setBase('b', image(1));
  loader.setWanted([request('a', 64)]); await tick();
  assert.equal(loader.best('a').width, 64);
  loader.setWanted([request('b', 64)]); await tick();
  assert.equal(loader.best('b').width, 64); assert.equal(loader.best('a').width, 1);
  assert.ok(loader.detailBytes <= loader.poolBytes / 2);
  loader.dropHidden(new Set(['a'])); assert.equal(loader.best('b').width, 1);
  loader.destroy();
});
test('overview defers per-album base requests; shard failures release the fallback', async () => {
  const calls = [];
  const bases = ['a', 'b'].map(key => request(key, 16));
  const loader = new CoverLoader(async (url, signal, size) => { calls.push(url); return image(size); }, () => {},
    { baseSize: 16, baseRequests: bases, deferredBase: ['a', 'b'] });
  loader.setWanted(bases); await tick(); assert.deepEqual(calls, []);
  loader.setBase('a', image(16)); loader.releaseDeferred(['a', 'b']); await tick();
  assert.deepEqual(calls, ['b-32.jpg']); assert.equal(loader.base.size, 2);
  loader.destroy();
});
test('mixed atlas keeps thousands of base sprites when a few need 256px detail', async () => {
  const loader = new CoverLoader(async () => {}, () => {}, { baseSize: 16 });
  const keys = Array.from({ length: 6400 }, (_, i) => String(i));
  for (const key of keys) loader.setBase(key, image(16));
  for (const key of keys.slice(0, 32)) loader.details.set(`${key}\n256`, { key, tier: 256, image: image(256) });
  const entries = loader.atlasEntries(keys, keys.slice(0, 32).map(key => request(key, 256)));
  assert.equal(entries.length, 6400);
  assert.ok(entries.some(([, img]) => img.width === 256));
  assert.ok(atlasLayout(entries.map(([, img]) => img)).bytes <= 16 * 1024 ** 2);
  loader.destroy();
});
test('decode sizes and sheet extraction release bitmap and canvas staging memory', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, blob: async () => new Blob(['jpeg']) }));
  const previousBitmap = globalThis.createImageBitmap, previousCanvas = globalThis.OffscreenCanvas;
  let closed = 0, canvases = [], options;
  t.after(() => { globalThis.createImageBitmap = previousBitmap; globalThis.OffscreenCanvas = previousCanvas; });
  globalThis.createImageBitmap = async (blob, resize) => { options = resize; return { width: 64, height: 32, close: () => closed++ }; };
  globalThis.OffscreenCanvas = class {
    constructor() { canvases.push(this); }
    getContext() { return { drawImage() {}, getImageData: (x, y, width) => image(width) }; }
  };
  assert.equal((await decodeCover('a', new AbortController().signal, 24)).width, 24);
  assert.deepEqual(options, { resizeWidth: 24, resizeHeight: 24, resizeQuality: 'high' });
  const tiles = [];
  await decodeOverview('sheet', { columns: 2, album_ids: [10, 20] }, new AbortController().signal, 16,
    (id, img) => tiles.push([id, img.width]));
  assert.deepEqual(tiles, [[10, 16], [20, 16]]); assert.equal(closed, 2);
  assert.ok(canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  await assert.rejects(decodeCover('a', new AbortController().signal, 512), /Invalid sprite size/);
  await assert.rejects(decodeOverview('sheet', { columns: 1, album_ids: [10] }, new AbortController().signal, 16, () => {}), /dimensions/);
  assert.equal(closed, 3);
});
test('decode refuses failed HTTP and oversized files before bitmap allocation', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 404 }));
  await assert.rejects(decodeCover('a', new AbortController().signal, 256), /HTTP 404/);
  globalThis.fetch = async () => ({ ok: true, blob: async () => ({ size: 1024 * 1024 + 1 }) });
  await assert.rejects(decodeCover('a', new AbortController().signal, 256), /Oversized/);
});
