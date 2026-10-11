// Bookmark-only placement. Dates always use the caller's shared geometry.
export const BOOKMARK_DAY = 86400000;
const TARGET = 44, GAP = 4, SHIFT = 22;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const compare = (a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function bookmarkCutoff(bookmark) { return bookmark.start + BOOKMARK_DAY; }

export function bookmarkDetails(bookmark) {
  const dates = bookmark.end === null ? bookmark.date : `${bookmark.date}–${bookmark.end_date}`;
  const precision = bookmark.precision === 'day' ? 'Exact day' : `${bookmark.precision} precision (approximate)`;
  return `${bookmark.title} · ${dates} UTC · ${precision} · ${bookmark.category} · Show snapshot through ${bookmark.date} UTC`;
}

export function bookmarkRailLayout(geometry, bookmarks) {
  if (!bookmarks.length) return { items: [], height: 0, anchorY: 0 };
  const width = Math.max(TARGET, geometry.contentWidth);
  const makeGroup = events => {
    const anchors = events.map(bookmark => ({ bookmark, x: geometry.xForTime(bookmark.start),
      endX: bookmark.end === null ? null : geometry.xForTime(bookmark.end + BOOKMARK_DAY) }));
    const firstX = anchors[0].x, lastX = anchors.at(-1).x;
    return { key: JSON.stringify(events.map(event => event.id)), events, anchors, firstX, lastX,
      x: (firstX + lastX) / 2, clustered: events.length > 1 };
  };
  let groups = [...bookmarks].sort(compare).map(bookmark => makeGroup([bookmark]));
  for (;;) {
    const placed = [], lanes = [[], []];
    let failed = -1;
    for (const [index, group] of groups.entries()) {
      const ideal = clamp(group.x - TARGET / 2, 0, width - TARGET), candidates = [];
      for (const [lane, occupants] of lanes.entries()) {
        let left = 0;
        for (const occupant of [...occupants].sort((a, b) => a.left - b.left).concat([{ left: width + GAP }])) {
          const right = occupant.left - GAP;
          if (right - left >= TARGET) {
            const candidate = clamp(ideal, left, right - TARGET);
            if (Math.abs(candidate - ideal) <= SHIFT) candidates.push({ lane, left: candidate, distance: Math.abs(candidate - ideal) });
          }
          left = occupant.left + TARGET + GAP;
        }
      }
      candidates.sort((a, b) => a.distance - b.distance || a.lane - b.lane || a.left - b.left);
      if (!candidates.length) { failed = index; break; }
      const item = { ...group, ...candidates[0] };
      lanes[item.lane].push(item); placed.push(item);
    }
    if (failed < 0) {
      const height = (Math.max(...placed.map(item => item.lane)) + 1) * TARGET;
      return { items: placed, height, anchorY: height - 4 };
    }
    // Collapse the immediate dense neighborhood, including every same-date
    // event, rather than leaving a lone icon beside a count for the same date.
    let first = failed, last = failed;
    while (first > 0 && groups[failed].firstX - groups[first - 1].lastX < TARGET + GAP) first--;
    while (last + 1 < groups.length && groups[last + 1].firstX - groups[failed].lastX < TARGET + GAP) last++;
    if (first === last) {
      const previous = failed > 0 ? groups[failed].firstX - groups[failed - 1].lastX : Infinity;
      const next = failed + 1 < groups.length ? groups[failed + 1].firstX - groups[failed].lastX : Infinity;
      if (previous <= next) first--; else last++;
    }
    groups.splice(first, last - first + 1, makeGroup(groups.slice(first, last + 1).flatMap(group => group.events)));
  }
}

// The tooltip fits in a free rectangle outside the complete 44px target.
export function bookmarkTooltipPlacement(target, viewport, size) {
  const margin = 8, gap = 6;
  const bounds = { left: margin, top: margin, right: viewport.width - margin, bottom: viewport.height - margin };
  const spaces = [
    { side: 'above', left: bounds.left, right: bounds.right, top: bounds.top, bottom: Math.min(bounds.bottom, target.top - gap) },
    { side: 'below', left: bounds.left, right: bounds.right, top: Math.max(bounds.top, target.bottom + gap), bottom: bounds.bottom },
    { side: 'left', left: bounds.left, right: Math.min(bounds.right, target.left - gap), top: bounds.top, bottom: bounds.bottom },
    { side: 'right', left: Math.max(bounds.left, target.right + gap), right: bounds.right, top: bounds.top, bottom: bounds.bottom }
  ].filter(space => space.right > space.left && space.bottom > space.top);
  const fits = space => space.right - space.left >= size.width && space.bottom - space.top >= size.height;
  const space = spaces.find(fits) ?? spaces.sort((a, b) =>
    Math.min(size.width, b.right - b.left) * Math.min(size.height, b.bottom - b.top) -
    Math.min(size.width, a.right - a.left) * Math.min(size.height, a.bottom - a.top))[0];
  if (!space) return null;
  const width = Math.min(size.width, space.right - space.left), height = Math.min(size.height, space.bottom - space.top);
  return { left: clamp((target.left + target.right - width) / 2, space.left, space.right - width),
    top: space.side === 'above' ? space.bottom - height : space.side === 'below' ? space.top :
      clamp((target.top + target.bottom - height) / 2, space.top, space.bottom - height),
    width, height };
}
