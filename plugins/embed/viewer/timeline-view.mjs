import { createTimelineGeometry } from './timeline-geometry.mjs';
import { aggregateTimeline, periodIndexForCutoff, cutoffForTimelineKey, nearestTimelineCutoff } from './timeline-aggregation.mjs';
import { TimelineChart, TIMELINE_CHART_LEFT, TIMELINE_CHART_RIGHT } from './timeline-chart.mjs';
import { rebinTimeline, timelineExplorerRange } from './timeline-explorer.mjs';
import { createBookmarkRail } from './timeline-bookmarks.mjs';

const DAY = 86400000, THUMB_INSET = 8;
const date = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const month = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', timeZone: 'UTC' });
const number = value => value.toLocaleString();
const percent = value => `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
const isoDay = value => new Date(value).toISOString().slice(0, 10);
const period = (bin, model) => model.unit === 'month' ? month.format(bin.start) : model.unit === 'year' ?
  String(new Date(bin.start).getUTCFullYear()) : model.unit === 'week' ? `${date.format(bin.start)}–${date.format(bin.end - 1)}` : date.format(bin.start);

export class TimelineView {
  constructor({ document, onSelect, onScrub, onCancel, onAnnounce, onRange, theme }) {
    this.document = document; this.onSelect = onSelect; this.onScrub = onScrub;
    this.onCancel = onCancel; this.onAnnounce = onAnnounce; this.onRange = onRange; this.theme = theme;
    this.$ = id => document.getElementById(id);
    this.stage = this.$('timeline-stage'); this.canvas = this.$('timeline-histogram'); this.playhead = this.$('timeline-playhead');
    this.hoverIndex = this.keyboardIndex = this.guideTime = null; this.hiddenGroups = new Set();
    for (const id of ['timeline-group', 'timeline-interval', 'timeline-mode']) this.$(id).addEventListener('change', () => {
      if (id === 'timeline-group') this.hiddenGroups = new Set();
      this.rebuild();
    });
    this.$('timeline-zoom-in').addEventListener('click', () => this.zoom(.5));
    this.$('timeline-zoom-out').addEventListener('click', () => this.zoom(2));
    this.$('timeline-reset-zoom').addEventListener('click', () => this.setRange(this.domain));
    for (const id of ['timeline-from', 'timeline-through']) this.$(id).addEventListener('change', () => {
      const startMs = Date.parse(`${this.$('timeline-from').value}T00:00:00Z`);
      const endMs = Date.parse(`${this.$('timeline-through').value}T00:00:00Z`) + DAY;
      this.$('timeline-through').setCustomValidity(startMs >= endMs ? 'Choose an end date on or after the start date.' : '');
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && startMs < endMs) this.setRange({ startMs, endMs });
    });
    this.$('timeline-filter-range').addEventListener('click', () => { if (this.ready) this.onRange({ ...this.range }); });
    this.$('timeline-clear-range').addEventListener('click', () => this.onRange(null));
    this.$('timeline-show-groups').addEventListener('click', () => { this.hiddenGroups = new Set(); this.refreshComposition(); });
    this.$('timeline-breakdown').addEventListener('toggle', () => {
      if (this.$('timeline-breakdown').open) this.renderBreakdown();
    });
    this.canvas.addEventListener('focus', () => {
      if (!this.model?.bins.length) return;
      this.keyboardIndex = Math.max(0, periodIndexForCutoff(this.model, this.cutoff)); this.renderInspection();
    });
    this.canvas.addEventListener('blur', () => { this.keyboardIndex = this.hoverIndex = null; this.hideTooltips(); this.renderInspection(); });
    this.canvas.addEventListener('keydown', event => {
      if (!this.ready || !this.model?.bins.length || !['ArrowLeft', 'ArrowRight', 'Enter'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const index = this.keyboardIndex ?? Math.max(0, periodIndexForCutoff(this.model, this.cutoff));
      if (event.key === 'Enter') this.selectPeriod(index);
      else {
        this.hoverIndex = null;
        this.keyboardIndex = Math.max(0, Math.min(this.model.bins.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1)));
        this.renderInspection();
      }
    });
    this.playhead.addEventListener('input', event => {
      if (this.snapshotGeometry) this.onScrub(nearestTimelineCutoff(this.baseModel, this.snapshotGeometry, Number(event.target.value)));
    });
    this.playhead.addEventListener('change', event => {
      if (!this.snapshotGeometry) return;
      this.onSelect(nearestTimelineCutoff(this.baseModel, this.snapshotGeometry, Number(event.target.value))); this.onAnnounce();
    });
    this.playhead.addEventListener('pointercancel', () => this.cancelGesture());
    this.playhead.addEventListener('keydown', event => {
      if (!this.ready || !this.baseModel) return;
      const cutoff = cutoffForTimelineKey(event.key, this.cutoff, this.baseModel);
      if (cutoff === undefined || event.key === 'Escape') return;
      event.preventDefault(); event.stopPropagation(); this.onSelect(cutoff); this.onAnnounce();
    });
  }

  reset() {
    this.unmountRail(); this.chart?.dispose(); this.chart = undefined;
    this.baseModel = this.model = this.geometry = this.snapshotGeometry = this.aggregation = this.domain = this.range = undefined;
    this.hoverIndex = this.keyboardIndex = this.guideTime = null; this.hiddenGroups = new Set();
    this.summaryAggregation = undefined; this.legendAggregation = undefined;
    this.modelBase = this.activeGrouping = this.inspectionGroups = this.breakdownGroups = this.breakdownHidden = undefined;
    this.hideTooltips();
  }

  cancelGesture() { this.onCancel(); this.hoverIndex = null; this.hideTooltips(); this.renderInspection(); this.renderPlayhead(); }

  update({ model, groupings, cutoff, ready, snapshotCount, shownCount, rangeFilter }) {
    const changed = this.baseModel !== model || this.groupings !== groupings;
    this.baseModel = model; this.groupings = groupings; this.cutoff = cutoff; this.ready = ready;
    this.rangeFilter = rangeFilter;
    const bins = model.bins, count = model.total;
    this.$('timeline-empty').hidden = !!bins.length; this.$('timeline-controls').hidden = !bins.length;
    this.$('timeline-latest').disabled = !ready;
    this.$('timeline-latest').setAttribute('aria-pressed', String(cutoff === null));
    this.$('timeline-scope').textContent = `${number(count)} albums in this export · ${number(model.undated)} undated · Current metadata and similarities`;
    this.playhead.disabled = !ready || !bins.length; this.canvas.tabIndex = ready && bins.length ? 0 : -1;
    this.$('timeline-filter-range').disabled = !ready;
    const before = bins.length && cutoff !== null && cutoff <= bins[0].start;
    const label = cutoff === null ? 'Latest' : before ? `Before ${date.format(cutoff)} UTC` : `Through ${date.format(cutoff - 1)} UTC`;
    this.$('timeline-compact').textContent = cutoff === null ? 'Latest' : `Snapshot: ${before ? 'Before ' : ''}${date.format(before ? cutoff : cutoff - 1)}`;
    const readout = `${label} · Snapshot ${number(snapshotCount)} / ${number(count)} · Shown on map ${number(shownCount)} / ${number(count)}`;
    this.readoutChanged = this.$('timeline-readout').textContent !== readout;
    this.$('timeline-readout').textContent = readout; this.playhead.setAttribute('aria-valuetext', readout);
    this.$('timeline-clear-range').hidden = !rangeFilter;
    if (!bins.length || !groupings?.size) return;
    if (changed) {
      this.domain = timelineExplorerRange(model);
      if (!this.range) this.range = { ...this.domain };
      this.rebuild();
    } else { this.measure(); this.renderPlayhead(); this.renderInspection(); this.updateRail(); this.renderRange(); }
  }

  rebuild() {
    if (!this.baseModel?.bins.length || !this.groupings?.size) return;
    const candidate = rebinTimeline(this.baseModel, { unit: this.$('timeline-interval').value, ...this.range });
    const grouping = this.groupings.get(this.$('timeline-group').value);
    if (!grouping) return;
    // Panning within the same calendar boundaries changes pixels, not counts.
    const sameBins = this.modelBase === this.baseModel && this.model?.unit === candidate.unit &&
      this.model.bins.length === candidate.bins.length && this.model.bins[0]?.start === candidate.bins[0]?.start &&
      this.model.bins.at(-1)?.end === candidate.bins.at(-1)?.end;
    this.model = sameBins ? this.model : candidate;
    this.colors = grouping.colors; this.names = grouping.names;
    if (!sameBins || this.activeGrouping !== grouping) {
      this.aggregation = aggregateTimeline(this.model, grouping.values, grouping.order);
      this.hoverIndex = this.keyboardIndex = null;
    }
    this.modelBase = this.baseModel; this.activeGrouping = grouping;
    this.geometry = undefined;
    this.$('timeline-measure').textContent = `${this.$('timeline-mode').value === 'percent' ? 'Album share' : 'Albums'} by ${this.model.unit}`;
    this.canvas.setAttribute('aria-label', `${this.$('timeline-measure').textContent}. Left and Right inspect a period; Enter selects its snapshot.`);
    const peak = this.aggregation.peakIndex >= 0 ? this.model.bins[this.aggregation.peakIndex] : null;
    this.$('timeline-peak').textContent = peak ? `Peak: ${period(peak, this.model)} · ${number(peak.count)} albums` : 'No dated albums in this window';
    this.renderLegend(); this.measure(); this.renderPlayhead(); this.renderInspection(); this.renderRange();
  }

  setRange(range) {
    if (!range || !this.domain) return;
    let startMs = Math.max(this.domain.startMs, Math.min(this.domain.endMs - 1, range.startMs));
    let endMs = Math.min(this.domain.endMs, Math.max(startMs + 1, range.endMs));
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;
    if (this.range?.startMs === startMs && this.range?.endMs === endMs) return;
    this.range = { startMs, endMs }; this.hideTooltips(); this.rebuild();
  }

  zoom(factor) {
    if (!this.range) return;
    const width = Math.min(this.domain.endMs - this.domain.startMs, Math.max(DAY, (this.range.endMs - this.range.startMs) * factor));
    const center = (this.range.startMs + this.range.endMs) / 2;
    const startMs = Math.max(this.domain.startMs, Math.min(this.domain.endMs - width, center - width / 2));
    this.setRange({ startMs, endMs: startMs + width });
  }

  measure() {
    if (!this.model?.bins.length || !this.aggregation || !this.stage.clientWidth || this.$('timeline').hidden) return;
    const width = this.stage.clientWidth;
    if (!this.geometry || this.viewportWidth !== width) {
      this.viewportWidth = width;
      this.geometry = createTimelineGeometry({ domainStartMs: this.range.startMs, domainEndMs: this.range.endMs,
        bins: this.model.bins.map(bin => ({ startMs: Math.max(bin.start, this.range.startMs), endMs: Math.min(bin.end, this.range.endMs) })),
        minBinPx: Number.EPSILON, viewportWidth: width, plotPadding: { left: TIMELINE_CHART_LEFT, right: TIMELINE_CHART_RIGHT } });
      this.snapshotGeometry = createTimelineGeometry({ domainStartMs: this.domain.startMs, domainEndMs: this.domain.endMs,
        bins: this.baseModel.bins.map(bin => ({ startMs: bin.start, endMs: bin.end })), minBinPx: Number.EPSILON,
        viewportWidth: width, thumbInset: THUMB_INSET });
    }
    if (!this.chart) this.chart = new TimelineChart({ element: this.canvas, theme: this.theme,
      onZoom: range => this.setRange(range), onInspect: index => { this.hoverIndex = index; this.renderInspection(); },
      onSelect: index => this.selectPeriod(index) });
    this.chart.resize(); this.draw(); this.updateRail();
  }

  selectPeriod(index) {
    if (!this.ready || !this.model?.bins[index]) return;
    this.keyboardIndex = this.hoverIndex = null;
    this.onSelect(Math.min(this.domain.endMs, this.model.bins[index].end)); this.onAnnounce();
  }

  renderPlayhead() {
    if (!this.baseModel?.bins.length) return;
    this.playhead.min = this.domain.startMs; this.playhead.max = this.domain.endMs;
    this.playhead.value = this.cutoff ?? this.domain.endMs;
  }

  renderRange() {
    if (!this.range) return;
    this.$('timeline-from').value = isoDay(this.range.startMs);
    this.$('timeline-through').value = isoDay(this.range.endMs - 1);
    for (const id of ['timeline-from', 'timeline-through']) {
      this.$(id).min = isoDay(this.domain.startMs); this.$(id).max = isoDay(this.domain.endMs - 1);
    }
    this.$('timeline-through').setCustomValidity('');
    this.$('timeline-range-readout').textContent = this.rangeFilter ?
      `Map filtered to ${date.format(this.rangeFilter.startMs)}–${date.format(this.rangeFilter.endMs - 1)} UTC · Chart zoom is independent` :
      'Wheel or pinch to zoom · Drag to pan · Select a period for its snapshot';
  }

  toggleGroup(name) {
    this.hiddenGroups = new Set(this.hiddenGroups);
    if (this.hiddenGroups.has(name)) this.hiddenGroups.delete(name); else this.hiddenGroups.add(name);
    this.refreshComposition();
  }

  refreshComposition() {
    const focused = this.document.activeElement, group = focused?.dataset.timelineGroup;
    const container = focused?.closest('#timeline-legend, #timeline-community-table')?.id;
    this.summaryAggregation = undefined; this.legendAggregation = undefined;
    this.renderLegend(); this.renderInspection();
    if (group !== undefined && container) {
      [...this.$(container).querySelectorAll('button')].find(button => button.dataset.timelineGroup === group)?.focus({ preventScroll: true });
    }
  }

  groupButton(name, label) {
    const button = this.document.createElement('button'); button.type = 'button';
    button.dataset.timelineGroup = name;
    button.setAttribute('aria-pressed', String(!this.hiddenGroups.has(name)));
    button.append(this.swatch(name), this.document.createTextNode(label));
    button.addEventListener('click', () => this.toggleGroup(name)); return button;
  }

  renderLegend() {
    if (!this.aggregation || this.legendAggregation === this.aggregation) return;
    this.legendAggregation = this.aggregation;
    const legend = this.$('timeline-legend'); legend.replaceChildren();
    for (const { name, count } of this.aggregation.majorCommunities) {
      const item = this.document.createElement('li');
      item.append(this.groupButton(name, `${this.names.get(name) ?? name} · ${number(count)}`)); legend.append(item);
    }
    this.$('timeline-legend-heading').textContent = `Top groups in this window · ${number(this.aggregation.communities.length)} total · Select to toggle${this.$('timeline-group').value === 'cluster' ? ' · Map colors' : ''}`;
    this.$('timeline-show-groups').hidden = !this.hiddenGroups.size;
  }

  swatch(name) {
    const swatch = this.document.createElement('span'); swatch.className = 'timeline-swatch';
    swatch.style.backgroundColor = this.colors.get(name); swatch.setAttribute('aria-hidden', 'true'); return swatch;
  }

  renderInspection() {
    if (!this.model?.bins.length || !this.aggregation) return;
    const index = this.hoverIndex ?? this.keyboardIndex ?? periodIndexForCutoff(this.model, this.cutoff);
    this.$('timeline-bin-summary').setAttribute('aria-live', this.keyboardIndex === null ? 'off' : 'polite');
    if (this.summaryIndex !== index || this.summaryAggregation !== this.aggregation) {
      this.summaryIndex = index; this.summaryAggregation = this.aggregation;
      const bin = this.model.bins[index], allGroups = this.aggregation.breakdowns[index] ?? [];
      const groups = allGroups.filter(group => !this.hiddenGroups.has(group.name));
      const total = groups.reduce((sum, group) => sum + group.count, 0);
      this.$('timeline-bin-summary').textContent = bin ? `${period(bin, this.model)} UTC · ${number(total)} albums${total !== bin.count ? ` (${number(bin.count)} including hidden groups)` : ''}` : 'Snapshot outside this window';
      const top = this.$('timeline-bin-groups'); top.replaceChildren();
      for (const group of groups.slice(0, 3)) {
        const row = this.document.createElement('li');
        row.append(this.swatch(group.name), this.document.createTextNode(`${this.names.get(group.name) ?? group.name} · ${number(group.count)} · ${percent(group.count / total * 100)}`)); top.append(row);
      }
      const remaining = groups.slice(3);
      this.$('timeline-remaining').textContent = remaining.length ?
        `${number(remaining.length)} remaining groups · ${number(remaining.reduce((sum, group) => sum + group.count, 0))} albums` : groups.length ? '' : '0 albums';
      this.inspectionGroups = allGroups; this.inspectionTotal = total;
      this.$('timeline-breakdown').hidden = !allGroups.length;
      this.renderBreakdown();
    }
    this.draw();
  }

  renderBreakdown() {
    if (!this.$('timeline-breakdown').open || !this.inspectionGroups ||
        this.breakdownGroups === this.inspectionGroups && this.breakdownHidden === this.hiddenGroups) return;
    this.breakdownGroups = this.inspectionGroups; this.breakdownHidden = this.hiddenGroups;
    const table = this.$('timeline-community-table'); table.replaceChildren();
    for (const group of this.inspectionGroups) {
      const row = this.document.createElement('tr'), name = this.document.createElement('th'); name.scope = 'row';
      name.append(this.groupButton(group.name, this.names.get(group.name) ?? group.name));
      const count = this.document.createElement('td'); count.textContent = number(group.count);
      const share = this.document.createElement('td'); share.textContent = this.hiddenGroups.has(group.name) ? 'Hidden' : percent(group.count / this.inspectionTotal * 100);
      row.append(name, count, share); table.append(row);
    }
  }

  draw() {
    if (!this.geometry || !this.aggregation || !this.chart || this.$('timeline').hidden) return;
    this.chart.update({ model: this.model, aggregation: this.aggregation, colors: this.colors, names: this.names,
      domain: this.domain, range: this.range, mode: this.$('timeline-mode').value, hiddenGroups: this.hiddenGroups,
      cutoff: this.cutoff, inspectedIndex: this.hoverIndex ?? this.keyboardIndex, guideTime: this.guideTime });
  }

  ensureTimeVisible(time) {
    if (!this.range || time === null || time >= this.range.startMs && time <= this.range.endMs) return;
    const width = this.range.endMs - this.range.startMs;
    const startMs = Math.max(this.domain.startMs, Math.min(this.domain.endMs - width, time - width / 2));
    this.setRange({ startMs, endMs: startMs + width });
  }

  updateRail() {
    if (!this.geometry || this.$('timeline').hidden) return;
    const container = this.$('timeline-bookmarks'); container.inert = !this.ready;
    if (this.railGeometry !== this.geometry) {
      this.railGeometry = this.geometry;
      this.visibleBookmarks = this.baseModel.bookmarks.filter(bookmark => bookmark.start < this.range.endMs &&
        (bookmark.end === null ? bookmark.start : bookmark.end + DAY) >= this.range.startMs);
    }
    const options = { geometry: this.geometry, bookmarks: this.visibleBookmarks, selectedCutoff: this.cutoff };
    if (!this.rail) {
      this.rail = createBookmarkRail({ ...options, container, tooltipLayer: this.$('timeline-tooltip-layer'),
        onSelect: cutoff => { this.onSelect(cutoff); this.onAnnounce(); },
        onGuide: time => { this.guideTime = time; this.draw(); } });
      this.railOptions = options;
    } else if (this.railOptions.geometry !== options.geometry || this.railOptions.selectedCutoff !== options.selectedCutoff) {
      this.railOptions = options; this.rail.update(options);
    }
  }

  unmountRail() {
    this.rail?.destroy(); this.rail = undefined; this.railOptions = undefined; this.railGeometry = undefined;
    this.guideTime = null;
  }

  hideTooltips() { this.chart?.hideTooltip(); this.$('timeline-period-tooltip').hidden = true; this.guideTime = null; }
}
