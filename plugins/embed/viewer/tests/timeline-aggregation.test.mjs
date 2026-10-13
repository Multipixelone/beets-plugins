import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, timelineMembership } from '../timeline.mjs';
import { aggregateTimeline, timelineCountScale, periodIndexForCutoff, cutoffForTimelineKey,
  nearestTimelineCutoff } from '../timeline-aggregation.mjs';
import { createTimelineGeometry } from '../timeline-geometry.mjs';
import { TimelineChart,
  timelineChartData, timelineRangePercent, timelineRangeFromPercent } from '../timeline-chart.mjs';

const at = date => Date.parse(`${date}T00:00:00Z`);
const album = date => ({ first_played: date });
const geometry = (model, viewportWidth) => createTimelineGeometry({ viewportWidth, thumbInset: 8,
  domainStartMs: model.bins[0].start, domainEndMs: model.bins.at(-1).end,
  bins: model.bins.map(bin => ({ startMs: bin.start, endMs: bin.end })) });

test('all dated communities retain their identities with deterministic ties and a compact top-five legend', () => {
  const names = ['g', 'g', 'f', 'e', 'd', 'c', 'b', 'a', 'a', ...Array(20).fill('undated')];
  const model = buildTimeline(names.map((_, index) => album(index < 9 ? index < 8 ? '2024-01-01' : '2024-01-03' : null)));
  const result = aggregateTimeline(model, names, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'undated']);
  assert.deepEqual(result.majorCommunities, [{ name: 'a', count: 2 }, { name: 'g', count: 2 },
    { name: 'b', count: 1 }, { name: 'c', count: 1 }, { name: 'd', count: 1 }]);
  assert.deepEqual(result.communities, [...result.majorCommunities, { name: 'e', count: 1 }, { name: 'f', count: 1 }]);
  assert.deepEqual(result.stacks[0].map(segment => segment.name), ['a', 'g', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(result.stacks[0].slice(-2), [{ name: 'e', count: 1 }, { name: 'f', count: 1 }],
    'rare communities remain separate, rather than becoming a combined remainder');
  assert.deepEqual(result.stacks[1], []);
  assert.deepEqual(result.stacks[2], [{ name: 'a', count: 1 }]);
  for (const [index, stack] of result.stacks.entries()) {
    assert.equal(stack.reduce((sum, segment) => sum + segment.count, 0), model.bins[index].count);
    assert.equal(result.breakdowns[index].reduce((sum, group) => sum + group.count, 0), model.bins[index].count);
  }
  assert.deepEqual(result.breakdowns[0].slice(0, 3).map(group => [group.name, group.count, group.percent]),
    [['g', 2, 25], ['a', 1, 12.5], ['b', 1, 12.5]], 'local top three differs from the global top five');
});
test('all stacks follow global community order even when local leaders and album order differ', () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'f', 'f', 'e', 'd', 'c', 'b', 'a', 'a'];
  const model = buildTimeline(names.map((_, index) => album(index < 7 ? '2024-01-01' : '2024-01-03')));
  const result = aggregateTimeline(model, names, ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(result.breakdowns[0][0].name, 'f');
  assert.equal(result.breakdowns[2][0].name, 'a');
  assert.deepEqual(result.stacks[0].map(segment => segment.name), ['a', 'f', 'b', 'c', 'd', 'e']);
  assert.deepEqual(result.stacks[2].map(segment => segment.name), ['a', 'f', 'b', 'c', 'd', 'e']);
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
    assert.deepEqual(result.communities, []); assert.deepEqual(result.majorCommunities, []); assert.deepEqual(result.stacks, []);
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
  const prepared = timelineChartData(model, result);
  const series = TimelineChart.prototype.bars.call({ prepared, colors: new Map([['a', 'red'], ['b', 'blue']]) });
  const row = prepared.rows[0], rendered = series.renderItem({ coordSys: { x: 0, y: 0, width: 390, height: 120 } }, {
    value: dimension => series.data[0][dimension],
    coord: ([time, count]) => [(time - row.start) / (row.end - row.start) * 390, 120 - count / prepared.scale.max * 120] });
  const rects = rendered.children.slice(1);
  assert.equal(rects.length, 2);
  assert.ok(Math.abs(rects[0].shape.height / rects[1].shape.height - 1000) < 1e-7);
  assert.ok(rects[1].shape.height < 1, 'tiny communities retain their exact fractional height');
  for (const max of [0, 1, 2, 3, 7, 1001, 1000000]) {
    const scale = timelineCountScale(max); assert.ok(scale.max >= max);
    assert.equal(scale.ticks.length, 4); assert.equal(scale.ticks[0], 0);
    assert.ok(scale.ticks.every(Number.isInteger));
  }
});
test('resize keeps UTC boundaries, data counts and snapshot membership fixed', () => {
  const model = buildTimeline(['2020-01-01', '2024-02-29', '2028-12-31'].map(album));
  const aggregate = aggregateTimeline(model, ['a', 'b', 'c'], ['a', 'b', 'c']);
  const before = JSON.stringify({ model, aggregate, membership: timelineMembership(model.dates, at('2024-03-01')) });
  for (const width of [1440, 390, 320]) {
    const g = geometry(model, width);
    for (const bin of model.bins) assert.equal(nearestTimelineCutoff(model, g, bin.end), bin.end);
  }
  assert.equal(JSON.stringify({ model, aggregate, membership: timelineMembership(model.dates, at('2024-03-01')) }), before);
});

test('chart filtering compacts stacks and percentages use only visible groups', () => {
  const model = buildTimeline(['2024-01-01', '2024-01-01', '2024-01-01', '2024-01-01', '2024-01-03'].map(album));
  const aggregate = aggregateTimeline(model, ['a', 'b', 'b', 'c', 'c'], ['a', 'b', 'c']);
  const original = JSON.stringify(aggregate), hidden = new Set(['b']);
  const counts = timelineChartData(model, aggregate, hidden), shares = timelineChartData(model, aggregate, hidden, 'percent');
  assert.deepEqual(counts.rows[0].segments, [{ name: 'c', count: 1, bottom: 0, top: 1 }, { name: 'a', count: 1, bottom: 1, top: 2 }]);
  assert.equal(counts.rows[0].total, 2);
  assert.deepEqual(shares.rows[0].segments.map(segment => [segment.bottom, segment.top]), [[0, 50], [50, 100]]);
  assert.deepEqual(shares.rows[1].segments, []);
  assert.equal(shares.rows[2].segments[0].top, 100);
  assert.equal(shares.scale.max, 100);
  const empty = timelineChartData(model, aggregate, new Set(['a', 'b', 'c']));
  assert.ok(empty.rows.every(row => row.total === 0 && row.segments.length === 0));
  assert.ok(empty.scale.max > 0);
  assert.equal(JSON.stringify(aggregate), original, 'legend visibility cannot mutate source counts');
});

test('zoom range percentages preserve UTC timestamps and clamp to the complete history', () => {
  const domain = { startMs: at('2024-01-01'), endMs: at('2025-01-01') };
  const range = { startMs: at('2024-02-01'), endMs: at('2024-03-01') };
  assert.deepEqual(timelineRangeFromPercent(domain, timelineRangePercent(domain, range)), range);
  assert.deepEqual(timelineRangeFromPercent(domain, { start: -10, end: 110 }), domain);
  assert.deepEqual(timelineRangePercent(domain, { startMs: at('2023-01-01'), endMs: at('2026-01-01') }), { start: 0, end: 100 });
});

test('custom chart uses true calendar interval widths and clips a partly visible month', () => {
  const model = { bins: [{ start: at('2024-01-01'), end: at('2024-02-01') },
    { start: at('2024-02-01'), end: at('2024-03-01') }] };
  const prepared = timelineChartData(model, { stacks: [[{ name: 'a', count: 1 }], [{ name: 'a', count: 1 }]] });
  const series = TimelineChart.prototype.bars.call({ prepared, colors: new Map([['a', 'red']]) });
  const render = (index, bounds) => series.renderItem({ coordSys: bounds }, {
    value: dimension => series.data[index][dimension],
    coord: ([time, count]) => [(time - at('2024-01-01')) / 86400000, 120 - count / prepared.scale.max * 120] });
  const january = render(0, { x: 0, y: 0, width: 60, height: 120 });
  const february = render(1, { x: 0, y: 0, width: 60, height: 120 });
  assert.equal(january.children[1].shape.width, 29, '31 calendar days minus the two one-pixel gaps');
  assert.equal(february.children[1].shape.width, 27, '29 leap-year calendar days minus the same gaps');
  const clipped = render(1, { x: 40, y: 0, width: 15, height: 120 });
  assert.deepEqual(clipped.children[1].shape, { x: 40, y: 80, width: 15, height: 40 });
  assert.equal(clipped.children[1].style.fill, 'red');
});

test('mobile chart tooltip bounds long group labels and summarizes the remaining groups', () => {
  const row = { start: at('2024-01-01'), end: at('2025-01-01'), total: 8,
    segments: Array.from({ length: 8 }, (_, index) => ({ name: `group${index}`, count: 1 })) };
  const names = new Map(row.segments.map(group => [group.name, 'A long community name that must fit inside a narrow chart']));
  const text = TimelineChart.prototype.tooltip.call({ prepared: { rows: [row] }, element: { clientWidth: 280 }, names }, { value: [0, 0, 0, 0] });
  assert.ok(text.includes('5 more groups · 5 albums'));
  assert.equal(text.split('\n').filter(line => line.includes('12.5%')).length, 3);
  assert.ok(text.split('\n').every(line => line.length <= Math.floor((280 - 40) / 6.7)));
});
