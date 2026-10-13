import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, timelineMembership } from '../timeline.mjs';
import { rebinTimeline, timelineExplorerRange } from '../timeline-explorer.mjs';

const at = value => Date.parse(`${value}T00:00:00Z`);
const modelFor = dates => buildTimeline(dates.map(first_played => ({ first_played })));

test('daily and monthly zoom preserve leap days, empty periods and half-open boundaries', () => {
  const model = modelFor(['2024-01-01', '2024-02-28', '2024-02-29', '2024-03-01', '2024-04-01']);
  const daily = rebinTimeline(model, { unit: 'day', startMs: at('2024-02-27'), endMs: at('2024-03-02') });
  assert.deepEqual(daily.bins.map(bin => [bin.start, bin.end, bin.count]), [
    [at('2024-02-27'), at('2024-02-28'), 0], [at('2024-02-28'), at('2024-02-29'), 1],
    [at('2024-02-29'), at('2024-03-01'), 1], [at('2024-03-01'), at('2024-03-02'), 1]
  ]);
  const monthly = rebinTimeline(model, { unit: 'month', startMs: at('2024-02-28'), endMs: at('2024-03-01') });
  assert.deepEqual(monthly.bins.map(bin => [bin.start, bin.end, bin.count]), [[at('2024-02-01'), at('2024-03-01'), 2]]);
  assert.equal(monthly.bins[0].end - monthly.bins[0].start, 29 * 86400000);
});

test('weeks start on Monday across year changes and remain uniform across DST', () => {
  const model = modelFor(['2023-12-31', '2024-01-01', '2024-03-09', '2024-03-10', '2024-03-11']);
  const weekly = rebinTimeline(model, { unit: 'week' });
  assert.equal(weekly.bins[0].start, at('2023-12-25'));
  assert.equal(weekly.bins[1].start, at('2024-01-01'));
  assert.equal(weekly.bins[0].count, 1); assert.equal(weekly.bins[1].count, 1);
  assert.ok(weekly.bins.every(bin => new Date(bin.start).getUTCDay() === 1 && bin.end - bin.start === 7 * 86400000));
  assert.equal(weekly.bins.find(bin => bin.start === at('2024-03-04')).count, 2);
  assert.equal(weekly.bins.find(bin => bin.start === at('2024-03-11')).count, 1);
});

test('every interval conserves dated albums without mutating the source model', () => {
  const model = modelFor(['2020-12-31', '2021-01-01', '2021-01-01', '2024-02-29', '2026-10-09', null]);
  const before = structuredClone(model);
  for (const unit of ['auto', 'day', 'week', 'month', 'year']) {
    const result = rebinTimeline(model, { unit });
    assert.equal(result.bins.reduce((sum, bin) => sum + bin.count, 0), 5);
    assert.deepEqual(result.bins.flatMap(bin => bin.indices).sort((a, b) => a - b), [0, 1, 2, 3, 4]);
    assert.equal(result.albumBins[5], -1);
    for (const [index, bin] of result.bins.entries()) {
      assert.equal(bin.count, bin.indices.length);
      assert.ok(bin.indices.every(album => result.albumBins[album] === index));
      assert.equal(bin.cumulative, timelineMembership(model.dates, bin.end).count);
    }
    assert.equal(result.total, 6); assert.equal(result.undated, 1);
    assert.strictEqual(result.dates, model.dates); assert.strictEqual(result.bookmarks, model.bookmarks);
  }
  assert.deepEqual(model, before);
});

test('viewport counts are local while cumulative snapshots retain all earlier albums', () => {
  const model = modelFor(['2024-01-01', '2024-01-02', '2024-02-15', '2024-03-01', '2024-04-01', null]);
  const result = rebinTimeline(model, { unit: 'month', startMs: at('2024-02-05'), endMs: at('2024-04-01') });
  assert.deepEqual(result.bins.map(bin => bin.count), [1, 1]);
  assert.deepEqual(result.bins.map(bin => bin.cumulative), [3, 4]);
  assert.deepEqual([...result.albumBins], [-1, -1, 0, 1, -1, -1]);
  assert.equal(result.maxCount, 1);
});

test('automatic intervals respond to viewport duration instead of the entire export', () => {
  const model = modelFor(['2000-01-01', '2040-12-31']);
  for (const [end, expected] of [['2024-02-29', 'day'], ['2024-03-01', 'day'], ['2024-03-02', 'week'],
    ['2025-01-01', 'week'], ['2025-01-02', 'month'], ['2034-01-01', 'month'], ['2034-01-02', 'year']]) {
    const result = rebinTimeline(model, { startMs: at('2024-01-01'), endMs: at(end) });
    assert.equal(result.unit, expected, end); assert.equal(result.step, 1);
  }
});

test('requested ranges clamp to the full model and exact upper boundaries remain exclusive', () => {
  const model = modelFor(['2024-02-01', '2024-02-29']);
  const entire = rebinTimeline(model, { unit: 'day' });
  assert.deepEqual(rebinTimeline(model, { unit: 'day', startMs: at('1900-01-01'), endMs: at('2100-01-01') }), entire);
  assert.deepEqual(rebinTimeline(model, { unit: 'day', startMs: at('2100-01-01'), endMs: at('1900-01-01') }), entire);
  const end = rebinTimeline(model, { unit: 'day', startMs: at('2100-01-01'), endMs: at('2100-01-02') });
  assert.deepEqual(timelineExplorerRange(end), { startMs: at('2024-02-29'), endMs: at('2024-03-01') });
  assert.equal(end.bins[0].count, 1); assert.equal(end.bins[0].cumulative, 2);
  const point = rebinTimeline(model, { unit: 'day', startMs: at('2024-02-10'), endMs: at('2024-02-10') });
  assert.equal(point.bins.length, 1); assert.equal(point.bins[0].start, at('2024-02-10'));
  assert.deepEqual(rebinTimeline(model, { unit: 'day', startMs: NaN, endMs: Infinity }), entire);
});

test('event-only dates extend the explorer range and empty exports remain empty', () => {
  const bookmarks = [{ id: 'event', date: '2020-01-01', end_date: '2026-12-31', title: 'An era', category: 'other', precision: 'year' }];
  const model = buildTimeline([{ first_played: '2024-02-29' }], bookmarks);
  assert.deepEqual(timelineExplorerRange(model), { startMs: at('2020-01-01'), endMs: at('2027-01-01') });
  const result = rebinTimeline(model, { unit: 'year' });
  assert.equal(result.bins.length, 7);
  assert.deepEqual(result.bins.map(bin => bin.count), [0, 0, 0, 0, 1, 0, 0]);
  const onlyBookmarks = rebinTimeline(buildTimeline([], bookmarks), { unit: 'year' });
  assert.equal(onlyBookmarks.bins.length, 7); assert.ok(onlyBookmarks.bins.every(bin => bin.count === 0));
  for (const dates of [[], [null, 'invalid']]) {
    const empty = rebinTimeline(modelFor(dates));
    assert.equal(timelineExplorerRange(empty), null); assert.deepEqual(empty.bins, []);
    assert.equal(empty.maxCount, 0); assert.equal(empty.undated, dates.length);
  }
});

test('calendar boundaries preserve early years without Date constructor century coercion', () => {
  const result = rebinTimeline(modelFor(['0099-12-31', '0100-01-01']), { unit: 'year' });
  assert.deepEqual(result.bins.map(bin => [bin.start, bin.end, bin.count]), [
    [at('0099-01-01'), at('0100-01-01'), 1], [at('0100-01-01'), at('0101-01-01'), 1]
  ]);
  assert.throws(() => rebinTimeline(modelFor(['2024-01-01']), { unit: 'century' }), RangeError);
});
