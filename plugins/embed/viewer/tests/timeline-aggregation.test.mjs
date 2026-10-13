import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, timelineMembership } from '../timeline.mjs';
import { aggregateTimeline, timelineCountScale, periodIndexForCutoff, cutoffForTimelineKey,
  nearestTimelineCutoff, timelineTasteShifts, selectTasteShifts, tasteShiftExamples } from '../timeline-aggregation.mjs';
import { createTimelineGeometry } from '../timeline-geometry.mjs';
import { TimelineChart,
  timelineChartData, timelineRangePercent, timelineRangeFromPercent } from '../timeline-chart.mjs';

const at = date => Date.parse(`${date}T00:00:00Z`);
const album = date => ({ first_played: date });
function tasteFixture(months) {
  const albums = [], names = [];
  months.forEach((groups, month) => {
    for (const [name, count] of Object.entries(groups)) for (let i = 0; i < count; i++) {
      albums.push({ first_played: `2024-${String(month + 1).padStart(2, '0')}-15`, albumartist: `Artist ${i % 3}` });
      names.push(name);
    }
  });
  return { albums, names, model: buildTimeline(albums) };
}

test('taste shifts compare shares with the previous three months, not raw growth', () => {
  const { model, names } = tasteFixture([{ jazz: 5, rock: 15 }, { jazz: 5, rock: 15 }, { jazz: 5, rock: 15 },
    { jazz: 25, rock: 75 }, { jazz: 12, rock: 8 }]);
  const shifts = timelineTasteShifts(model, names, { through: at('2024-06-01') });
  assert.equal(shifts.length, 1, 'five times as many arrivals with an unchanged mix is not a taste shift');
  const shift = shifts[0];
  assert.equal(shift.name, 'jazz'); assert.equal(shift.start, at('2024-05-01'));
  assert.equal(shift.count, 12); assert.equal(shift.total, 20);
  assert.equal(shift.previousCount, 35); assert.equal(shift.previousTotal, 140);
  assert.equal(shift.share, .6); assert.equal(shift.previousShare, .25);
  assert.equal(shift.firstAppearance, false);
});

test('a return after an absence is distinguished from a first recorded group', () => {
  const { model, names } = tasteFixture([{ jazz: 5, rock: 15 }, { rock: 20 }, { rock: 20 }, { rock: 20 },
    { jazz: 10, soul: 10 }]);
  const shifts = timelineTasteShifts(model, names, { through: at('2024-06-01') });
  assert.equal(shifts.find(shift => shift.name === 'jazz').firstAppearance, false);
  assert.equal(shifts.find(shift => shift.name === 'soul').firstAppearance, true);
  assert.ok(shifts.filter(shift => shift.start === at('2024-05-01')).every(shift => shift.previousShare === 0));
});

test('an exact five percentage point increase is included despite floating point rounding', () => {
  const { model, names } = tasteFixture([{ jazz: 5, rock: 15 }, { jazz: 5, rock: 15 }, { jazz: 5, rock: 15 },
    { jazz: 6, rock: 14 }]);
  assert.equal(timelineTasteShifts(model, names, { through: at('2024-05-01') })[0].name, 'jazz');
});

test('incomplete months, sparse samples, unknown groups and undated records cannot create highlights', () => {
  for (const last of [{ jazz: 4, rock: 16 }, { jazz: 5, rock: 4 }, { Unknown: 20 }, { 'Unknown genre': 20 }]) {
    const { model, names } = tasteFixture([{ rock: 20 }, { rock: 20 }, { rock: 20 }, last]);
    assert.deepEqual(timelineTasteShifts(model, names, { through: at('2024-05-01') }), []);
  }
  const { albums, names } = tasteFixture([{ rock: 20 }, { rock: 20 }, { rock: 20 }, { jazz: 20 }]);
  albums.push({ first_played: 'invalid' }); names.push('jazz');
  const model = buildTimeline(albums);
  assert.deepEqual(timelineTasteShifts(model, names, { through: at('2024-04-30') }), []);
  assert.deepEqual(timelineTasteShifts(model, names), [], 'without an export date the latest observed month is conservatively incomplete');
  assert.equal(timelineTasteShifts(model, names, { through: at('2024-05-01') })[0].count, 20);
  const sparse = tasteFixture([{ rock: 3 }, { rock: 3 }, { rock: 3 }, { jazz: 20 }]);
  assert.deepEqual(timelineTasteShifts(sparse.model, sparse.names, { through: at('2024-05-01') }), []);
  assert.deepEqual(timelineTasteShifts(buildTimeline([album(null)]), ['jazz']), []);
});

test('unknown metadata stays in share denominators and hidden groups never change the evidence', () => {
  const { model, names } = tasteFixture([{ rock: 20 }, { rock: 20 }, { rock: 20 }, { jazz: 5, Unknown: 15 }]);
  const candidates = timelineTasteShifts(model, names, { through: at('2024-05-01') });
  const before = JSON.stringify(candidates), range = { startMs: at('2024-04-01'), endMs: at('2024-05-01') };
  assert.equal(candidates[0].share, .25);
  assert.deepEqual(selectTasteShifts(candidates, range, new Set(['jazz'])), []);
  assert.equal(selectTasteShifts(candidates, range, new Set(['Unknown']))[0].share, .25);
  assert.equal(JSON.stringify(candidates), before);
  assert.deepEqual(selectTasteShifts(candidates, { startMs: at('2024-05-01'), endMs: at('2024-06-01') }), []);
});

test('highlight selection avoids duplicate groups and months; examples use distinct artists in date order', () => {
  const candidates = [
    { name: 'jazz', start: 4, end: 5 }, { name: 'jazz', start: 5, end: 6 },
    { name: 'rock', start: 4, end: 5 }, { name: 'soul', start: 2, end: 3 }, { name: 'folk', start: 7, end: 8 }
  ];
  assert.deepEqual(selectTasteShifts(candidates, { startMs: 0, endMs: 10 }).map(x => x.name), ['soul', 'jazz', 'folk']);
  const albums = [{ albumartist: 'a' }, { albumartist: 'a' }, { albumartist: 'b' }, { albumartist: 'c' }];
  assert.deepEqual(tasteShiftExamples({ indices: [0, 1, 2, 3] }, albums, [3, 1, 4, 5]), [1, 2, 3]);
});
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
