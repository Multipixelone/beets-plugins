import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAdded, buildTimeline, timelineCutoff, timelineMembership, applyTimeline,
  timelineStacks, timelinePositionForKey } from '../timeline.mjs';
import { selectionState } from '../sound.mjs';
import { FilterPositions, edgeStyles } from '../visibility.mjs';

const album = added => ({ added, album: 'Album', albumartist: 'Artist' });
const at = value => Date.parse(value);
test('strict UTC parsing accepts fractions and leap days without rolling invalid calendars', () => {
  for (const value of ['2024-02-29T12:30:59Z', '2024-02-29T12:30:59.1Z',
    '2024-02-29T12:30:59.123456Z', '0099-01-01T00:00:00Z']) assert.equal(parseAdded(value), at(value));
  for (const value of [null, undefined, 1700000000, '1700000000', '', '2024-02-29',
    '2024-02-29T12:30:59', '2024-02-29T12:30:59+00:00', '2023-02-29T00:00:00Z',
    '2024-02-31T00:00:00Z', '2024-00-01T00:00:00Z', '2024-13-01T00:00:00Z',
    '2024-01-00T00:00:00Z', '2024-01-01T24:00:00Z', '2024-01-01T00:60:00Z',
    '2024-01-01T00:00:60Z', ' 2024-01-01T00:00:00Z']) assert.ok(Number.isNaN(parseAdded(value)), String(value));
});
test('half-open bins and strict membership include the whole selected UTC day', () => {
  const model = buildTimeline(['2024-02-28T23:59:59.999999Z', '2024-02-29T00:00:00Z',
    '2024-03-01T00:00:00Z', null].map(album));
  assert.equal(model.unit, 'day'); assert.deepEqual([...model.albumBins], [0, 1, 2, -1]);
  assert.equal(timelineCutoff(model, 1), at('2024-03-01T00:00:00Z'));
  assert.deepEqual(timelineMembership(model.dates, timelineCutoff(model, 1)).eligible, [true, true, false, false]);
  assert.equal(timelineMembership(model.dates, timelineCutoff(model, -1)).count, 0);
  assert.equal(timelineMembership(model.dates, timelineCutoff(model, 2)).count, 3);
  assert.equal(timelineMembership(model.dates, timelineCutoff(model, null)).count, 4);
});
test('adaptive calendar bins preserve quiet intervals, additions and cumulative counts', () => {
  const model = buildTimeline(['2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z',
    '2024-04-01T00:00:00Z'].map(album));
  assert.equal(model.unit, 'month');
  assert.deepEqual(model.bins.map(bin => bin.count), [2, 0, 0, 1]);
  assert.deepEqual(model.bins.map(bin => bin.cumulative), [2, 2, 2, 3]);
  assert.equal(model.maxCount, 2);
  assert.equal(timelineCutoff(model, 1), at('2024-03-01T00:00:00Z'));
  const yearly = buildTimeline(['2000-01-01T00:00:00Z', '2010-01-01T00:00:00Z'].map(album));
  assert.equal(yearly.unit, 'year'); assert.equal(yearly.bins.length, 11);
  const long = buildTimeline(['0001-01-01T00:00:00Z', '9999-12-31T23:59:59Z'].map(album));
  assert.ok(long.bins.length <= 120); assert.equal(long.bins.reduce((sum, bin) => sum + bin.count, 0), 2);
});
test('UTC daily boundaries stay uniform across DST changes', () => {
  const model = buildTimeline(['2024-03-09T23:00:00Z', '2024-03-11T01:00:00Z'].map(album));
  assert.equal(model.bins.length, 3);
  assert.ok(model.bins.every(bin => bin.end - bin.start === 86400000));
});
test('single-date imports and legacy or empty exports are nonfatal', () => {
  const single = buildTimeline(Array.from({ length: 20 }, () => album('2024-02-29T12:00:00Z')));
  assert.equal(single.bins.length, 1); assert.equal(single.maxCount, 20);
  for (const albums of [[], [{}, { added: null }, { added: 'invalid' }]]) {
    const model = buildTimeline(albums);
    assert.equal(model.bins.length, 0); assert.equal(model.undated, albums.length);
    assert.equal(timelineMembership(model.dates).count, albums.length);
  }
});
test('community stacks rebuild without changing boundaries, totals or scale', () => {
  const model = buildTimeline(['2024-01-01T00:00:00Z', '2024-01-01T12:00:00Z',
    '2024-01-02T00:00:00Z', null].map(album));
  const before = JSON.stringify(model.bins);
  assert.deepEqual(timelineStacks(model, ['b', 'a', 'b', 'a'], ['a', 'b']),
    [[{ name: 'a', count: 1 }, { name: 'b', count: 1 }], [{ name: 'b', count: 1 }]]);
  assert.deepEqual(timelineStacks(model, ['a', 'a', 'a', 'b'], ['a', 'b']),
    [[{ name: 'a', count: 2 }], [{ name: 'a', count: 1 }]]);
  assert.equal(JSON.stringify(model.bins), before); assert.equal(model.maxCount, 2);
});
test('cutoff composes with every selection field without resizing or revealing albums', () => {
  const albums = ['2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z', null].map(album);
  albums[0].album = 'Find'; albums[1].album = 'Find';
  const model = buildTimeline(albums), temporal = timelineMembership(model.dates, timelineCutoff(model, 0));
  const base = selectionState(albums, { search: 'Find', phraseScores: [0, 2, 4] });
  const composed = applyTimeline(base, temporal);
  assert.deepEqual(composed.visibleIndices, [0]); assert.deepEqual(composed.matches, []);
  assert.equal(composed.active, true); assert.equal(composed.vibeActive, true); assert.equal(composed.filterActive, true);
  for (const [index, state] of composed.states.entries()) {
    for (const key of ['size', 'baseSize', 'strength']) assert.equal(state[key], base.states[index][key]);
  }
  assert.equal(composed.states[1].opacity, 0); assert.equal(composed.states[2].visible, false);
  assert.deepEqual(applyTimeline(selectionState(albums), temporal).matches, [0]);
  assert.equal(applyTimeline(selectionState(albums), temporal).active, true);
  assert.strictEqual(applyTimeline(base, timelineMembership(model.dates)), base);
  assert.equal(base.states[1].visible, true, 'composition does not mutate its input');
  assert.equal(temporal.count, 1, 'snapshot counts ignore phrase salience');
});
test('sound unknown inclusion cannot admit undated albums into history', () => {
  const albums = [album('2024-01-01T00:00:00Z'), album(null)];
  const model = buildTimeline(albums);
  const temporal = timelineMembership(model.dates, timelineCutoff(model, 0));
  const selection = selectionState(albums, { vocal: 'instrumental', includeUnknown: true });
  assert.deepEqual(applyTimeline(selection, temporal).visibleIndices, [0]);
});
test('backward and forward snapshots preserve positions and remove incident edges', () => {
  const albums = ['2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z', null].map(album);
  const model = buildTimeline(albums), positions = new FilterPositions(3);
  const initial = new Float32Array([1.25, 2.5, 3.75, 4, 5, 6]); positions.seed(initial);
  const visible = timelineMembership(model.dates, timelineCutoff(model, 0)).eligible;
  const hidden = positions.update(initial, visible);
  assert.ok(Number.isNaN(hidden[2]) && Number.isNaN(hidden[4]));
  const edges = edgeStyles([{ source: 0, target: 1 }, { source: 0, target: 2 }],
    { visible, mode: 'all', palette: { base: [1, 1, 1] } });
  assert.ok(edges.colors.every(value => value === 0)); assert.ok(edges.widths.every(value => value === 0));
  assert.deepEqual(positions.update(hidden, timelineMembership(model.dates).eligible), initial);
});
test('keyboard positions distinguish final dated bin, before-first and Latest', () => {
  assert.equal(timelinePositionForKey('End', null, 3), 2);
  assert.equal(timelinePositionForKey('Home', null, 3), -1);
  assert.equal(timelinePositionForKey('ArrowLeft', null, 3), 2);
  assert.equal(timelinePositionForKey('ArrowLeft', -1, 3), -1);
  assert.equal(timelinePositionForKey('ArrowRight', 1, 3), 2);
  assert.equal(timelinePositionForKey('ArrowRight', 2, 3), null);
  assert.equal(timelinePositionForKey('Escape', 0, 3), null);
  assert.equal(timelinePositionForKey('Enter', 0, 3), undefined);
  assert.equal(timelinePositionForKey('Home', null, 0), undefined);
});
