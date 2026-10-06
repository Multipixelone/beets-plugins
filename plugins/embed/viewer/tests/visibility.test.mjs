import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FilterPositions, visibleLinks } from '../visibility.mjs';
import { selectionState, groupLabels } from '../sound.mjs';

const finite = array => [...array].map(value => Number.isFinite(value));
test('hidden positions freeze in saved coordinates while visible points continue moving', () => {
  const state = new FilterPositions(3);
  state.seed([10, 20, 30, 40, 50, 60]);
  const first = state.update([11, 21, 31, 41, 51, 61], [true, false, true]);
  assert.deepEqual(finite(first), [true, true, false, false, true, true]);
  assert.deepEqual([...first.slice(0, 2)], [11, 21]);
  assert.equal(state.update(first, [true, false, true]), null);
  const second = state.update([15, 25, NaN, NaN, 55, 65], [false, true, true]);
  assert.deepEqual([...second.slice(2)], [31, 41, 55, 65]);
  const clear = state.update([NaN, NaN, 35, 45, 57, 67], [true, true, true]);
  assert.deepEqual([...clear], [15, 25, 35, 45, 57, 67]);
});
test('zero matches and repeated changes retain every coordinate and graph index', () => {
  const state = new FilterPositions(3); state.seed([1, 2, 3, 4, 5, 6]);
  const none = state.update([], [false, false, false]);
  assert.ok([...none].every(Number.isNaN));
  const one = state.update(none, [false, true, false]);
  assert.deepEqual([...one.slice(2, 4)], [3, 4]);
  const all = state.update(one, [true, true, true]);
  assert.deepEqual([...all], [1, 2, 3, 4, 5, 6]);
});
test('visible links exclude either hidden endpoint and choose strongest among remaining neighbours', () => {
  const edges = [{ source: 0, target: 1, similarity: .99 }, { source: 0, target: 2, similarity: .8 },
    { source: 2, target: 3, similarity: .9 }, { source: 0, target: 3, similarity: .7 }];
  assert.deepEqual([...visibleLinks(edges, [1, 0, 1, 1], 'all')], [1, 2, 3]);
  assert.deepEqual([...visibleLinks(edges, [1, 0, 1, 1], 'strongest')].sort(), [1, 2]);
  assert.deepEqual([...visibleLinks(edges, [1, 0, 1, 1], 'selected', 0)], [1, 3]);
  assert.equal(visibleLinks(edges, [0, 0, 0, 0], 'all').size, 0);
});
test('unknown filter values change visibility and hidden members do not determine group labels', () => {
  const albums = [{ album: 'Known', albumartist: 'Finn', essentia: { voice_instrumental: { value: 'instrumental' } }, sound: {
    style: { labels: [{ label: 'Quiet', score: .6 }] } } },
  { album: 'Unknown', albumartist: 'Finn', sound: { style: { labels: [{ label: 'Loud', score: 1 }] } } }];
  const filtered = selectionState(albums, { vocal: 'instrumental' });
  assert.deepEqual(filtered.matches, [0]); assert.equal(filtered.states[1].opacity, 0);
  assert.deepEqual(selectionState(albums, { vocal: 'instrumental', includeUnknown: true }).matches, [0, 1]);
  const labels = groupLabels(albums, ['Community 1', 'Community 1'], i => filtered.states[i].match);
  assert.deepEqual(labels[0].indices, [0]); assert.equal(labels[0].text, 'Quiet');
});
