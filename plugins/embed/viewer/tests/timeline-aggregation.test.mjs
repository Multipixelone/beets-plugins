import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, timelineMembership } from '../timeline.mjs';
import { aggregateTimeline, timelineCountScale, periodIndexForCutoff, cutoffForTimelineKey,
  nearestTimelineCutoff, OTHER_COMMUNITIES } from '../timeline-aggregation.mjs';
import { createTimelineGeometry } from '../timeline-geometry.mjs';
import { drawTimelineHistogram, timelineTicks, TIMELINE_PLOT_HEIGHT } from '../timeline-chart.mjs';

const at = date => Date.parse(`${date}T00:00:00Z`);
const album = date => ({ first_played: date });
const geometry = (model, viewportWidth) => createTimelineGeometry({ viewportWidth, thumbInset: 8,
  domainStartMs: model.bins[0].start, domainEndMs: model.bins.at(-1).end,
  bins: model.bins.map(bin => ({ startMs: bin.start, endMs: bin.end })) });

test('global top five use dated counts, deterministic ties and a stable order in every interval', () => {
  const names = ['g', 'g', 'f', 'e', 'd', 'c', 'b', 'a', 'a', ...Array(20).fill('undated')];
  const model = buildTimeline(names.map((_, index) => album(index < 9 ? index < 8 ? '2024-01-01' : '2024-01-03' : null)));
  const result = aggregateTimeline(model, names, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'undated']);
  assert.deepEqual(result.majorCommunities, [{ name: 'a', count: 2 }, { name: 'g', count: 2 },
    { name: 'b', count: 1 }, { name: 'c', count: 1 }, { name: 'd', count: 1 }]);
  assert.deepEqual(result.stacks[0].map(segment => segment.name), ['a', 'g', 'b', 'c', 'd', OTHER_COMMUNITIES]);
  assert.equal(result.otherCount, 2); assert.deepEqual(result.stacks[1], []);
  assert.deepEqual(result.stacks[2], [{ name: 'a', count: 1 }]);
  for (const [index, stack] of result.stacks.entries()) {
    assert.equal(stack.reduce((sum, segment) => sum + segment.count, 0), model.bins[index].count);
    assert.equal(result.breakdowns[index].reduce((sum, group) => sum + group.count, 0), model.bins[index].count);
  }
  assert.deepEqual(result.breakdowns[0].slice(0, 3).map(group => [group.name, group.count, group.percent]),
    [['g', 2, 25], ['a', 1, 12.5], ['b', 1, 12.5]], 'local top three differs from the global top five');
});
test('repartition changes composition while boundaries, total heights and scale stay fixed', () => {
  const model = buildTimeline(['2024-01-01', '2024-01-01', '2024-01-03'].map(album));
  const before = JSON.stringify(model.bins);
  const first = aggregateTimeline(model, ['a', 'b', 'c'], ['a', 'b', 'c']);
  const next = aggregateTimeline(model, ['c', 'c', 'a'], ['a', 'b', 'c']);
  assert.notDeepEqual(first.stacks, next.stacks); assert.deepEqual(first.scale, next.scale);
  assert.equal(JSON.stringify(model.bins), before);
});
test('finite and arbitrary cutoffs remain exclusive, including before-first and final-bin states', () => {
  const model = buildTimeline(['2024-01-01', '2024-01-31', '2024-04-01', null].map(album));
  assert.equal(model.unit, 'month');
  assert.equal(periodIndexForCutoff(model, null), 3);
  assert.equal(periodIndexForCutoff(model, at('2024-01-01')), -1);
  assert.equal(periodIndexForCutoff(model, at('2024-02-01')), 0);
  assert.equal(periodIndexForCutoff(model, at('2024-01-02')), 0);
  assert.equal(timelineMembership(model.dates, at('2024-01-02')).count, 1);
  assert.equal(timelineMembership(model.dates, model.bins.at(-1).end).count, 3);
  assert.equal(timelineMembership(model.dates, null).count, 4);
  assert.equal(cutoffForTimelineKey('Home', null, model), model.bins[0].start);
  assert.equal(cutoffForTimelineKey('End', null, model), model.bins.at(-1).end);
  assert.equal(cutoffForTimelineKey('ArrowLeft', null, model), model.bins.at(-1).end);
  assert.equal(cutoffForTimelineKey('ArrowRight', model.bins.at(-1).end, model), model.bins.at(-1).end);
  assert.equal(cutoffForTimelineKey('ArrowLeft', at('2024-01-15'), model), at('2024-01-01'));
  assert.equal(cutoffForTimelineKey('ArrowRight', at('2024-01-15'), model), at('2024-02-01'));
  assert.equal(cutoffForTimelineKey('Escape', at('2024-01-15'), model), null);
});
test('empty and all-undated models have safe count scales and no fictional communities', () => {
  for (const albums of [[], [album(null), album('invalid')]]) {
    const model = buildTimeline(albums), result = aggregateTimeline(model, albums.map(() => 'a'), ['a']);
    assert.deepEqual(result.majorCommunities, []); assert.deepEqual(result.stacks, []);
    assert.equal(result.peakIndex, -1); assert.equal(periodIndexForCutoff(model, null), -1);
    assert.equal(cutoffForTimelineKey('Home', null, model), undefined);
    assert.deepEqual(result.scale, { max: 3, ticks: [0, 1, 2, 3] });
  }
  const zero = { maxCount: 0, bins: [{ start: at('2024-01-01'), end: at('2024-02-01'), indices: [], count: 0 }] };
  const result = aggregateTimeline(zero, [], []);
  assert.deepEqual(result.stacks, [[]]); assert.deepEqual(result.breakdowns, [[]]); assert.equal(result.peakIndex, -1);
});
test('single-bin and extreme-spike stacks stay linear with no minimum segment height', () => {
  const model = buildTimeline(Array.from({ length: 1001 }, () => album('2024-02-29')));
  const names = [...Array(1000).fill('a'), 'b'], result = aggregateTimeline(model, names, ['a', 'b']);
  const rects = [], lines = [];
  const context = { scale() {}, beginPath() {}, moveTo(x) { lines.push(x); }, lineTo() {}, stroke() {}, setLineDash() {},
    fillRect(...rect) { rects.push(rect); }, strokeRect() {} };
  const canvas = { getContext: () => context };
  const g = geometry(model, 390);
  drawTimelineHistogram(canvas, { geometry: g, model, aggregation: result, colors: new Map([['a', 'red'], ['b', 'blue']]),
    cutoff: model.bins[0].end, ink: 'white', accent: 'orange', grid: 'gray' });
  assert.equal(canvas.height, TIMELINE_PLOT_HEIGHT); assert.equal(rects.length, 2);
  assert.equal(rects[0][3] / rects[1][3], 1000);
  assert.ok(rects[1][3] < 1, 'tiny communities retain their exact fractional height');
  assert.equal(lines.at(-1), g.xForTime(model.bins[0].end));
  for (const max of [0, 1, 2, 3, 7, 1001, 1000000]) {
    const scale = timelineCountScale(max); assert.ok(scale.max >= max);
    assert.equal(scale.ticks.length, 4); assert.equal(scale.ticks[0], 0);
    assert.ok(scale.ticks.every(Number.isInteger));
  }
});
test('resize changes presentation only and keeps meaningful UTC tick coordinates', () => {
  const model = buildTimeline(['2020-01-01', '2024-02-29', '2028-12-31'].map(album));
  const aggregate = aggregateTimeline(model, ['a', 'b', 'c'], ['a', 'b', 'c']);
  const before = JSON.stringify({ model, aggregate, membership: timelineMembership(model.dates, at('2024-03-01')) });
  for (const width of [1440, 390, 320]) {
    const g = geometry(model, width), ticks = timelineTicks(model, g, width);
    assert.ok(ticks.length > 2); assert.equal(ticks[0].time, model.bins[0].start);
    assert.equal(ticks.at(-1).time, model.bins.at(-1).end);
    for (const tick of ticks) assert.ok(model.bins.some(bin => bin.start === tick.time || bin.end === tick.time));
    for (const bin of model.bins) assert.equal(nearestTimelineCutoff(model, g, bin.end), bin.end);
  }
  assert.equal(JSON.stringify({ model, aggregate, membership: timelineMembership(model.dates, at('2024-03-01')) }), before);
});
