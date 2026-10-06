import { test } from 'node:test';
import assert from 'node:assert/strict';
import { showCovers, coverCandidates } from '../logic.mjs';
import { CoverLoader } from '../covers.mjs';
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
