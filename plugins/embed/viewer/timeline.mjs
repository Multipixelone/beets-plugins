// UTC dates and temporal eligibility, independent of the DOM and graph renderer.
const DAY = 86400000;
function utc(year, month = 0, day = 1) {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

export function parseAdded(value) {
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/.exec(value);
  if (!match) return NaN;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return NaN;
  const date = new Date(utc(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return NaN;
  date.setUTCHours(hour, minute, second, Number((match[7] ?? '').padEnd(3, '0').slice(0, 3)));
  return date.getTime();
}

export const BOOKMARK_CATEGORIES = {
  move: ['house', 'blue'], school: ['book', 'yellow'], job: ['case', 'orange'],
  show: ['stage', 'purple'], concert: ['ticket', 'red'], travel: ['compass', 'aqua'],
  health: ['cross', 'green'], relationship: ['heart', 'purple'], music: ['note', 'aqua'],
  milestone: ['flag', 'yellow'], other: ['circle', 'blue']
};
const PRECISIONS = new Set(['day', 'month', 'season', 'year', 'approximate']);

export function parseBookmarkDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ?
    parseAdded(`${value}T00:00:00Z`) : NaN;
}

export function normalizeBookmarks(value) {
  if (!Array.isArray(value)) return [];
  const ids = new Set(), bookmarks = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        typeof entry.id !== 'string' || !entry.id.trim() || ids.has(entry.id) ||
        typeof entry.title !== 'string' || !entry.title.trim() ||
        !PRECISIONS.has(entry.precision) || typeof entry.category !== 'string' ||
        !Object.hasOwn(BOOKMARK_CATEGORIES, entry.category)) continue;
    const start = parseBookmarkDate(entry.date);
    const end = entry.end_date === null ? null : parseBookmarkDate(entry.end_date);
    if (!Number.isFinite(start) || end !== null && (!Number.isFinite(end) || end < start)) continue;
    ids.add(entry.id);
    bookmarks.push({ id: entry.id, date: entry.date, end_date: entry.end_date,
      precision: entry.precision, title: entry.title, category: entry.category, start, end });
  }
  return bookmarks.sort((a, b) => a.start - b.start);
}

export function bookmarkLabel(bookmark) {
  const dates = bookmark.end_date === null ? bookmark.date : `${bookmark.date}–${bookmark.end_date}`;
  const precision = bookmark.precision === 'day' ? '' : ` · ${bookmark.precision} precision (approximate)`;
  return `${bookmark.title} · ${dates} UTC${precision} · ${bookmark.category}`;
}

export function buildTimeline(albums, bookmarks) {
  const dates = Float64Array.from(albums, album => parseAdded(album.added));
  let first = Infinity, last = -Infinity, undated = 0;
  for (const date of dates) {
    if (!Number.isFinite(date)) undated++;
    else { first = Math.min(first, date); last = Math.max(last, date); }
  }
  const model = { dates, bins: [], undated, total: albums.length, maxCount: 0, bookmarks: normalizeBookmarks(bookmarks),
    albumBins: new Int32Array(albums.length).fill(-1), first: Number.isFinite(first) ? first : null };
  for (const bookmark of model.bookmarks) {
    first = Math.min(first, bookmark.start); last = Math.max(last, bookmark.end ?? bookmark.start);
  }
  if (!Number.isFinite(first)) return model;
  const earliest = new Date(first), latest = new Date(last);
  const firstDay = utc(earliest.getUTCFullYear(), earliest.getUTCMonth(), earliest.getUTCDate());
  const lastDay = utc(latest.getUTCFullYear(), latest.getUTCMonth(), latest.getUTCDate());
  const days = Math.round((lastDay - firstDay) / DAY) + 1;
  const firstMonth = earliest.getUTCFullYear() * 12 + earliest.getUTCMonth();
  const months = latest.getUTCFullYear() * 12 + latest.getUTCMonth() - firstMonth + 1;
  const years = latest.getUTCFullYear() - earliest.getUTCFullYear() + 1;
  const step = Math.ceil(years / 120);
  model.unit = days <= 90 ? 'day' : months <= 120 ? 'month' : 'year';
  model.step = model.unit === 'year' ? step : 1;
  const count = model.unit === 'day' ? days : model.unit === 'month' ? months : Math.ceil(years / step);
  const boundary = index => model.unit === 'day' ? firstDay + index * DAY :
    model.unit === 'month' ? utc(earliest.getUTCFullYear(), earliest.getUTCMonth() + index) :
    utc(earliest.getUTCFullYear() + index * step);
  model.bins = Array.from({ length: count }, (_, index) =>
    ({ start: boundary(index), end: boundary(index + 1), indices: [], count: 0, cumulative: 0 }));
  dates.forEach((date, index) => {
    if (!Number.isFinite(date)) return;
    const value = new Date(date);
    const bin = model.unit === 'day' ? Math.floor((date - firstDay) / DAY) :
      model.unit === 'month' ? value.getUTCFullYear() * 12 + value.getUTCMonth() - firstMonth :
      Math.floor((value.getUTCFullYear() - earliest.getUTCFullYear()) / step);
    model.albumBins[index] = bin;
    model.bins[bin].indices.push(index); model.bins[bin].count++;
  });
  let cumulative = 0;
  for (const bin of model.bins) {
    bin.cumulative = cumulative += bin.count;
    model.maxCount = Math.max(model.maxCount, bin.count);
  }
  return model;
}

export function timelinePositionForDate(model, date) {
  return model.bins.findIndex(bin => date >= bin.start && date < bin.end);
}

// Match the histogram's calendar-bin spacing, including its separate Latest slot.
export function bookmarkLayout(model, width) {
  if (!model.bins.length || width < 44) return { markers: [], height: 0 };
  const pitch = width / (model.bins.length + 1), laneEnds = [];
  const x = date => {
    const index = timelinePositionForDate(model, date);
    if (index < 0) return model.bins.length * pitch;
    const bin = model.bins[index];
    return (index + (date - bin.start) / (bin.end - bin.start)) * pitch;
  };
  const markers = model.bookmarks.map(bookmark => {
    const start = x(bookmark.start), left = Math.max(0, Math.min(width - 44, start - 22));
    const rangeEnd = bookmark.end === null ? start : x(bookmark.end + DAY);
    const footprintStart = Math.min(left, start), footprintEnd = Math.max(left + 44, rangeEnd);
    let lane = laneEnds.findIndex(end => footprintStart >= end + 4);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = footprintEnd;
    return { bookmark, position: timelinePositionForDate(model, bookmark.start), lane, left,
      rangeLeft: start, rangeWidth: Math.max(2, rangeEnd - start) };
  });
  return { markers, height: laneEnds.length * 44 };
}

// Position -1 is before the first bin; null is unbounded, even at the last bin.
export function timelineCutoff(model, position) {
  return position === null || !model.bins.length ? null :
    position < 0 ? model.bins[0].start : model.bins[position].end;
}

export function timelineMembership(dates, cutoff = null) {
  const eligible = Array.from(dates, date => cutoff === null || Number.isFinite(date) && date < cutoff);
  return { historical: cutoff !== null, eligible, count: eligible.filter(Boolean).length };
}

export function applyTimeline(selection, temporal) {
  if (!temporal.historical) return selection;
  const states = selection.states.map((state, index) => {
    const visible = state.visible && temporal.eligible[index];
    return { ...state, visible: !!visible, match: !!(state.match && temporal.eligible[index]),
      opacity: visible ? state.opacity : 0 };
  });
  return { ...selection, active: true, states,
    visibleIndices: states.flatMap((state, index) => state.visible ? [index] : []),
    matches: states.flatMap((state, index) => state.match ? [index] : []) };
}

// Group keys/order come from the same full-export community mapping as the map.
export function timelineStacks(model, names, order) {
  return model.bins.map(bin => {
    const counts = new Map();
    for (const index of bin.indices) counts.set(names[index], (counts.get(names[index]) ?? 0) + 1);
    return order.flatMap(name => counts.has(name) ? [{ name, count: counts.get(name) }] : []);
  });
}

export function timelinePositionForKey(key, position, count) {
  if (!count) return undefined;
  if (key === 'Escape') return null;
  if (key === 'Home') return -1;
  if (key === 'End') return count - 1;
  if (key === 'ArrowLeft') return Math.max(-1, (position ?? count) - 1);
  if (key === 'ArrowRight') return position === null || position === count - 1 ? null : position + 1;
  return undefined;
}

export const TIMELINE_DOCK_KEY = 'beets-album-graph.timeline-docked';

// null means no explicit choice: follow the viewer's mobile breakpoint.
export function readTimelineDockPreference(storage) {
  try {
    const value = storage?.getItem(TIMELINE_DOCK_KEY);
    return value === 'true' ? true : value === 'false' ? false : null;
  } catch { return null; }
}

export function saveTimelineDockPreference(storage, docked) {
  try { storage?.setItem(TIMELINE_DOCK_KEY, String(docked)); } catch { /* Keep the session choice. */ }
}

export function timelineDocked(preference, narrow) {
  return preference ?? narrow;
}

export function timelineReservedHeight(hidden, height, bottom) {
  return hidden ? 0 : Math.ceil(height + bottom + 8);
}
