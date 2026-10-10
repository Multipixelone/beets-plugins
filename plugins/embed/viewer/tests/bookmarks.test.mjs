import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BOOKMARK_CATEGORIES, parseBookmarkDate, normalizeBookmarks, bookmarkLabel, bookmarkLayout,
  buildTimeline, timelinePositionForDate, timelineCutoff, timelineMembership } from '../timeline.mjs';
import { validateExport } from '../logic.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/timeline-bookmarks.json', import.meta.url)));
const library = JSON.parse(readFileSync(new URL('./fixtures/library-stats.json', import.meta.url)));
const event = { id: 'event', date: '2024-02-29', end_date: null, precision: 'day', title: 'Event', category: 'other' };

test('missing, empty, non-array and wholly malformed bookmarks leave the original timeline intact', () => {
  const original = buildTimeline(library.albums);
  for (const value of [undefined, null, [], {}, 'bookmarks', [null, {}]]) {
    assert.deepEqual(buildTimeline(library.albums, value), original);
    assert.equal(validateExport({ ...structuredClone(library), bookmarks: value }).albums.length, library.albums.length);
  }
});

test('bookmark dates are strict UTC calendar days, including leap years and early years', () => {
  for (const date of ['2024-02-29', '0099-01-01', '0000-02-29']) {
    assert.equal(parseBookmarkDate(date), Date.parse(`${date}T00:00:00Z`));
  }
  for (const date of [null, 2024, '', '2023-02-29', '2024-02-30', '2024-13-01',
    '2024-00-01', '2024-01-00', '2024-2-01', '2024-02-29T00:00:00Z', ' 2024-02-29']) {
    assert.ok(Number.isNaN(parseBookmarkDate(date)), String(date));
  }
});

test('malformed entries are ignored individually without trusting category keys or leaking extra fields', () => {
  const bad = [null, [], 'event', {}, ...[
    { id: '' }, { id: 1 }, { title: ' ' }, { title: {} }, { precision: 'decade' },
    { precision: null }, { category: '__proto__' }, { category: ['move'] },
    { category: 'toString' }, { date: '2023-02-29' }, { end_date: undefined },
    { end_date: 'bad' }, { end_date: '2024-02-28' }
  ].map(change => ({ ...event, ...change }))];
  assert.deepEqual(normalizeBookmarks(bad), []);
  const valid = { ...event, notes: 'Do not copy extra metadata' };
  const result = normalizeBookmarks([...bad, valid, { ...event, title: 'Duplicate' }]);
  assert.equal(result.length, 1); assert.equal(result[0].title, 'Event');
  assert.equal(Object.hasOwn(result[0], 'notes'), false);
  assert.equal(normalizeBookmarks([{ ...event, date: 'bad' }, event]).length, 1);
});

test('all supplied categories and precisions are accepted and labelled without fabricating uncertainty bounds', () => {
  for (const category of Object.keys(BOOKMARK_CATEGORIES)) {
    assert.equal(normalizeBookmarks([{ ...event, category }])[0].category, category);
  }
  for (const precision of ['day', 'month', 'season', 'year', 'approximate']) {
    const [bookmark] = normalizeBookmarks([{ ...event, precision }]);
    assert.equal(bookmark.end, null);
    assert.equal(bookmarkLabel(bookmark).includes('approximate'), precision !== 'day');
    assert.ok(bookmarkLabel(bookmark).includes('2024-02-29 UTC'));
  }
});

test('events extend the domain while only album additions determine counts and snapshot membership', () => {
  const model = buildTimeline(library.albums, fixture.bookmarks);
  assert.equal(model.bookmarks.length, 11);
  assert.equal(model.bins[0].start, Date.parse('2023-09-01T00:00:00Z'));
  assert.ok(model.bins.at(-1).end > Date.parse('2027-01-01T00:00:00Z'));
  assert.equal(model.bins.reduce((sum, bin) => sum + bin.count, 0), library.albums.filter(a => a.added).length);
  const beforeLibrary = timelinePositionForDate(model, model.bookmarks[0].start);
  assert.equal(timelineMembership(model.dates, timelineCutoff(model, beforeLibrary)).count, 0);
  const imported = model.bookmarks.find(b => b.id === 'beets-library-import');
  assert.equal(timelineMembership(model.dates, timelineCutoff(model, timelinePositionForDate(model, imported.start))).count, 1);
  assert.equal(timelineMembership(model.dates).count, library.albums.length);
});

test('ranges include their final UTC day, including a same-day range and a leap-day endpoint', () => {
  const model = buildTimeline([], [{ ...event, date: '2024-02-28', end_date: '2024-02-29' }]);
  assert.equal(model.bins.length, 2); assert.equal(model.maxCount, 0); assert.equal(model.first, null);
  const { markers } = bookmarkLayout(model, 300);
  assert.equal(markers[0].rangeWidth, 200);
  assert.ok(bookmarkLabel(model.bookmarks[0]).includes('2024-02-28–2024-02-29'));
  const single = buildTimeline([{ added: null }], [{ ...event, end_date: event.date }]);
  assert.equal(single.bins.length, 1); assert.equal(bookmarkLayout(single, 300).markers[0].rangeWidth, 150);
  assert.equal(timelineMembership(single.dates, timelineCutoff(single, 0)).count, 0);
  assert.deepEqual(bookmarkLayout(single, 0), { markers: [], height: 0 });
});

test('overlapping events are staggered with reachable hit areas at desktop and mobile widths', () => {
  const model = buildTimeline(library.albums, fixture.bookmarks);
  for (const width of [1440, 390, 320]) {
    const { markers, height } = bookmarkLayout(model, width);
    assert.equal(markers.length, 11); assert.equal(height % 44, 0);
    assert.ok(markers.every(m => m.left >= 0 && m.left + 44 <= width && m.position >= 0));
    for (const [index, marker] of markers.entries()) {
      const right = Math.max(marker.left + 44, marker.rangeLeft + (marker.bookmark.end === null ? 0 : marker.rangeWidth));
      for (const other of markers.slice(index + 1).filter(m => m.lane === marker.lane)) {
        assert.ok(Math.min(other.left, other.rangeLeft) >= right + 4);
      }
    }
    const imported = markers.find(m => m.bookmark.id === 'beets-library-import');
    assert.notEqual(imported.lane, markers.find(m => m.bookmark.id === 'music').lane);
  }
});

test('titles remain literal text through normalization and accessible label formatting', () => {
  const malicious = fixture.bookmarks.find(b => b.id === 'escaped');
  const [bookmark] = normalizeBookmarks([malicious]);
  assert.equal(bookmark.title, malicious.title);
  assert.ok(bookmarkLabel(bookmark).startsWith(`${malicious.title} · `));
  assert.equal(globalThis.bookmarkInjected, undefined);
});
