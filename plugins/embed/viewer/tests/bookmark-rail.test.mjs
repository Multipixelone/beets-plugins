import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeBookmarks } from '../timeline.mjs';
import { createTimelineGeometry } from '../timeline-geometry.mjs';
import { createBookmarkRail } from '../timeline-bookmarks.mjs';
import { BOOKMARK_DAY, bookmarkCutoff, bookmarkDetails, bookmarkRailLayout, bookmarkTooltipPlacement } from '../timeline-bookmark-layout.mjs';
import { bookmarkDocument, descendants, withClass } from './bookmark-dom.mjs';

const at = date => Date.parse(`${date}T00:00:00Z`);
const event = (id, date = '2024-02-29', extra = {}) => normalizeBookmarks([
  { id, date, end_date: null, precision: 'day', title: `Event ${id}`, category: 'other', ...extra }
])[0];
const events = (...dates) => dates.map((date, i) => event(String(i), date));
const boundaries = ['2024-01-01', '2024-02-01', '2024-03-01', '2024-04-01'].map(at);
const geometry = width => createTimelineGeometry({ domainStartMs: boundaries[0], domainEndMs: boundaries.at(-1),
  viewportWidth: width, bins: boundaries.slice(0, -1).map((startMs, i) => ({ startMs, endMs: boundaries[i + 1] })),
  plotPadding: { left: 0, right: 0 }, thumbInset: 0 });
// Faithful linear geometry double exercises unusual inset/scroll configurations too.
const double = (width, left = 0, right = width) => ({ domain: { startMs: boundaries[0], endMs: boundaries.at(-1) },
  contentWidth: width, plot: { left, right, width: right - left },
  xForTime: ms => left + (Math.max(boundaries[0], Math.min(boundaries.at(-1), ms)) - boundaries[0]) /
    (boundaries.at(-1) - boundaries[0]) * (right - left),
  timeForX: x => boundaries[0] + (Math.max(left, Math.min(right, x)) - left) / (right - left) * (boundaries.at(-1) - boundaries[0]),
  binIndexForX(x) { return x >= right ? 2 : boundaries.slice(0, -1).findIndex((start, i) =>
    Math.max(x, left) >= this.xForTime(start) && x < this.xForTime(boundaries[i + 1])); },
  clientToContentX: (x, rect, scroll) => x - rect.left + scroll,
  contentToClientX: (x, rect, scroll) => rect.left + x - scroll });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1, `${actual} differs from ${expected}`);

function mount(bookmarks, options = {}) {
  const f = bookmarkDocument(), selections = [], guides = [];
  const rail = createBookmarkRail({ container: f.container, tooltipLayer: f.overlays,
    geometry: geometry(390), bookmarks, selectedCutoff: null,
    onSelect: cutoff => selections.push(cutoff), onGuide: time => guides.push(time), ...options });
  return { ...f, rail, selections, guides,
    pins: () => withClass(f.container, 'ag-bookmark-target'),
    list: () => withClass(f.overlays, 'ag-bookmark-list')[0],
    entries: () => withClass(f.overlays, 'ag-bookmark-entry'),
    tooltip: () => withClass(f.overlays, 'ag-bookmark-tooltip')[0] };
}

test('real geometry and the geometry double fix every supplied anchor across resize and scroll', () => {
  const bookmarks = events('2024-01-01', '2024-01-31', '2024-02-01', '2024-02-29', '2024-03-01', '2024-03-31');
  for (const factory of [geometry, width => double(width, 9, width - 7)]) {
    for (const width of [320, 390, 1440]) {
      const g = factory(width), layout = bookmarkRailLayout(g, bookmarks);
      for (const item of layout.items) for (const anchor of item.anchors) {
        near(anchor.x, g.xForTime(anchor.bookmark.start));
        for (const scroll of [0, 80, 200]) {
          const stage = { left: 73.5 }, client = g.contentToClientX(anchor.x, stage, scroll);
          near(client, 73.5 + g.xForTime(anchor.bookmark.start) - scroll);
          near(g.clientToContentX(client, stage, scroll), anchor.x);
        }
      }
    }
  }
});

test('first and last days clamp badges, not anchors, and render elbow leaders', () => {
  const bookmarks = events('2024-01-01', '2024-03-31'), f = mount(bookmarks);
  for (const width of [320, 1440]) {
    const g = geometry(width); f.rail.update({ geometry: g });
    const dots = withClass(f.container, 'ag-bookmark-anchor');
    for (const bookmark of bookmarks) near(Number(dots.find(dot => dot.getAttribute('data-bookmark-id') === bookmark.id).getAttribute('cx')), g.xForTime(bookmark.start));
    const leaders = withClass(f.container, 'ag-bookmark-leader');
    assert.ok(leaders.every(leader => leader.getAttribute('data-elbow') === 'true'));
    assert.ok(leaders.every(leader => /H/.test(leader.getAttribute('d'))));
  }
  f.rail.destroy();
});

test('two lanes are deterministic, targets never overlap, and separated dates stay distinct', () => {
  const bookmarks = events('2024-01-01', '2024-01-20', '2024-02-10', '2024-02-29', '2024-03-20');
  for (const width of [320, 390, 1440]) {
    const g = geometry(width), layout = bookmarkRailLayout(g, bookmarks);
    assert.deepEqual(bookmarkRailLayout(g, [...bookmarks].reverse()), layout);
    assert.ok(layout.height <= 88);
    assert.equal(layout.items.flatMap(item => item.events).length, bookmarks.length);
    for (const item of layout.items) {
      assert.ok(item.lane === 0 || item.lane === 1);
      assert.ok(item.left >= 0 && item.left + 44 <= g.contentWidth);
      for (const other of layout.items.filter(other => other !== item && other.lane === item.lane)) {
        assert.ok(item.left + 48 <= other.left || other.left + 48 <= item.left);
      }
    }
  }
  const distinct = bookmarkRailLayout(geometry(1440), events('2024-02-01', '2024-02-29'));
  assert.equal(distinct.items.length, 2); assert.notEqual(distinct.items[0].firstX, distinct.items[1].firstX);
  const pair = bookmarkRailLayout(geometry(390), [event('z'), event('a')]);
  assert.deepEqual(pair.items.map(item => item.events[0].id), ['a', 'z']);
  assert.deepEqual(pair.items.map(item => item.lane), [0, 1]);
});

test('collision displacement moves only badges and gives the shifted badge an elbow', () => {
  const bookmarks = events('2024-01-15', '2024-01-18', '2024-01-23'), g = geometry(390);
  const layout = bookmarkRailLayout(g, bookmarks);
  assert.equal(layout.items.length, 3);
  const shifted = layout.items.find(item => item.distance > 0);
  assert.ok(shifted && shifted.distance <= 22);
  assert.equal(shifted.anchors[0].x, g.xForTime(shifted.events[0].start));
  assert.notEqual(shifted.left + 22, shifted.anchors[0].x);
  const f = mount(bookmarks);
  assert.ok(withClass(f.container, 'ag-bookmark-leader').some(leader => leader.getAttribute('data-elbow') === 'true'));
  f.rail.destroy();
});

test('dense local clusters have chronological accessible lists and separate clusters stay local', () => {
  const bookmarks = [...Array.from({ length: 10 }, (_, i) => event(`a${i}`, '2024-01-10')),
    ...Array.from({ length: 10 }, (_, i) => event(`z${i}`, '2024-03-20'))];
  const f = mount([...bookmarks].reverse());
  assert.equal(f.pins().length, 2);
  for (const pin of f.pins()) {
    assert.equal(pin.textContent, '10'); assert.equal(pin.getAttribute('aria-haspopup'), 'dialog');
    pin.emit('click'); assert.equal(f.entries().length, 10);
    assert.equal(pin.getAttribute('aria-expanded'), 'true');
    assert.equal(f.document.activeElement, f.entries()[0]);
    assert.ok(f.entries().every(entry => entry.tagName === 'button' && entry.type === 'button'));
    assert.deepEqual(f.entries().map(entry => entry.getAttribute('data-bookmark-id')),
      [...f.entries().map(entry => entry.getAttribute('data-bookmark-id'))].sort());
    f.entries()[0].emit('keydown', { key: 'Escape' });
  }
  f.rail.destroy();
});

test('different-date clusters show true endpoint brackets; same-date clusters share one dot', () => {
  const spread = events('2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01', '2024-03-02');
  const f = mount(spread);
  const bracket = withClass(f.container, 'ag-bookmark-bracket')[0];
  assert.ok(bracket);
  const layout = bookmarkRailLayout(geometry(390), spread), cluster = layout.items.find(item => item.clustered);
  assert.ok(bracket.getAttribute('d').includes(`M${geometry(390).xForTime(cluster.events[0].start)} `));
  assert.ok(bracket.getAttribute('d').includes(`H${geometry(390).xForTime(cluster.events.at(-1).start)}`));
  f.rail.destroy();
  const same = mount(Array.from({ length: 30 }, (_, i) => event(String(i))));
  assert.equal(withClass(same.container, 'ag-bookmark-bracket').length, 0);
  assert.equal(withClass(same.container, 'ag-bookmark-anchor').length, 1);
  assert.equal(same.pins()[0].textContent, '30'); same.rail.destroy();
});

test('exact dates, every approximate precision and ranges keep supplied dates honest', () => {
  for (const precision of ['day', 'month', 'season', 'year', 'approximate']) {
    const bookmark = event(precision, '2024-02-29', { precision }), f = mount([bookmark]);
    const dot = withClass(f.container, 'ag-bookmark-anchor')[0], leader = withClass(f.container, 'ag-bookmark-leader')[0];
    assert.equal(dot.getAttribute('class').includes('ag-bookmark-approximate'), precision !== 'day');
    assert.equal(leader.getAttribute('class').includes('ag-bookmark-approximate'), precision !== 'day');
    assert.equal(withClass(f.container, 'ag-bookmark-span').length, 0);
    f.pins()[0].focus();
    assert.ok(f.tooltip().textContent.includes(precision === 'day' ? 'Exact day' : `${precision} precision (approximate)`));
    assert.ok(f.tooltip().textContent.includes('2024-02-29 UTC')); f.rail.destroy();
  }
  for (const end_date of ['2024-02-28', '2024-02-29', '2024-03-31']) {
    const bookmark = event('range', '2024-02-28', { end_date }), f = mount([bookmark]);
    const span = withClass(f.container, 'ag-bookmark-span')[0], g = geometry(390);
    assert.ok(span.getAttribute('d').includes(`M${g.xForTime(bookmark.start)} `));
    assert.ok(span.getAttribute('d').includes(`H${g.xForTime(at(end_date) + BOOKMARK_DAY)}`));
    f.pins()[0].emit('click'); assert.deepEqual(f.selections, [at('2024-02-29')]); f.rail.destroy();
  }
});

test('clustered ranges retain capped spans and mixed precision shares a hollow dot', () => {
  const bookmarks = [event('exact'), event('month', '2024-02-29', { precision: 'month', end_date: '2024-03-03' }),
    event('range', '2024-02-29', { end_date: '2024-03-31' })];
  const f = mount(bookmarks);
  assert.equal(f.pins().length, 1);
  assert.equal(withClass(f.container, 'ag-bookmark-span').length, 2);
  const dot = withClass(f.container, 'ag-bookmark-anchor')[0];
  assert.ok(dot.getAttribute('class').includes('ag-bookmark-approximate'));
  f.pins()[0].emit('click');
  f.entries().find(entry => entry.getAttribute('data-bookmark-id') === 'exact').focus();
  const activeDot = withClass(f.container, 'ag-bookmark-active-anchor')[0].children.at(-1);
  assert.equal(activeDot.getAttribute('class'), 'ag-bookmark-anchor'); f.rail.destroy();
});

test('activation uses next UTC midnight after START, including leap day and year boundaries', () => {
  for (const [date, next] of [['2024-02-29', '2024-03-01'], ['2024-12-31', '2025-01-01'], ['0000-02-29', '0000-03-01']]) {
    const bookmark = event(date, date, { end_date: date });
    assert.equal(bookmarkCutoff(bookmark), at(next));
  }
  const bookmark = event('leap'), f = mount([bookmark]);
  f.pins()[0].emit('click', { pointerType: 'touch' });
  assert.deepEqual(f.selections, [at('2024-03-01')]); assert.equal(f.guides.at(-1), at('2024-02-29'));
  assert.equal(f.pins()[0].getAttribute('aria-current'), 'date');
  f.rail.update({ selectedCutoff: null });
  assert.equal(f.guides.at(-1), null); assert.equal(f.pins()[0].getAttribute('aria-current'), 'false'); f.rail.destroy();
});

test('list hover/focus reveal an individual date; selection closes and restores count-pin focus', () => {
  const bookmarks = events('2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01', '2024-03-02');
  const f = mount(bookmarks), pin = f.pins().find(pin => pin.getAttribute('aria-haspopup') === 'dialog');
  pin.emit('click'); const entries = f.entries();
  const entry = entries.at(-1), id = entry.getAttribute('data-bookmark-id'), bookmark = bookmarks.find(b => b.id === id);
  entry.emit('pointerenter'); assert.equal(f.guides.at(-1), bookmark.start);
  entry.emit('pointerleave'); entry.focus(); assert.equal(f.guides.at(-1), bookmark.start);
  near(Number(withClass(f.container, 'ag-bookmark-active-anchor')[0].children.at(-1).getAttribute('cx')), geometry(390).xForTime(bookmark.start));
  entry.emit('click', { pointerType: 'touch' });
  assert.deepEqual(f.selections, [bookmark.start + BOOKMARK_DAY]);
  assert.equal(f.list().hidden, true); assert.equal(f.document.activeElement, pin);
  assert.equal(f.guides.at(-1), bookmark.start); f.rail.destroy();
});

test('Escape closes a list before timeline reset; the next Escape reaches the timeline', () => {
  const f = mount(Array.from({ length: 5 }, (_, i) => event(String(i))));
  let resets = 0; f.container.addEventListener('keydown', event => { if (event.key === 'Escape') resets++; });
  const pin = f.pins()[0]; pin.focus(); pin.emit('click');
  const first = f.entries()[0].emit('keydown', { key: 'Escape' });
  assert.equal(first.defaultPrevented, true); assert.equal(first.stopped, true); assert.equal(resets, 0);
  assert.equal(f.document.activeElement, pin);
  const second = pin.emit('keydown', { key: 'Escape' });
  assert.equal(second.defaultPrevented, false); assert.equal(second.stopped, false); assert.equal(resets, 1);
  assert.equal(f.tooltip().hidden, true); f.rail.destroy();
});

test('tooltip placement contains long content at viewport edges without covering its target', () => {
  for (const width of [320, 390, 1440]) for (const height of [200, 800]) {
    for (const left of [0, width / 2 - 22, width - 44]) for (const top of [0, height / 2 - 22, height - 44]) {
      const target = { left, top, right: left + 44, bottom: top + 44 };
      const placed = bookmarkTooltipPlacement(target, { width, height }, { width: 320, height: 900 });
      assert.ok(placed && placed.width > 0 && placed.height > 0);
      assert.ok(placed.left >= 8 && placed.top >= 8);
      assert.ok(placed.left + placed.width <= width - 8 && placed.top + placed.height <= height - 8);
      assert.ok(placed.left + placed.width <= target.left || placed.left >= target.right ||
        placed.top + placed.height <= target.top || placed.top >= target.bottom);
    }
  }
});

test('hover takes precedence over focus, clearing restores focus/selection, and scroll only repositions overlays', () => {
  const bookmarks = events('2024-01-15', '2024-03-15'), f = mount(bookmarks, { geometry: geometry(1440) });
  f.view.innerWidth = 1440;
  const [first, second] = f.pins();
  first.focus(); second.emit('pointerenter'); assert.equal(f.guides.at(-1), bookmarks[1].start);
  second.emit('pointerleave'); assert.equal(f.guides.at(-1), bookmarks[0].start);
  const anchors = () => withClass(f.container, 'ag-bookmark-anchor').map(dot => dot.getAttribute('cx'));
  const before = anchors(), tooltipLeft = f.tooltip().style.left;
  f.container.rect = { ...f.container.rect, left: -40, right: 1400 };
  f.container.emit('scroll');
  assert.deepEqual(anchors(), before); assert.equal(f.selections.length, 0);
  assert.equal(f.guides.at(-1), bookmarks[0].start);
  assert.notEqual(f.tooltip().style.left, tooltipLeft); f.rail.destroy();
});

test('outside clicks close lists without stealing focus and native targets stay reachable by Tab', () => {
  const f = mount(Array.from({ length: 6 }, (_, i) => event(String(i))));
  const pin = f.pins()[0]; pin.emit('click');
  assert.equal(pin.type, 'button'); assert.equal(pin.disabled, undefined);
  for (const entry of f.entries()) {
    assert.equal(entry.getAttribute('tabindex'), null); entry.focus(); assert.equal(f.document.activeElement, entry);
  }
  const outside = f.document.createElement('button'); f.document.body.append(outside);
  outside.focus(); assert.equal(f.list().hidden, true); assert.equal(f.document.activeElement, outside);
  pin.emit('click'); outside.emit('pointerdown');
  assert.equal(f.list().hidden, true); f.rail.destroy();
});

test('literal titles appear as text in pins, tooltip and list, never as markup', () => {
  const title = '<img src=x onerror="globalThis.bookmarkInjected=true"> & "friends"';
  const bookmark = event('literal', '2024-02-29', { title }), f = mount([bookmark]);
  f.pins()[0].focus(); assert.ok(f.tooltip().textContent.startsWith(title));
  assert.equal(f.tooltip().children.length, 0); assert.ok(f.pins()[0].getAttribute('aria-label').startsWith(title));
  f.rail.update({ bookmarks: [bookmark, event('b'), event('c')] });
  f.pins().find(pin => pin.getAttribute('aria-haspopup') === 'dialog').emit('click');
  const entry = f.entries().find(entry => entry.getAttribute('data-bookmark-id') === 'literal');
  assert.ok(entry.textContent.startsWith(title)); assert.equal(entry.children.length, 0);
  assert.equal(descendants(f.container, node => node.tagName === 'img').length, 0);
  assert.equal(globalThis.bookmarkInjected, undefined); f.rail.destroy();
});

test('friend and relationship remain distinct; direct unknown categories use the safe fallback', () => {
  const f = mount([event('friend', '2024-01-01', { category: 'friend' }),
    event('relationship', '2024-02-01', { category: 'relationship' }),
    { ...event('unknown', '2024-03-01'), category: '__proto__' }]);
  const paths = f.pins().map(pin => descendants(pin, node => node.tagName === 'path')[0].getAttribute('d'));
  assert.equal(new Set(paths).size, 3);
  assert.equal(f.pins()[0].style.getPropertyValue('--bookmark-color'), 'var(--community-green)'); f.rail.destroy();
});

test('updates retain focus and clean stale state; destroy removes overlays and global handlers', () => {
  const bookmark = event('focused'), f = mount([bookmark]);
  const pin = f.pins()[0]; pin.focus();
  f.rail.update({ geometry: geometry(320) }); assert.equal(f.document.activeElement, pin);
  f.rail.update({ bookmarks: [bookmark, event('a'), event('b'), event('c')] });
  assert.equal(f.document.activeElement, f.pins()[0]);
  f.rail.update({ bookmarks: [] }); assert.equal(f.container.hidden, true); assert.equal(f.tooltip().hidden, true);
  assert.equal(f.guides.at(-1), null);
  f.rail.destroy(); f.rail.destroy(); pin.emit('click');
  assert.equal(f.container.children.length, 0); assert.equal(f.overlays.children.length, 0);
  assert.equal(f.selections.length, 0);
  assert.ok([...f.document.listeners.values()].every(listeners => listeners.length === 0));
});

test('inserting dates preserves chronological native tab order and existing focus', () => {
  const last = event('last', '2024-03-15'), f = mount([last]);
  const pin = f.pins()[0]; pin.focus();
  f.rail.update({ bookmarks: [last, event('first', '2024-01-15'), event('middle', '2024-02-15')] });
  assert.deepEqual(f.pins().map(target => target.getAttribute('aria-label').split(' · ')[0]),
    ['Event first', 'Event middle', 'Event last']);
  assert.equal(f.document.activeElement, pin); f.rail.destroy();
});

test('bookmark CSS separates badge size from targets and provides focus without a rail scrollbar', () => {
  const css = readFileSync(new URL('../timeline-bookmarks.css', import.meta.url), 'utf8');
  assert.match(css, /\.ag-bookmark-target[^}]*width: 44px;[^}]*height: 44px;/);
  assert.match(css, /\.ag-bookmark-badge[^}]*width: 26px;[^}]*height: 26px;/);
  assert.match(css, /\.ag-bookmark-badge svg[^}]*width: 16px;[^}]*height: 16px;[^}]*border: 0;/);
  assert.match(css, /:focus-visible[^}]*outline: 2px solid/);
  assert.ok(!css.includes('scrollbar'));
  assert.equal(bookmarkDetails(event('x')).includes('Exact day'), true);
});
