// Export-wide composition, independent of viewport, inspection and map filters.

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
