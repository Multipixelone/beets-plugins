import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FilterPositions, visibleLinks, bridgeLinks, edgeStyles as themedEdgeStyles } from '../visibility.mjs';
import { selectionState, groupLabels } from '../sound.mjs';

const palette = { base: [.6, .5, .4], bridge: [.5, .7, .4], focus: [1, .6, .2], secondary: [.7, .6, .5] };
const edgeStyles = (edges, options) => themedEdgeStyles(edges, { palette, ...options });

const finite = array => [...array].map(value => Number.isFinite(value));
test('edge tiers use the supplied theme without losing opacity or width hierarchy', () => {
  const edges = [{ source: 0, target: 1, similarity: .99 }, { source: 0, target: 2, similarity: .9 },
    { source: 2, target: 3, similarity: .8 }, { source: 3, target: 4, similarity: .7 },
    { source: 4, target: 5, similarity: .6 }];
  const result = edgeStyles(edges, { selected: 0, detailLimit: 1, mode: 'all', coverPixels: 100,
    bridges: new Set([2]), strongest: new Set([3]) });
  [palette.focus, palette.secondary, palette.bridge, palette.base, palette.base].forEach((rgb, index) => {
    const actual = result.colors.slice(index * 4, index * 4 + 3);
    assert.ok(rgb.every((channel, i) => Math.abs(channel - actual[i]) < 1e-6));
  });
  assert.ok(result.colors[3] > result.colors[7]);
  assert.ok(result.colors[11] > result.colors[15] && result.colors[15] > result.colors[19]);
  assert.ok(result.widths[0] > result.widths[1]);
});
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
test('unknown filter values change visible members while canonical group labels stay stable', () => {
  const albums = [{ album: 'Known', albumartist: 'Finn', essentia: { voice_instrumental: { value: 'instrumental' } }, sound: {
    style: { labels: [{ label: 'Quiet', score: .6 }] } } },
  { album: 'Unknown', albumartist: 'Finn', sound: { style: { labels: [{ label: 'Loud', score: 1 }] } } }];
  const filtered = selectionState(albums, { vocal: 'instrumental' });
  assert.deepEqual(filtered.matches, [0]); assert.equal(filtered.states[1].opacity, 0);
  assert.deepEqual(selectionState(albums, { vocal: 'instrumental', includeUnknown: true }).matches, [0, 1]);
  const labels = groupLabels(albums, ['Community 1', 'Community 1'], i => filtered.states[i].match);
  assert.deepEqual(labels[0].indices, [0]); assert.equal(labels[0].text, 'Loud');
});

test('bridge hierarchy retains strongest visible connection for every community pair', () => {
  const edges = [{ source: 0, target: 1, similarity: .99 }, { source: 0, target: 2, similarity: .81 },
    { source: 1, target: 3, similarity: .95 }, { source: 3, target: 4, similarity: .9 },
    { source: 1, target: 4, similarity: .8 }];
  const clusters = [0, 0, 1, 1, 2];
  assert.deepEqual([...bridgeLinks(edges, clusters)].sort(), [2, 3, 4]);
  assert.deepEqual([...bridgeLinks(edges, clusters, [1, 1, 1, 0, 1])].sort(), [1, 4]);
  const styled = edgeStyles(edges, { clusters, strongest: new Set() });
  assert.equal(styled.colors[1 * 4 + 3], 0);
  assert.ok(styled.colors[2 * 4 + 3] > 0);
  assert.ok(styled.colors[3 * 4 + 3] > 0);
  assert.ok(styled.colors[4 * 4 + 3] > 0);
});

test('bridge ties stay on the same endpoints when edge order changes', () => {
  const edges = [{ source: 2, target: 3, similarity: .8 }, { source: 0, target: 1, similarity: .8 }];
  const clusters = [0, 1, 0, 1], reversed = [...edges].reverse();
  assert.deepEqual([...bridgeLinks(edges, clusters)].map(i => edges[i]),
    [...bridgeLinks(reversed, clusters)].map(i => reversed[i]));
});

test('small selected albums keep every incident edge but avoid a bright fan', () => {
  const edges = Array.from({ length: 12 }, (_, index) => ({ source: 0, target: index + 1, similarity: .99 - index * .02 }));
  const overview = edgeStyles(edges, { selected: 0, coverPixels: 8 });
  const close = edgeStyles(edges, { selected: 0, coverPixels: 100 });
  assert.equal(overview.incident.size, 12);
  assert.equal(overview.detail.size, 6);
  assert.equal(overview.points.size, 13);
  assert.ok([...overview.incident].every(i => overview.colors[i * 4 + 3] > 0 && overview.widths[i] > 0));
  assert.ok([...overview.incident].every(i => overview.colors[i * 4 + 3] <= .31 && overview.widths[i] <= .66));
  assert.ok(overview.colors[3] > overview.colors[11 * 4 + 3]);
  assert.ok(close.colors[3] > overview.colors[3] && close.widths[0] > overview.widths[0]);
  assert.ok(close.colors[11 * 4 + 3] < close.colors[3]);
});

test('zoom changes edge emphasis continuously without changing the chosen edges', () => {
  const edges = [{ source: 0, target: 1, similarity: .9 }, { source: 1, target: 2, similarity: .8 }];
  const before = edgeStyles(edges, { selected: 0, coverPixels: 31.99 });
  const after = edgeStyles(edges, { selected: 0, coverPixels: 32.01 });
  assert.deepEqual(before.detail, after.detail);
  assert.ok(after.colors.every((value, i) => Math.abs(value - before.colors[i]) < .001));
  assert.ok(after.widths.every((value, i) => Math.abs(value - before.widths[i]) < .001));
});

test('filters override cached edge tiers and hidden hover targets', () => {
  const edges = [{ source: 0, target: 1, similarity: .9 }, { source: 0, target: 2, similarity: .8 }];
  const result = edgeStyles(edges, { selected: 0, hovered: 1, visible: [1, 0, 1],
    bridges: new Set([0]), strongest: new Set([0]), mode: 'all' });
  assert.equal(result.focus, 0);
  assert.equal(result.colors[3], 0);
  assert.equal(result.widths[0], 0);
  assert.deepEqual([...result.incident], [1]);
  assert.ok(result.colors[7] > 0);
  const hover = edgeStyles(edges, { selected: 0, hovered: 2, mode: 'selected' });
  assert.equal(hover.focus, 2);
  assert.equal(hover.colors[3], 0);
  assert.ok(hover.colors[7] > 0);
  assert.ok(edgeStyles(edges, { mode: 'selected' }).colors.every(value => value === 0));
});
