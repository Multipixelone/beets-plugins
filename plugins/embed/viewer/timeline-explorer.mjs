// Calendar aggregation for the visible explorer window. Zoom changes these
// bins, but never changes an album's date or the cumulative snapshot semantics.
const DAY = 86400000;
const UNITS = new Set(['auto', 'day', 'week', 'month', 'year']);

function utc(year, month = 0, day = 1) {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

function floorPeriod(time, unit) {
  const date = new Date(time), year = date.getUTCFullYear(), month = date.getUTCMonth();
  if (unit === 'year') return utc(year);
  if (unit === 'month') return utc(year, month);
  const day = utc(year, month, date.getUTCDate());
  return unit === 'week' ? day - (date.getUTCDay() + 6) % 7 * DAY : day;
}

function nextPeriod(time, unit) {
  if (unit === 'day' || unit === 'week') return time + DAY * (unit === 'week' ? 7 : 1);
  const date = new Date(time);
  return unit === 'month' ? utc(date.getUTCFullYear(), date.getUTCMonth() + 1) : utc(date.getUTCFullYear() + 1);
}

export function timelineExplorerRange(model) {
  return model.bins.length ? { startMs: model.bins[0].start, endMs: model.bins.at(-1).end } : null;
}

export function rebinTimeline(model, { unit = 'auto', startMs, endMs } = {}) {
  if (!UNITS.has(unit)) throw new RangeError(`Unknown timeline interval: ${unit}`);
  const result = { ...model, bins: [], albumBins: new Int32Array(model.dates.length).fill(-1), maxCount: 0,
    unit: unit === 'auto' ? 'day' : unit, step: 1 };
  const range = timelineExplorerRange(model);
  if (!range) return result;
  const clamp = time => Math.max(range.startMs, Math.min(range.endMs, time));
  let start = clamp(Number.isFinite(startMs) ? startMs : range.startMs);
  let end = clamp(Number.isFinite(endMs) ? endMs : range.endMs);
  if (start > end) [start, end] = [end, start];
  // A collapsed brush still has a containing calendar period, including at
  // the exclusive upper bound of the complete export.
  if (start === end) { start = Math.min(start, range.endMs - 1); end = start + 1; }
  if (unit === 'auto') {
    const date = new Date(start);
    const decadeEnd = utc(date.getUTCFullYear() + 10, date.getUTCMonth(), date.getUTCDate());
    unit = end - start <= 60 * DAY ? 'day' : end - start <= 366 * DAY ? 'week' : end <= decadeEnd ? 'month' : 'year';
  }
  result.unit = unit;
  for (let boundary = floorPeriod(start, unit); boundary < end;) {
    const next = nextPeriod(boundary, unit);
    result.bins.push({ start: boundary, end: next, indices: [], count: 0, cumulative: 0 });
    boundary = next;
  }
  const first = result.bins[0].start, last = result.bins.at(-1).end;
  const firstDate = new Date(first);
  let cumulative = 0;
  model.dates.forEach((time, index) => {
    if (!Number.isFinite(time)) return;
    if (time < first) { cumulative++; return; }
    if (time >= last) return;
    const date = new Date(time);
    const position = unit === 'day' || unit === 'week' ? Math.floor((time - first) / (DAY * (unit === 'week' ? 7 : 1))) :
      unit === 'month' ? (date.getUTCFullYear() - firstDate.getUTCFullYear()) * 12 + date.getUTCMonth() - firstDate.getUTCMonth() :
      date.getUTCFullYear() - firstDate.getUTCFullYear();
    result.albumBins[index] = position;
    result.bins[position].indices.push(index); result.bins[position].count++;
  });
  for (const bin of result.bins) {
    bin.cumulative = cumulative += bin.count;
    result.maxCount = Math.max(result.maxCount, bin.count);
  }
  return result;
}
