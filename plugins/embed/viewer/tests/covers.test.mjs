import { test } from 'node:test';
import assert from 'node:assert/strict';
import { showCovers, coverCandidates } from '../logic.mjs';
import { CoverLoader, decodeCover, drawnCoverPixels, coverPolicy, constrainedCovers, SPRITE_SIZES } from '../covers.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('forced modes and auto zoom/count boundaries', () => {
  assert.equal(showCovers('covers', 0.1, 6000, 5), true);
  assert.equal(showCovers('dots', 10, 1), false);
  assert.equal(showCovers('auto', 1, 1000), true);
  assert.equal(showCovers('auto', .99, 1000), false);
  assert.equal(showCovers('auto', 1, 1001), false);
  assert.equal(showCovers('auto', 2, 99, 3), false);
});
test('visible covers are bounded, prioritize selection and omit missing art', () => {
  const albums = [{ cover: 'a' }, { cover: null }, { cover: 'b' }, { cover: 'c' }];
  assert.deepEqual(coverCandidates(albums, [0, 1, 2, 3], [2, 2, 999], 2), [2, 0]);
  assert.deepEqual(coverCandidates(albums, [0, 1], [3]), [0]);
});
test('loader caps requests and residency, reuses cached images, and cancels stale work', async () => {
  const pending = new Map(); let active = 0, maximum = 0, changes = 0, calls = [];
  const loader = new CoverLoader((url, signal) => {
    active++; maximum = Math.max(maximum, active); calls.push(url);
    return new Promise((resolve, reject) => {
      pending.set(url, () => { active--; resolve(url); });
      signal.addEventListener('abort', () => { active--; pending.delete(url); reject(new Error('abort')); });
    });
  }, () => changes++, { capacity: 3, concurrency: 2 });
  loader.setWanted(['a', 'b', 'c', 'd']); await tick();
  assert.deepEqual(calls, ['a', 'b']);
  pending.get('a')(); await tick(); assert.deepEqual(calls, ['a', 'b', 'c']);
  pending.get('b')(); pending.get('c')(); await tick();
  assert.equal(loader.images.size, 3); assert.equal(maximum, 2); assert.equal(changes, 3);
  loader.setWanted(['a', 'b']); await tick(); assert.equal(calls.length, 3);
  loader.setWanted(['d']); await tick(); pending.get('d')(); await tick();
  assert.equal(loader.images.size, 3); assert.ok(loader.images.has('d'));
  loader.setWanted(['e', 'f']); await tick();
  loader.setWanted([]); await tick();
  assert.equal(loader.loading.size, 0); assert.ok(!loader.failed.has('e'));
  loader.destroy(); loader.setWanted(['g']); await tick();
  assert.equal(loader.images.size, 0); assert.ok(!calls.includes('g'));
});
test('failed artwork stays dots without an endless retry loop', async () => {
  let calls = 0;
  const loader = new CoverLoader(async () => { calls++; throw new Error('404'); }, () => {});
  loader.setWanted(['missing']); await tick();
  loader.setWanted(['missing']); await tick();
  assert.equal(calls, 1); assert.ok(loader.failed.has('missing'));
  assert.equal(loader.images.size, 0); loader.destroy();
});

test('drawn pixels follow DPR, lens sizes, cosmos zoom and the hardware sprite cap', () => {
  assert.equal(drawnCoverPixels(36, { dpr: 3 }), 108);
  assert.equal(drawnCoverPixels(36 * 1.75, { dpr: 3 }), 189);
  assert.equal(drawnCoverPixels(36, { dpr: 3, zoom: 200 }), 216);
  assert.equal(drawnCoverPixels(36, { dpr: 3, zoom: 500, maxPointPixels: 192 }), 192);
  assert.equal(drawnCoverPixels(12, { dpr: 2, zoom: 3, scaleOnZoom: true, scale: 2 }), 144);
  assert.equal(coverPolicy(108).spriteSize, 128);
  assert.equal(coverPolicy(189).spriteSize, 192);
  assert.equal(coverPolicy(300).spriteSize, 256);
});

test('capacity bounds square atlas bytes and texture dimensions for every sprite tier', () => {
  for (const constrained of [true, false]) for (const pixels of SPRITE_SIZES) {
    const policy = coverPolicy(pixels, { constrained });
    const grid = Math.ceil(Math.sqrt(policy.capacity));
    assert.ok(policy.capacity * pixels ** 2 * 4 <= policy.poolBytes);
    assert.ok((grid * pixels) ** 2 * 4 <= policy.poolBytes);
    assert.ok(grid * pixels <= 4096);
    assert.ok(policy.capacity <= (constrained ? 128 : 256));
  }
  assert.equal(coverPolicy(256, { constrained: true }).capacity, 25);
  assert.equal(coverPolicy(256).capacity, 64);
  assert.equal(coverPolicy(256, { maxTextureSize: 512 }).capacity, 4);
  assert.equal(coverPolicy(256, { maxTextureSize: 128 }).capacity, 0);
  assert.equal(constrainedCovers({ width: 390 }), true);
  assert.equal(constrainedCovers({ width: 1400, coarsePointer: true }), true);
  assert.equal(constrainedCovers({ width: 1400, deviceMemory: 4 }), true);
  assert.equal(constrainedCovers({ width: 1400 }), false);
});

test('resolution replacement aborts old work and cannot insert stale images', async () => {
  let complete, oldSignal, changes = 0;
  const loader = new CoverLoader((url, signal, size) => {
    assert.equal(size, 192); oldSignal = signal;
    return new Promise(resolve => { complete = resolve; });
  }, () => changes++, { spriteSize: 192, capacity: 1 });
  loader.setWanted(['a']); await tick(); loader.destroy();
  assert.equal(oldSignal.aborted, true);
  complete({ width: 192 }); await tick();
  assert.equal(changes, 0); assert.equal(loader.images.size, 0);
  const replacement = new CoverLoader(async (url, signal, size) => ({ width: size }), () => {},
    { spriteSize: 256, capacity: 1 });
  replacement.setWanted(['a']); await tick();
  assert.equal(replacement.images.get('a').width, 256); replacement.destroy();
});

test('decode uses the requested size, high quality resampling and releases temporary buffers', async t => {
  let options, closed = 0, canvas, drawArgs;
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, blob: async () => new Blob(['jpeg']) }));
  const previousBitmap = globalThis.createImageBitmap, previousCanvas = globalThis.OffscreenCanvas;
  t.after(() => { globalThis.createImageBitmap = previousBitmap; globalThis.OffscreenCanvas = previousCanvas; });
  globalThis.createImageBitmap = async (blob, resize) => { options = resize; return { close: () => closed++ }; };
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; canvas = this; }
    getContext() { return { drawImage: (...args) => { drawArgs = args; },
      getImageData: (x, y, width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) }; }
  };
  const controller = new AbortController();
  const image = await decodeCover('a', controller.signal, 192);
  assert.deepEqual(options, { resizeWidth: 192, resizeHeight: 192, resizeQuality: 'high' });
  assert.equal(image.width, 192); assert.equal(image.data.byteLength, 192 ** 2 * 4);
  assert.deepEqual(drawArgs.slice(1), [0, 0, 192, 192]);
  assert.equal(closed, 1); assert.equal(canvas.width, 0); assert.equal(canvas.height, 0);
  globalThis.createImageBitmap = async () => { controller.abort(); return { close: () => closed++ }; };
  await assert.rejects(decodeCover('a', controller.signal, 256), /cancelled/);
  assert.equal(closed, 2);
  await assert.rejects(decodeCover('a', controller.signal, 512), /Invalid sprite size/);
});

test('decode refuses failed HTTP and oversized files before image decoding', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 404 }));
  await assert.rejects(decodeCover('a', new AbortController().signal, 256), /HTTP 404/);
  globalThis.fetch = async () => ({ ok: true, blob: async () => ({ size: 1024 * 1024 + 1 }) });
  await assert.rejects(decodeCover('a', new AbortController().signal, 256), /Oversized/);
});
