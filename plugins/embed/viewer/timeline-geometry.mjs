/**
 * Shared timeline geometry, independent of DOM and presentation. All positions
 * are CSS pixels in the horizontally scrolling content, and times are UTC ms.
 * Time is linear across real calendar boundaries (months are not equal width).
 * contentWidth is the greater of viewportWidth and the width needed to give
 * the shortest bin minBinPx, plus plot padding and both slider-thumb insets.
 * plot.left/right are coordinates, not padding. A native range positioned at
 * plot.left - thumbInset with width plot.width + 2 * thumbInset has its thumb
 * center at xForTime(value), when its min/max are the domain's UTC endpoints.
 * Consumers share this object; none should construct a second temporal scale.
 */
export function createTimelineGeometry({ domainStartMs, domainEndMs, bins,
  minBinPx = 12, viewportWidth, plotPadding = { left: 0, right: 0 }, thumbInset = 0 }) {
  const duration = domainEndMs - domainStartMs;
  const left = plotPadding.left ?? 0, right = plotPadding.right ?? 0;
  if (![domainStartMs, domainEndMs, viewportWidth, minBinPx, left, right, thumbInset].every(Number.isFinite) ||
      duration <= 0 || viewportWidth < 0 || minBinPx <= 0 || left < 0 || right < 0 || thumbInset < 0) {
    throw new RangeError('Timeline geometry needs a finite, increasing domain and nonnegative dimensions');
  }
  const intervals = bins.map(({ startMs, endMs }) => ({ startMs, endMs }));
  let shortest = duration;
  for (const [index, bin] of intervals.entries()) {
    if (![bin.startMs, bin.endMs].every(Number.isFinite) || bin.endMs <= bin.startMs ||
        bin.startMs < domainStartMs || bin.endMs > domainEndMs ||
        index > 0 && bin.startMs < intervals[index - 1].endMs) {
      throw new RangeError('Timeline bins must be increasing, nonoverlapping intervals inside the domain');
    }
    shortest = Math.min(shortest, bin.endMs - bin.startMs);
  }
  const contentWidth = Math.max(viewportWidth, left + right + 2 * thumbInset + minBinPx * duration / shortest);
  const plot = Object.freeze({ left: left + thumbInset, right: contentWidth - right - thumbInset,
    width: contentWidth - left - right - 2 * thumbInset });
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const xForTime = ms => plot.left + (clamp(ms, domainStartMs, domainEndMs) - domainStartMs) / duration * plot.width;
  const timeForX = x => domainStartMs + (clamp(x, plot.left, plot.right) - plot.left) / plot.width * duration;
  return Object.freeze({
    domain: Object.freeze({ startMs: domainStartMs, endMs: domainEndMs }), plot, contentWidth, thumbInset,
    xForTime, timeForX,
    binIndexForX(x) {
      if (!intervals.length) return -1;
      if (x >= plot.right) return intervals.length - 1;
      // Compare content coordinates at boundaries to avoid floating-point
      // round-trip error assigning an exact edge to the preceding interval.
      let low = 0, high = intervals.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (xForTime(intervals[middle].endMs) <= x) low = middle + 1;
        else high = middle;
      }
      return low < intervals.length && Math.max(x, plot.left) >= xForTime(intervals[low].startMs) ? low : -1;
    },
    clientToContentX: (clientX, stageRect, scrollLeft) => clientX - stageRect.left + scrollLeft,
    contentToClientX: (x, stageRect, scrollLeft) => stageRect.left + x - scrollLeft
  });
}
