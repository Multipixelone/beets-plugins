// Rendering consumes shared geometry and a cached count scale. It never bins,
// ranks communities, or computes its own horizontal date scale.
export const TIMELINE_PLOT_HEIGHT = 120;

export function timelineTicks(model, geometry, viewportWidth) {
  const month = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const label = ms => model.unit === 'year' ? String(new Date(ms).getUTCFullYear()) :
    (model.unit === 'month' ? month : day).format(ms);
  const gap = viewportWidth < 500 ? 110 : 90;
  const endpoints = [model.bins[0].start, model.bins.at(-1).end];
  const ticks = [{ time: endpoints[0], label: label(endpoints[0]), edge: 'first' }];
  let previous = geometry.xForTime(endpoints[0]);
  for (const bin of model.bins.slice(1)) {
    const x = geometry.xForTime(bin.start);
    if (x - previous >= gap && geometry.xForTime(endpoints[1]) - x >= gap) {
      ticks.push({ time: bin.start, label: label(bin.start), edge: '' }); previous = x;
    }
  }
  if (ticks.length === 1 && model.bins.length > 1 && geometry.plot.width >= 180) {
    const middle = (geometry.plot.left + geometry.plot.right) / 2;
    const bin = model.bins.slice(1).reduce((nearest, candidate) =>
      Math.abs(geometry.xForTime(candidate.start) - middle) < Math.abs(geometry.xForTime(nearest.start) - middle) ? candidate : nearest);
    ticks.push({ time: bin.start, label: label(bin.start), edge: '' });
  }
  ticks.push({ time: endpoints[1], label: label(endpoints[1]), edge: 'last' });
  return ticks;
}

export function drawTimelineHistogram(canvas, { geometry, model, aggregation, colors, cutoff,
  inspectedIndex = null, guideTime = null, ink, accent, grid, devicePixelRatio = 1 }) {
  const width = geometry.contentWidth, height = TIMELINE_PLOT_HEIGHT;
  canvas.width = Math.ceil(width * devicePixelRatio); canvas.height = Math.ceil(height * devicePixelRatio);
  const context = canvas.getContext('2d'); context.scale(devicePixelRatio, devicePixelRatio);
  const y = value => height - value / aggregation.scale.max * height;
  context.strokeStyle = grid; context.lineWidth = 1;
  for (const value of aggregation.scale.ticks) {
    const cy = Math.min(height - .5, Math.max(.5, y(value)));
    context.beginPath(); context.moveTo(geometry.plot.left, cy); context.lineTo(geometry.plot.right, cy); context.stroke();
  }
  for (const [index, segments] of aggregation.stacks.entries()) {
    const bin = model.bins[index], left = geometry.xForTime(bin.start), right = geometry.xForTime(bin.end);
    let bottom = height;
    for (const segment of segments) {
      const size = segment.count / aggregation.scale.max * height;
      context.fillStyle = colors.get(segment.name);
      context.fillRect(left + 1, bottom - size, right - left - 2, size); bottom -= size;
    }
    if (index === inspectedIndex) {
      context.strokeStyle = ink; context.lineWidth = 1;
      context.strokeRect(left + .5, .5, right - left - 1, height - 1);
    }
  }
  const line = (time, color, dashed = false) => {
    const x = geometry.xForTime(time);
    context.beginPath(); context.setLineDash(dashed ? [3, 3] : []);
    context.strokeStyle = color; context.moveTo(x, 0); context.lineTo(x, height); context.stroke();
    context.setLineDash([]);
  };
  if (guideTime !== null) line(guideTime, ink, true);
  if (cutoff !== null) line(cutoff, accent);
}
