// Export-wide composition, independent of viewport, inspection and map filters.
import { rebinTimeline } from './timeline-explorer.mjs';

// Compare completed calendar months with the previous three months. Work from
// the complete export so zoom, chart bins and hidden groups cannot invent a shift.
// These are descriptive leads for exploration, not significance tests or a
// reconstruction of repeat listening. Unknown labels remain in the denominator.
export function timelineTasteShifts(model, names, { through } = {}) {
  const monthly = rebinTimeline(model, { unit: 'month' });
  const counts = monthly.bins.map(bin => {
    const groups = new Map();
    for (const index of bin.indices) groups.set(names[index], (groups.get(names[index]) ?? 0) + 1);
    return groups;
  });
  const seen = new Set(), candidates = [];
  let lastDate = -Infinity;
  for (const time of model.dates) if (Number.isFinite(time)) lastDate = Math.max(lastDate, time);
  const end = Number.isFinite(through) ? through : lastDate;
  monthly.bins.forEach((bin, index) => {
    const previous = monthly.bins.slice(Math.max(0, index - 3), index);
    const previousTotal = previous.reduce((sum, item) => sum + item.count, 0);
    if (index >= 3 && bin.end <= end && bin.count >= 10 && previousTotal >= 20) {
      for (const [name, count] of counts[index]) {
        if (!name || /^unknown\b/i.test(name) || count < 5) continue;
        const previousCount = counts.slice(index - 3, index).reduce((sum, groups) => sum + (groups.get(name) ?? 0), 0);
        const share = count / bin.count, previousShare = previousCount / previousTotal;
        const lift = share - previousShare;
        if (lift + Number.EPSILON < .05) continue;
        candidates.push({ name, start: bin.start, end: bin.end, count, total: bin.count,
          previousStart: previous[0].start, previousCount, previousTotal, share, previousShare,
          lift, firstAppearance: !seen.has(name), score: lift * Math.sqrt(Math.min(count, 20)),
          indices: bin.indices.filter(albumIndex => names[albumIndex] === name) });
      }
    }
    for (const name of counts[index].keys()) seen.add(name);
  });
  return candidates.sort((a, b) => b.score - a.score || b.count - a.count || a.start - b.start ||
    String(a.name).localeCompare(String(b.name), 'en'));
}

export function selectTasteShifts(candidates, range, hiddenGroups = new Set()) {
  const selected = [];
  for (const candidate of candidates) {
    if (candidate.start >= range.endMs || candidate.end <= range.startMs || hiddenGroups.has(candidate.name)) continue;
    // A few distinct leads are more useful than three adjacent months of one phase.
    if (selected.some(item => item.name === candidate.name || item.start === candidate.start)) continue;
    selected.push(candidate);
    if (selected.length === 3) break;
  }
  return selected.sort((a, b) => a.start - b.start);
}

export function tasteShiftExamples(shift, albums, dates) {
  const artists = new Set(), examples = [];
  for (const index of [...shift.indices].sort((a, b) => dates[a] - dates[b] || a - b)) {
    const album = albums[index];
    if (!album || artists.has(album.albumartist)) continue;
    artists.add(album.albumartist); examples.push(index);
    if (examples.length === 3) break;
  }
  return examples;
}

export function timelineCountScale(maxCount) {
  const target = Math.max(1, maxCount / 3);
  const power = 10 ** Math.floor(Math.log10(target));
  const step = [1, 2, 5, 10].find(value => value * power >= target) * power;
  return { max: 3 * step, ticks: [0, step, 2 * step, 3 * step] };
}

export function aggregateTimeline(model, names, order) {
  const rank = new Map(order.map((name, index) => [name, index]));
  const totals = new Map();
  const compare = (a, b) => b.count - a.count || (rank.get(a.name) ?? Infinity) - (rank.get(b.name) ?? Infinity) ||
    String(a.name).localeCompare(String(b.name), 'en', { numeric: true });
  const breakdowns = model.bins.map(bin => {
    const counts = new Map();
    for (const index of bin.indices) {
      const name = names[index];
      counts.set(name, (counts.get(name) ?? 0) + 1);
      totals.set(name, (totals.get(name) ?? 0) + 1);
    }
    return [...counts].map(([name, count]) => ({ name, count, percent: count / bin.count * 100 })).sort(compare);
  });
  const communities = [...totals].map(([name, count]) => ({ name, count })).sort(compare);
  const majorCommunities = communities.slice(0, 5);
  const stacks = breakdowns.map(groups => {
    const counts = new Map(groups.map(group => [group.name, group.count]));
    return communities.flatMap(({ name }) => counts.has(name) ? [{ name, count: counts.get(name) }] : []);
  });
  return { communities, majorCommunities, stacks, breakdowns, scale: timelineCountScale(model.maxCount),
    peakIndex: model.maxCount > 0 ? model.bins.findIndex(bin => bin.count === model.maxCount) : -1 };
}

// Finite UTC cutoffs can fall inside a bin (for example, a personal event).
// Inspection describes the interval immediately before the exclusive cutoff.
export function periodIndexForCutoff(model, cutoff) {
  if (!model.bins.length) return -1;
  if (cutoff === null) return model.bins.length - 1;
  return model.bins.findIndex(bin => cutoff > bin.start && cutoff <= bin.end);
}

export function cutoffForTimelineKey(key, cutoff, model) {
  if (key === 'Escape') return null;
  if (!model.bins.length) return undefined;
  const boundaries = [model.bins[0].start, ...model.bins.map(bin => bin.end)];
  if (key === 'Home') return boundaries[0];
  if (key === 'End' || cutoff === null && ['ArrowLeft', 'ArrowRight'].includes(key)) return boundaries.at(-1);
  if (key === 'ArrowLeft') return boundaries.findLast(value => value < cutoff) ?? boundaries[0];
  if (key === 'ArrowRight') return boundaries.find(value => value > cutoff) ?? boundaries.at(-1);
  return undefined;
}

export function nearestTimelineCutoff(model, geometry, time) {
  const x = geometry.xForTime(time);
  return [model.bins[0].start, ...model.bins.map(bin => bin.end)].reduce((nearest, boundary) =>
    Math.abs(geometry.xForTime(boundary) - x) < Math.abs(geometry.xForTime(nearest) - x) ? boundary : nearest);
}
