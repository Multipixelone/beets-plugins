import { createTimelineGeometry } from './timeline-geometry.mjs';
import { periodIndexForCutoff, cutoffForTimelineKey, nearestTimelineCutoff, OTHER_COMMUNITIES } from './timeline-aggregation.mjs';
import { drawTimelineHistogram, timelineTicks, TIMELINE_PLOT_HEIGHT } from './timeline-chart.mjs';
import { createBookmarkRail } from './timeline-bookmarks.mjs';

const THUMB_INSET = 8, TAP_DISTANCE = 6;
const date = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const month = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', timeZone: 'UTC' });
const number = value => value.toLocaleString();
const percent = value => `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
const period = (bin, model) => model.unit === 'month' ? month.format(bin.start) : model.unit === 'year' ?
  `${new Date(bin.start).getUTCFullYear()}${model.step > 1 ? `–${new Date(bin.end - 1).getUTCFullYear()}` : ''}` : date.format(bin.start);

export class TimelineView {
  constructor({ document, onSelect, onScrub, onCancel, onAnnounce, theme }) {
    this.document = document; this.onSelect = onSelect; this.onScrub = onScrub;
    this.onCancel = onCancel; this.onAnnounce = onAnnounce; this.theme = theme;
    this.$ = id => document.getElementById(id);
    this.stage = this.$('timeline-stage'); this.content = this.$('timeline-stage-content');
    this.canvas = this.$('timeline-histogram'); this.playhead = this.$('timeline-playhead');
    this.hoverIndex = this.keyboardIndex = this.guideTime = null;
    this.stage.addEventListener('scroll', () => {
      this.tap = undefined;
      this.hoverIndex = null; this.renderInspection();
      this.$('timeline-period-tooltip').hidden = true;
    }, { passive: true });
    this.canvas.addEventListener('pointermove', event => {
      if (this.tap && Math.hypot(event.clientX - this.tap.x, event.clientY - this.tap.y) > TAP_DISTANCE) this.tap.moved = true;
      if (!this.geometry || event.pointerType === 'touch' || event.buttons) return;
      this.hoverIndex = this.indexForClientX(event.clientX);
      this.renderInspection(); this.showPeriodTooltip(event);
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.hoverIndex = null; this.$('timeline-period-tooltip').hidden = true; this.renderInspection();
    });
    this.canvas.addEventListener('pointerdown', event => {
      if (!this.ready || !this.geometry || event.button !== 0) return;
      // Native scrolling owns pans. Only an unmoved pointerup activates a bin.
      this.tap = { id: event.pointerId, x: event.clientX, y: event.clientY, scroll: this.stage.scrollLeft };
    });
    this.canvas.addEventListener('pointerup', event => {
      const tap = this.tap; this.tap = undefined;
      if (!tap || tap.moved || tap.id !== event.pointerId || Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > TAP_DISTANCE ||
          Math.abs(this.stage.scrollLeft - tap.scroll) > 1) return;
      const index = this.indexForClientX(event.clientX);
      if (index < 0) return;
      this.hoverIndex = this.keyboardIndex = null;
      this.onSelect(this.model.bins[index].end); this.onAnnounce();
    });
    this.canvas.addEventListener('pointercancel', () => this.cancelGesture());
    this.canvas.addEventListener('focus', () => {
      if (!this.model?.bins.length) return;
      this.keyboardIndex = Math.max(0, periodIndexForCutoff(this.model, this.cutoff)); this.renderInspection();
    });
    this.canvas.addEventListener('blur', () => {
      this.keyboardIndex = this.hoverIndex = null; this.$('timeline-period-tooltip').hidden = true; this.renderInspection();
    });
    this.canvas.addEventListener('keydown', event => {
      if (!this.ready || !this.model?.bins.length || !['ArrowLeft', 'ArrowRight', 'Enter'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const index = this.keyboardIndex ?? Math.max(0, periodIndexForCutoff(this.model, this.cutoff));
      if (event.key === 'Enter') { this.onSelect(this.model.bins[index].end); this.onAnnounce(); }
      else {
        this.hoverIndex = null;
        this.keyboardIndex = Math.max(0, Math.min(this.model.bins.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1)));
        this.ensureTimeVisible(this.model.bins[this.keyboardIndex].start);
        this.renderInspection();
      }
    });
    this.playhead.addEventListener('input', event => {
      if (this.geometry) this.onScrub(nearestTimelineCutoff(this.model, this.geometry, Number(event.target.value)));
    });
    this.playhead.addEventListener('change', event => {
      if (!this.geometry) return;
      this.onSelect(nearestTimelineCutoff(this.model, this.geometry, Number(event.target.value))); this.onAnnounce();
    });
    this.playhead.addEventListener('pointercancel', () => this.cancelGesture());
    this.playhead.addEventListener('keydown', event => {
      if (!this.ready || !this.model) return;
      const cutoff = cutoffForTimelineKey(event.key, this.cutoff, this.model);
      if (cutoff === undefined || event.key === 'Escape') return; // Rail and tray own Escape.
      event.preventDefault(); event.stopPropagation();
      this.onSelect(cutoff); this.ensureTimeVisible(cutoff); this.onAnnounce();
    });
  }

  reset() {
    this.unmountRail();
    this.model = this.geometry = this.aggregation = undefined;
    this.hoverIndex = this.keyboardIndex = this.guideTime = null; this.tap = undefined;
    this.summaryAggregation = undefined; this.legendAggregation = undefined;
    this.$('timeline-period-tooltip').hidden = true;
    this.$('timeline-stage').scrollLeft = 0;
  }

  cancelGesture() {
    this.tap = undefined; this.onCancel();
    this.hoverIndex = null; this.$('timeline-period-tooltip').hidden = true; this.renderInspection();
    this.renderPlayhead();
  }

  update({ model, aggregation, colors, names, cutoff, ready, snapshotCount, shownCount }) {
    this.model = model; this.aggregation = aggregation; this.colors = colors; this.names = names;
    this.cutoff = cutoff; this.ready = ready;
    const bins = model.bins, count = model.total;
    this.$('timeline-empty').hidden = !!bins.length; this.$('timeline-controls').hidden = !bins.length;
    this.$('timeline-latest').disabled = !ready;
    this.$('timeline-latest').setAttribute('aria-pressed', String(cutoff === null));
    this.$('timeline-scope').textContent = `${number(count)} albums in this export · ${number(model.undated)} undated · Current metadata and similarities`;
    this.playhead.disabled = !ready || !bins.length; this.canvas.tabIndex = ready && bins.length ? 0 : -1;
    const before = bins.length && cutoff !== null && cutoff <= bins[0].start;
    const label = cutoff === null ? 'Latest' : before ? `Before ${date.format(cutoff)} UTC` : `Through ${date.format(cutoff - 1)} UTC`;
    this.$('timeline-compact').textContent = cutoff === null ? 'Latest' : `Snapshot: ${before ? 'Before ' : ''}${date.format(before ? cutoff : cutoff - 1)}`;
    const readout = `${label} · Snapshot ${number(snapshotCount)} / ${number(count)} · Shown on map ${number(shownCount)} / ${number(count)}`;
    this.readoutChanged = this.$('timeline-readout').textContent !== readout;
    this.$('timeline-readout').textContent = readout; this.playhead.setAttribute('aria-valuetext', readout);
    if (!bins.length || !aggregation) return;
    const unit = model.unit === 'year' && model.step > 1 ? `${model.step}-year period` : model.unit;
    this.$('timeline-measure').textContent = `Albums by ${unit}`;
    this.canvas.setAttribute('aria-label', `Albums by ${unit}. Left and Right inspect a period; Enter selects its snapshot.`);
    const peak = aggregation.peakIndex >= 0 ? bins[aggregation.peakIndex] : null;
    this.$('timeline-peak').textContent = peak ? `Peak: ${period(peak, model)} · ${number(peak.count)} albums` : 'No dated albums';
    this.renderLegend(); this.measure(); this.renderPlayhead(); this.renderInspection(); this.updateRail();
  }

  measure() {
    if (!this.model?.bins.length || !this.aggregation || !this.stage.clientWidth) return;
    const width = this.stage.clientWidth;
    if (!this.geometry || this.viewportWidth !== width) {
      const first = !this.geometry;
      this.viewportWidth = width;
      this.geometry = createTimelineGeometry({ domainStartMs: this.model.bins[0].start, domainEndMs: this.model.bins.at(-1).end,
        bins: this.model.bins.map(bin => ({ startMs: bin.start, endMs: bin.end })), viewportWidth: width,
        plotPadding: { left: 16, right: 16 }, thumbInset: THUMB_INSET });
      this.content.style.width = `${this.geometry.contentWidth}px`;
      this.canvas.style.width = `${this.geometry.contentWidth}px`;
      this.playhead.style.left = `${this.geometry.plot.left - THUMB_INSET}px`;
      this.playhead.style.width = `${this.geometry.plot.width + 2 * THUMB_INSET}px`;
      this.renderAxis(); this.renderPlayhead();
      if (first && this.cutoff === null) this.stage.scrollLeft = this.geometry.contentWidth - width;
    }
    this.updateRail();
    this.$('timeline-y-axis').style.top = `${this.canvas.offsetTop}px`;
    this.draw();
  }

  renderAxis() {
    const axis = this.$('timeline-axis'); axis.replaceChildren();
    for (const tick of timelineTicks(this.model, this.geometry, this.viewportWidth)) {
      const element = this.document.createElement('span'); element.className = `timeline-tick ${tick.edge}`;
      element.dataset.time = tick.time; element.style.left = `${this.geometry.xForTime(tick.time)}px`;
      element.textContent = tick.label; axis.append(element);
    }
    const yAxis = this.$('timeline-y-axis'); yAxis.replaceChildren();
    for (const value of this.aggregation.scale.ticks) {
      const label = this.document.createElement('span'); label.textContent = number(value);
      label.style.top = `${TIMELINE_PLOT_HEIGHT * (1 - value / this.aggregation.scale.max)}px`; yAxis.append(label);
    }
  }

  renderPlayhead() {
    if (!this.model?.bins.length) return;
    this.playhead.min = this.model.bins[0].start; this.playhead.max = this.model.bins.at(-1).end;
    this.playhead.value = this.cutoff ?? this.model.bins.at(-1).end;
    if (!this.geometry) return;
    const marker = this.$('timeline-selection'); marker.hidden = this.cutoff === null;
    if (this.cutoff !== null) marker.style.left = `${this.geometry.xForTime(this.cutoff)}px`;
  }

  renderLegend() {
    if (this.legendAggregation === this.aggregation) return;
    this.legendAggregation = this.aggregation;
    const legend = this.$('timeline-legend'); legend.replaceChildren();
    const items = this.aggregation.majorCommunities.map(group => ({ name: group.name, label: this.names.get(group.name) ?? group.name }));
    if (this.aggregation.otherCount) items.push({ name: OTHER_COMMUNITIES, label: 'Other communities (combined)' });
    for (const { name, label } of items) {
      const item = this.document.createElement('li'); item.append(this.swatch(name), this.document.createTextNode(label)); legend.append(item);
    }
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
      const bin = this.model.bins[index], groups = this.aggregation.breakdowns[index] ?? [];
      this.$('timeline-bin-summary').textContent = bin ? `${period(bin, this.model)} UTC · ${number(bin.count)} albums` : 'Before the first interval · 0 albums';
      const top = this.$('timeline-bin-groups'); top.replaceChildren();
      for (const group of groups.slice(0, 3)) {
        const row = this.document.createElement('li');
        row.append(this.swatch(group.name), this.document.createTextNode(`${this.names.get(group.name) ?? group.name} · ${number(group.count)} · ${percent(group.percent)}`)); top.append(row);
      }
      const remaining = groups.slice(3);
      this.$('timeline-remaining').textContent = remaining.length ?
        `${number(remaining.length)} remaining ${remaining.length === 1 ? 'community' : 'communities'} · ${number(remaining.reduce((sum, group) => sum + group.count, 0))} albums` :
        groups.length ? 'No remaining communities' : '0 albums';
      const table = this.$('timeline-community-table'); table.replaceChildren();
      for (const group of groups) {
        const row = this.document.createElement('tr'), name = this.document.createElement('th'); name.scope = 'row';
        name.append(this.swatch(group.name), this.document.createTextNode(this.names.get(group.name) ?? group.name));
        const count = this.document.createElement('td'); count.textContent = number(group.count);
        const share = this.document.createElement('td'); share.textContent = percent(group.percent); row.append(name, count, share); table.append(row);
      }
      this.$('timeline-breakdown').hidden = !groups.length;
    }
    this.draw();
  }

  draw() {
    if (!this.geometry || !this.aggregation) return;
    drawTimelineHistogram(this.canvas, { geometry: this.geometry, model: this.model, aggregation: this.aggregation,
      colors: this.colors, cutoff: this.cutoff, inspectedIndex: this.hoverIndex ?? this.keyboardIndex, guideTime: this.guideTime,
      ink: this.theme.ink, accent: this.theme.accent, grid: this.theme.grid, devicePixelRatio: this.document.defaultView.devicePixelRatio || 1 });
  }

  indexForClientX(clientX) {
    return this.geometry.binIndexForX(this.geometry.clientToContentX(clientX, this.stage.getBoundingClientRect(), this.stage.scrollLeft));
  }

  ensureTimeVisible(time) {
    if (!this.geometry || time === null) return;
    const x = this.geometry.xForTime(time), margin = 30;
    if (x < this.stage.scrollLeft + margin) this.stage.scrollLeft = Math.max(0, x - margin);
    else if (x > this.stage.scrollLeft + this.stage.clientWidth - margin) this.stage.scrollLeft = x - this.stage.clientWidth + margin;
  }

  showPeriodTooltip(event) {
    const tooltip = this.$('timeline-period-tooltip'), bin = this.model.bins[this.hoverIndex];
    if (!bin) { tooltip.hidden = true; return; }
    tooltip.textContent = `${period(bin, this.model)} UTC · ${number(bin.count)} albums. Select to show the cumulative snapshot.`;
    tooltip.hidden = false;
    const view = this.document.defaultView, rect = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(view.innerWidth - rect.width - 8, event.clientX + 12))}px`;
    tooltip.style.top = `${Math.max(8, event.clientY - rect.height - 12)}px`;
  }

  updateRail() {
    if (!this.geometry || this.$('timeline').hidden) return;
    const container = this.$('timeline-bookmarks'); container.inert = !this.ready;
    const options = { geometry: this.geometry, bookmarks: this.model.bookmarks, selectedCutoff: this.cutoff };
    if (!this.rail) {
      this.rail = createBookmarkRail({ ...options, container, tooltipLayer: this.$('timeline-tooltip-layer'),
        onSelect: cutoff => { this.onSelect(cutoff); this.onAnnounce(); },
        onGuide: time => { this.guideTime = time; this.draw(); } });
      this.railOptions = options;
    } else if (this.railOptions.geometry !== options.geometry || this.railOptions.bookmarks !== options.bookmarks ||
        this.railOptions.selectedCutoff !== options.selectedCutoff) {
      this.railOptions = options; this.rail.update(options);
    }
  }

  unmountRail() {
    this.rail?.destroy(); this.rail = undefined; this.railOptions = undefined;
    this.guideTime = null;
  }

  hideTooltips() {
    this.$('timeline-period-tooltip').hidden = true;
    this.guideTime = null; this.draw();
  }
}
