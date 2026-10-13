import { init, use, graphic } from 'echarts/core';
import { CustomChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, DataZoomComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { timelineCountScale } from './timeline-aggregation.mjs';

use([CustomChart, GridComponent, TooltipComponent, DataZoomComponent, CanvasRenderer]);

// Shared with the event rail: labels must never alter the plot's horizontal inset.
export const TIMELINE_CHART_LEFT = 44, TIMELINE_CHART_RIGHT = 16;
const GRID_TOP = 12, GRID_BOTTOM = 62;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const utcDate = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const sameRange = (a, b) => a?.startMs === b?.startMs && a?.endMs === b?.endMs;

export function timelineRangePercent(domain, range) {
  const span = domain.endMs - domain.startMs;
  return { start: clamp((range.startMs - domain.startMs) / span * 100, 0, 100),
    end: clamp((range.endMs - domain.startMs) / span * 100, 0, 100) };
}

export function timelineRangeFromPercent(domain, { start, end }) {
  const span = domain.endMs - domain.startMs;
  return { startMs: domain.startMs + clamp(start, 0, 100) / 100 * span,
    endMs: domain.startMs + clamp(end, 0, 100) / 100 * span };
}

// Filtering and normalization happen before drawing so hidden groups leave no
// holes, and a percentage column always describes the groups still visible.
export function timelineChartData(model, aggregation, hiddenGroups = new Set(), mode = 'count', focusedGroup = null) {
  const rows = model.bins.map((bin, index) => {
    const groups = aggregation.stacks[index].filter(group => !hiddenGroups.has(group.name));
    // Anchor the highlighted sound at zero, so its shape can be compared across
    // periods instead of floating on top of unrelated parts of the stack.
    if (focusedGroup !== null) groups.sort((a, b) => Number(b.name === focusedGroup) - Number(a.name === focusedGroup));
    const total = groups.reduce((sum, group) => sum + group.count, 0);
    let bottom = 0;
    const segments = groups.map(group => {
      const top = bottom + (mode === 'percent' ? total ? group.count / total * 100 : 0 : group.count);
      const segment = { ...group, bottom, top }; bottom = top; return segment;
    });
    return { index, start: bin.start, end: bin.end, total, segments };
  });
  return { rows, scale: mode === 'percent' ? { max: 100, ticks: [0, 25, 50, 75, 100] } :
    timelineCountScale(rows.reduce((max, row) => Math.max(max, row.total), 0)) };
}

/** ECharts owns zoom and pixels; the caller owns calendar bins and selection. */
export class TimelineChart {
  constructor({ element, onZoom = () => {}, onInspect = () => {}, onSelect = () => {}, theme = {} }) {
    this.element = element; this.theme = theme; this.onZoom = onZoom; this.onInspect = onInspect; this.onSelect = onSelect;
    this.chart = init(element, null, { renderer: 'canvas' });
    this.chart.on('datazoom', event => {
      if (this.applying || !this.domain || this.disposed) return;
      const zoom = event.batch?.[0] ?? event;
      let { start, end } = zoom;
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        const current = this.chart.getOption().dataZoom?.[0];
        start ??= current?.start; end ??= current?.end;
      }
      if (!Number.isFinite(start) || !Number.isFinite(end)) return;
      this.range = timelineRangeFromPercent(this.domain, { start, end });
      this.pendingZoom = { ...this.range }; this.hideTooltip(); this.drawOverlays();
      // Rebinning changes chart options; never re-enter ECharts' update cycle.
      if (!this.zoomQueued) {
        this.zoomQueued = true;
        queueMicrotask(() => { this.zoomQueued = false; if (!this.disposed) this.onZoom(this.pendingZoom); });
      }
    });
    const renderer = this.chart.getZr();
    renderer.on('mousemove', event => this.inspect(this.indexAt(event)));
    renderer.on('globalout', () => { this.inspect(null); this.hideTooltip(); });
    renderer.on('mousedown', event => { this.down = [event.offsetX, event.offsetY]; });
    renderer.on('click', event => {
      if (this.down && Math.hypot(event.offsetX - this.down[0], event.offsetY - this.down[1]) > 6) return;
      const index = this.indexAt(event), model = this.model;
      if (index !== null) queueMicrotask(() => { if (!this.disposed && this.model === model) this.onSelect(index); });
    });
  }

  indexAt(event) {
    const pixel = [event.offsetX, event.offsetY];
    if (!this.model || !this.chart.containPixel({ gridIndex: 0 }, pixel)) return null;
    const time = this.chart.convertFromPixel({ xAxisIndex: 0 }, event.offsetX);
    const index = this.model.bins.findIndex((bin, i) => time >= bin.start &&
      (time < bin.end || i === this.model.bins.length - 1 && time === bin.end));
    return index < 0 ? null : index;
  }

  inspect(index) {
    if (this.lastInspect === index) return;
    this.lastInspect = index;
    if (!this.inspectQueued) {
      this.inspectQueued = true;
      queueMicrotask(() => {
        this.inspectQueued = false;
        if (!this.disposed && this.lastInspect !== undefined) this.onInspect(this.lastInspect);
      });
    }
  }

  tooltip(params) {
    const row = this.prepared?.rows[params.value?.[3]];
    if (!row) return '';
    const end = row.end - 1, first = utcDate.format(row.start), last = utcDate.format(end);
    const groups = [...row.segments].sort((a, b) => b.count - a.count);
    const width = this.element?.clientWidth ?? 400, limit = width < 400 ? 3 : 6;
    const columns = Math.max(20, Math.floor((width - 40) / 6.7));
    const dates = `${first === last ? first : `${first} – ${last}`} UTC`;
    const lines = [dates.length > columns && first !== last ? `${first} –\n${last} UTC` : dates, `${row.total.toLocaleString()} albums`];
    for (const group of groups.slice(0, limit)) {
      const label = String(this.names?.get(group.name) ?? group.name);
      const stats = `${group.count.toLocaleString()} · ${(row.total ? group.count / row.total * 100 : 0).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
      const room = Math.max(3, columns - stats.length - 3);
      lines.push(`${label.length > room ? `${label.slice(0, room - 1)}…` : label} · ${stats}`);
    }
    if (groups.length > limit) lines.push(`${groups.length - limit} more groups · ${groups.slice(limit).reduce((sum, group) => sum + group.count, 0).toLocaleString()} albums`);
    // richText draws text on canvas. Export-provided names never become HTML.
    return lines.join('\n');
  }

  bars() {
    const prepared = this.prepared, colors = this.colors, focusedGroup = this.focusedGroup;
    return { id: 'timeline-bars', type: 'custom', name: 'Albums', coordinateSystem: 'cartesian2d',
      animation: false, progressive: 0, emphasis: { disabled: true },
      dimensions: ['start', 'end', 'total', 'bin'], encode: { x: [0, 1], y: 2, tooltip: [2] },
      data: prepared.rows.map(row => [row.start, row.end, row.total, row.index]),
      renderItem: (params, api) => {
        const row = prepared.rows[api.value(3)], bounds = params.coordSys;
        const start = api.coord([row.start, 0])[0], end = api.coord([row.end, 0])[0];
        const gap = Math.min(1, Math.max(0, end - start) * .15);
        const hit = graphic.clipRectByRect({ x: start, y: bounds.y, width: end - start, height: bounds.height }, bounds);
        if (!hit) return;
        const children = [{ type: 'rect', shape: hit, style: { fill: 'transparent' } }];
        for (const segment of row.segments) {
          const top = api.coord([row.start, segment.top])[1], bottom = api.coord([row.start, segment.bottom])[1];
          const shape = graphic.clipRectByRect({ x: start + gap, y: top, width: end - start - 2 * gap, height: bottom - top }, bounds);
          if (shape) children.push({ type: 'rect', shape, style: { fill: colors.get(segment.name),
            opacity: focusedGroup == null || segment.name === focusedGroup ? 1 : .16 } });
        }
        return { type: 'group', children };
      } };
  }

  drawOverlays() {
    if (!this.model || this.disposed) return;
    if (!this.overlayGroup) {
      this.overlayGroup = new graphic.Group({ silent: true });
      this.inspectionShape = new graphic.Rect({ silent: true, z: 5 });
      this.guideShape = new graphic.Line({ silent: true, z: 6 });
      this.cutoffShape = new graphic.Line({ silent: true, z: 6 });
      this.tasteShape = new graphic.Rect({ silent: true, z: 4 });
      this.tasteMarkers = Array.from({ length: 3 }, () => new graphic.Text({ silent: true, z: 7 }));
      for (const shape of [this.tasteShape, this.inspectionShape, this.guideShape, this.cutoffShape, ...this.tasteMarkers]) this.overlayGroup.add(shape);
      this.chart.getZr().add(this.overlayGroup);
    }
    const bounds = { x: TIMELINE_CHART_LEFT, y: GRID_TOP,
      width: this.chart.getWidth() - TIMELINE_CHART_LEFT - TIMELINE_CHART_RIGHT,
      height: this.chart.getHeight() - GRID_TOP - GRID_BOTTOM };
    const pixel = time => this.chart.convertToPixel({ xAxisIndex: 0 }, time);
    const taste = this.tasteRange;
    const tasteShape = taste && graphic.clipRectByRect({ x: pixel(taste.start), y: bounds.y,
      width: pixel(taste.end) - pixel(taste.start), height: bounds.height }, bounds);
    this.tasteShape.attr({ ignore: !tasteShape, ...(tasteShape ? { shape: tasteShape } : {}),
      style: { fill: 'rgba(255,158,66,.10)', stroke: this.theme.accent ?? '#ff9e42', lineWidth: 1 } });
    let lastMarker = -Infinity;
    this.tasteMarkers.forEach((marker, index) => {
      const shift = this.tasteHighlights?.[index], x = shift ? pixel((shift.start + shift.end) / 2) : NaN;
      const visible = Number.isFinite(x) && x >= bounds.x && x <= bounds.x + bounds.width && x - lastMarker >= 18;
      marker.attr({ ignore: !visible, style: { x, y: bounds.y + 2, text: String(index + 1),
        fill: this.theme.accent ?? '#ff9e42', backgroundColor: this.theme.panel ?? '#242019',
        padding: [2, 4], borderRadius: 3, font: '11px ui-monospace, monospace', align: 'center' } });
      if (visible) lastMarker = x;
    });
    const selected = this.model.bins[this.inspectedIndex];
    const shape = selected && graphic.clipRectByRect({ x: pixel(selected.start) + .5, y: bounds.y + .5,
      width: pixel(selected.end) - pixel(selected.start) - 1, height: bounds.height - 1 }, bounds);
    this.inspectionShape.attr({ ignore: !shape, ...(shape ? { shape } : {}),
      style: { fill: 'rgba(255,255,255,.025)', stroke: this.theme.ink ?? '#e8e2d8', lineWidth: 1 } });
    for (const [line, time, cutoff] of [[this.guideShape, this.guideTime, false], [this.cutoffShape, this.cutoff, true]]) {
      const x = time == null ? NaN : pixel(time);
      line.attr({ ignore: !Number.isFinite(x) || x < bounds.x || x > bounds.x + bounds.width,
        shape: { x1: x, x2: x, y1: bounds.y, y2: bounds.y + bounds.height },
        style: { stroke: cutoff ? this.theme.accent ?? '#ff9e42' : this.theme.ink ?? '#e8e2d8',
          lineWidth: cutoff ? 1.5 : 1, lineDash: cutoff ? null : [3, 3] } });
    }
  }

  update({ model, aggregation, colors, names, domain, range, mode = 'count', hiddenGroups = new Set(),
    cutoff = null, guideTime = null, inspectedIndex = null, tasteHighlights, focusedGroup = null, tasteRange = null }) {
    if (this.disposed) return;
    const hiddenKey = JSON.stringify([...hiddenGroups].sort()), previous = this.composition;
    const changed = !previous || previous.model !== model || previous.aggregation !== aggregation || previous.colors !== colors ||
      previous.mode !== mode || previous.hiddenKey !== hiddenKey || previous.focusedGroup !== focusedGroup || !sameRange(this.domain, domain);
    const rangeChanged = !sameRange(this.range, range);
    const overlaysChanged = changed || this.cutoff !== cutoff || this.guideTime !== guideTime || this.inspectedIndex !== inspectedIndex ||
      this.tasteHighlights !== tasteHighlights || this.tasteRange !== tasteRange;
    this.model = model; this.colors = colors; this.names = names; this.domain = { ...domain }; this.range = { ...range };
    this.cutoff = cutoff; this.guideTime = guideTime; this.inspectedIndex = inspectedIndex;
    this.tasteHighlights = tasteHighlights; this.focusedGroup = focusedGroup; this.tasteRange = tasteRange;
    if (!changed && !rangeChanged && !overlaysChanged) return;
    // ECharts setOption performs the complete series update even when only an
    // overlay series changed. Retained ZRender shapes avoid rerunning the bars.
    if (!changed && !rangeChanged) { this.drawOverlays(); return; }
    const option = {};
    if (changed) {
      this.lastInspect = undefined;
      this.composition = { model, aggregation, colors, mode, hiddenKey, focusedGroup };
      this.prepared = timelineChartData(model, aggregation, hiddenGroups, mode, focusedGroup);
      const ink = this.theme.ink ?? '#e8e2d8', muted = this.theme.muted ?? '#9e9486', grid = this.theme.grid ?? '#3b342c';
      Object.assign(option, { animation: false, useUTC: true, backgroundColor: 'transparent',
        textStyle: { color: ink, fontFamily: 'ui-monospace, monospace', fontSize: 10 },
        grid: { left: TIMELINE_CHART_LEFT, right: TIMELINE_CHART_RIGHT, top: GRID_TOP, bottom: GRID_BOTTOM, outerBoundsMode: 'none' },
        xAxis: { type: 'time', min: domain.startMs, max: domain.endMs, boundaryGap: false,
          axisLine: { lineStyle: { color: grid } }, axisTick: { show: false }, splitLine: { show: false },
          axisLabel: { color: muted, hideOverlap: true, fontSize: 10 } },
        yAxis: { type: 'value', min: 0, max: this.prepared.scale.max, interval: this.prepared.scale.ticks[1],
          axisLabel: { color: muted, fontSize: 10, formatter: mode === 'percent' ? '{value}%' : '{value}' },
          axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: grid } } },
        tooltip: { trigger: 'item', renderMode: 'richText', confine: true, transitionDuration: 0,
          backgroundColor: this.theme.panel ?? '#242019', borderColor: grid, borderWidth: 1, padding: 8,
          textStyle: { color: ink, fontSize: 11, lineHeight: 18 }, formatter: params => this.tooltip(params) },
        series: [this.bars()] });
    }
    if (changed || rangeChanged) {
      const zoom = timelineRangePercent(domain, range);
      option.dataZoom = [{ id: 'timeline-inside', type: 'inside', xAxisIndex: 0, filterMode: 'weakFilter',
        ...zoom, throttle: 50, zoomOnMouseWheel: true, moveOnMouseMove: true, moveOnMouseWheel: false },
      { id: 'timeline-zoom', type: 'slider', xAxisIndex: 0, filterMode: 'weakFilter', ...zoom, throttle: 50,
        left: TIMELINE_CHART_LEFT, right: TIMELINE_CHART_RIGHT, bottom: 4, height: 18, showDetail: false,
        showDataShadow: false, brushSelect: false, borderColor: this.theme.grid ?? '#3b342c',
        backgroundColor: 'transparent', fillerColor: 'rgba(255,158,66,.15)',
        handleStyle: { color: this.theme.accent ?? '#ff9e42', borderWidth: 0 },
        moveHandleStyle: { color: this.theme.accent ?? '#ff9e42' }, emphasis: { handleStyle: { color: this.theme.ink ?? '#e8e2d8' } } }];
    }
    this.applying = true;
    try { this.chart.setOption(option, { silent: true, ...(changed ? { replaceMerge: ['series'] } : {}) }); }
    finally { this.applying = false; }
    this.drawOverlays();
  }

  setRange(range) {
    if (!this.domain || this.disposed || sameRange(this.range, range)) return;
    this.range = { ...range }; this.applying = true;
    try { this.chart.dispatchAction({ type: 'dataZoom', ...timelineRangePercent(this.domain, range) }, { silent: true }); }
    finally { this.applying = false; }
    this.drawOverlays();
  }

  hideTooltip() { if (!this.disposed) this.chart.dispatchAction({ type: 'hideTip' }, { silent: true }); }
  resize() {
    if (this.disposed) return;
    const width = this.element.clientWidth, height = this.element.clientHeight;
    if (!(width > 0 && height > 0) || width === this.chart.getWidth() && height === this.chart.getHeight()) return;
    this.chart.resize({ width, height, silent: true }); this.drawOverlays();
  }
  dispose() { if (!this.disposed) { this.disposed = true; this.chart.dispose(); } }
}
