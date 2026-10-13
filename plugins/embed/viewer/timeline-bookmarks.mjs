import { BOOKMARK_CATEGORIES, bookmarkLabel, bookmarkLayout } from './timeline.mjs';
import { BOOKMARK_DAY, bookmarkRailLayout, bookmarkCutoff, bookmarkDetails, bookmarkTooltipPlacement } from './timeline-bookmark-layout.mjs';

// Only these local, static SVG paths and CSS palette keys reach the DOM.
const GLYPHS = {
  house: 'M3 11 12 3l9 8M5 10v11h14V10M10 21v-7h4v7',
  book: 'M12 5v16M12 5C9 3 5 3 3 4v15c3-1 6-1 9 2 3-3 6-3 9-2V4c-2-1-6-1-9 1',
  case: 'M8 7V4h8v3M3 7h18v13H3ZM3 12h18M10 12v3h4v-3',
  stage: 'M3 4h18v16H3ZM7 4v8l-4 4M17 4v8l4 4M8 20v-4h8v4',
  ticket: 'M3 6h18v4a2 2 0 0 0 0 4v4H3v-4a2 2 0 0 0 0-4ZM15 6v3m0 2v2m0 2v3',
  compass: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M16 8l-3 5-5 3 3-5Z',
  cross: 'M9 3h6v6h6v6h-6v6H9v-6H3V9h6Z',
  heart: 'M12 21 3 12C-2 5 7-1 12 6c5-7 14-1 9 6Z',
  people: 'M8 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6M16 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6M2 21v-4a6 6 0 0 1 12 0v4M14 12a6 6 0 0 1 8 5v4',
  note: 'M9 18V5l11-2v13M9 5v4l11-2M9 18a3 3 0 1 1-3-3h3M20 16a3 3 0 1 1-3-3h3',
  flag: 'M5 22V3h14l-3 4 3 4H5',
  circle: 'M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14'
};

let railSequence = 0;

/** Mount into the shared scrollable content stage; overlay nodes use viewport coordinates. */
export function createBookmarkRail({ container, tooltipLayer, geometry, bookmarks = [], selectedCutoff = null,
  onSelect, onGuide = () => {} }) {
  const document = container.ownerDocument, view = document.defaultView;
  const prefix = `ag-bookmark-${++railSequence}`, cleanup = [];
  const element = (tag, className, parent) => {
    const node = document.createElement(tag); node.className = className;
    parent?.append(node); return node;
  };
  const listen = (node, type, callback, options) => {
    node.addEventListener(type, callback, options);
    cleanup.push(() => node.removeEventListener(type, callback, options));
  };
  const rail = element('div', 'ag-bookmark-rail', container);
  rail.setAttribute('role', 'group'); rail.setAttribute('aria-label', 'Important dates');
  const tooltip = element('div', 'ag-bookmark-tooltip', tooltipLayer);
  tooltip.id = `${prefix}-tooltip`; tooltip.setAttribute('role', 'tooltip'); tooltip.hidden = true;
  const list = element('div', 'ag-bookmark-list', tooltipLayer);
  list.id = `${prefix}-list`; list.setAttribute('role', 'dialog');
  list.setAttribute('aria-label', 'Important dates in this cluster'); list.hidden = true;
  let layout, records = new Map(), openRecord = null, hovered = null, focused = null;
  let selectedId = null, disposed = false, lastGuide;

  const selected = () => bookmarks.find(bookmark => bookmark.id === selectedId && bookmarkCutoff(bookmark) === selectedCutoff) ??
    bookmarks.find(bookmark => bookmarkCutoff(bookmark) === selectedCutoff);
  const recordFor = bookmark => [...records.values()].find(record => record.item.events.some(event => event.id === bookmark.id));
  const source = record => ({ bookmark: record.item.events.find(event => event.id === selected()?.id) ?? record.item.events[0],
    target: record.button });
  const svgNode = (tag, attributes, parent, bookmark) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (bookmark) {
      const [, palette] = Object.hasOwn(BOOKMARK_CATEGORIES, bookmark.category) ? BOOKMARK_CATEGORIES[bookmark.category] : BOOKMARK_CATEGORIES.other;
      node.style.setProperty('--bookmark-color', `var(--community-${palette})`);
    }
    parent.append(node); return node;
  };
  let lines, activeLines;
  const anchor = (bookmark, parent, showDot = true, showSpan = true) => {
    const x = geometry.xForTime(bookmark.start);
    const approximate = bookmark.precision !== 'day';
    if (showSpan && bookmark.end !== null) {
      const end = geometry.xForTime(bookmark.end + BOOKMARK_DAY), y = layout.anchorY - 3;
      svgNode('path', { class: `ag-bookmark-span${approximate ? ' ag-bookmark-approximate' : ''}`,
        d: `M${x} ${y - 2}V${y + 2}M${x} ${y}H${end}M${end} ${y - 2}V${y + 2}` }, parent, bookmark);
    }
    if (showDot) svgNode('circle', { class: `ag-bookmark-anchor${approximate ? ' ag-bookmark-approximate' : ''}`,
      cx: x, cy: layout.anchorY, r: 2.5, 'data-bookmark-id': bookmark.id }, parent, bookmark);
  };
  const viewport = () => ({ width: view.visualViewport?.width ?? view.innerWidth,
    height: view.visualViewport?.height ?? view.innerHeight });
  const positionOverlay = (node, target, size) => {
    const bounds = target.getBoundingClientRect(), screen = viewport();
    if (bounds.right <= 0 || bounds.left >= screen.width || bounds.bottom <= 0 || bounds.top >= screen.height) {
      node.hidden = true; return;
    }
    const placement = bookmarkTooltipPlacement(bounds, screen, size);
    node.hidden = !placement;
    if (!placement) return;
    node.style.left = `${placement.left}px`; node.style.top = `${placement.top}px`;
    node.style.width = `${placement.width}px`; node.style.maxHeight = `${placement.height}px`;
  };
  function refresh() {
    if (disposed) return;
    const selection = selected(), record = selection && recordFor(selection);
    const active = hovered ?? focused ?? (record ? { bookmark: selection, target: record.button } : null);
    const time = active?.bookmark.start ?? null;
    if (time !== lastGuide) { lastGuide = time; onGuide(time); }
    activeLines?.replaceChildren();
    if (active && activeLines) anchor(active.bookmark, activeLines);
    tooltip.hidden = true;
    if (active && !openRecord) {
      tooltip.textContent = bookmarkDetails(active.bookmark);
      // Measure wrapping before selecting a free rectangle outside the target.
      tooltip.style.width = `${Math.min(320, viewport().width - 16)}px`;
      tooltip.style.maxHeight = 'none'; tooltip.hidden = false;
      const measured = tooltip.getBoundingClientRect();
      positionOverlay(tooltip, active.target, { width: measured.width, height: measured.height });
    }
    if (openRecord) positionOverlay(list, openRecord.button, { width: Math.min(360, viewport().width - 16),
      height: Math.min(viewport().height - 16, openRecord.item.events.length * 60 + 64) });
  }
  function closeList(restoreFocus) {
    if (!openRecord) return;
    const trigger = openRecord.button;
    openRecord = null; list.hidden = true; list.replaceChildren();
    trigger.setAttribute('aria-expanded', 'false'); focused = null; hovered = null;
    if (restoreFocus && rail.contains(trigger)) trigger.focus({ preventScroll: true });
    refresh();
  }
  function activate(bookmark, fromList) {
    if (disposed) return;
    selectedCutoff = bookmarkCutoff(bookmark); selectedId = bookmark.id;
    if (fromList) closeList(true);
    for (const record of records.values()) record.button.setAttribute('aria-current',
      record.item.events.some(event => bookmarkCutoff(event) === selectedCutoff) ? 'date' : 'false');
    refresh(); onSelect(selectedCutoff);
  }
  function openList(record) {
    if (disposed) return;
    if (openRecord === record) { closeList(true); return; }
    closeList(false); openRecord = record; hovered = null; list.scrollTop = 0;
    record.button.setAttribute('aria-expanded', 'true');
    const heading = element('div', 'ag-bookmark-list-heading', list);
    element('strong', '', heading).textContent = 'Important dates';
    const close = element('button', 'ag-bookmark-list-close', heading);
    close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', 'Close important dates');
    close.addEventListener('click', () => closeList(true));
    const ordered = element('ol', '', list);
    for (const bookmark of record.item.events) {
      const row = element('li', '', ordered), button = element('button', 'ag-bookmark-entry', row);
      button.type = 'button'; button.setAttribute('aria-label', bookmarkDetails(bookmark));
      element('strong', '', button).textContent = bookmark.title;
      const dates = bookmark.end_date === null ? bookmark.date : `${bookmark.date}–${bookmark.end_date}`;
      const precision = bookmark.precision === 'day' ? '' : bookmark.precision === 'approximate' ?
        ' · Approximate date' : ` · Approximate ${bookmark.precision}`;
      element('span', '', button).textContent = `${dates} UTC${precision}`;
      button.setAttribute('data-bookmark-id', bookmark.id);
      const entry = { bookmark, target: button };
      button.addEventListener('focus', () => { focused = entry; refresh(); });
      button.addEventListener('pointerenter', () => { hovered = entry; refresh(); });
      button.addEventListener('pointerleave', () => { if (hovered === entry) hovered = null; refresh(); });
      button.addEventListener('blur', () => { if (focused === entry) focused = null; queueMicrotask(refresh); });
      button.addEventListener('click', () => activate(bookmark, true));
    }
    refresh(); ordered.children[0]?.children[0]?.focus({ preventScroll: true });
  }
  function render() {
    const priorFocus = focused?.bookmark.id;
    const openIds = openRecord?.item.events.map(event => event.id);
    layout = bookmarkRailLayout(geometry, bookmarks);
    container.hidden = !layout.items.length;
    rail.style.width = `${Math.max(44, geometry.contentWidth)}px`; rail.style.height = `${layout.height}px`;
    lines?.remove();
    lines = svgNode('svg', { class: 'ag-bookmark-lines', width: geometry.contentWidth, height: layout.height,
      viewBox: `0 0 ${Math.max(44, geometry.contentWidth)} ${Math.max(1, layout.height)}`, 'aria-hidden': 'true' }, rail);
    // Transparent glyphs stay legible when an upper lane's leader crosses them.
    // Only leaders use this mask; exact date anchors and ranges remain intact.
    const maskId = `${prefix}-leaders`, mask = svgNode('mask', { id: maskId, maskUnits: 'userSpaceOnUse',
      x: 0, y: 0, width: Math.max(44, geometry.contentWidth), height: Math.max(1, layout.height) }, svgNode('defs', {}, lines));
    svgNode('rect', { width: Math.max(44, geometry.contentWidth), height: Math.max(1, layout.height), fill: 'white', stroke: 'none' }, mask);
    for (const item of layout.items) svgNode('circle', { cx: item.left + 22, cy: item.lane * 44 + 22,
      r: 13, fill: 'black', stroke: 'none' }, mask);
    const newRecords = new Map(), drawnDates = new Set();
    for (const item of layout.items) {
      let record = records.get(item.key);
      if (!record) {
        const button = element('button', 'ag-bookmark-target', rail);
        button.type = 'button'; button.setAttribute('aria-describedby', tooltip.id);
        record = { button, item };
        button.addEventListener('focus', () => {
          button.scrollIntoView({ block: 'nearest', inline: 'nearest' }); focused = source(record); refresh();
        });
        button.addEventListener('blur', () => { if (focused?.target === button) focused = null; queueMicrotask(refresh); });
        button.addEventListener('pointerenter', () => { hovered = source(record); refresh(); });
        button.addEventListener('pointerleave', () => { if (hovered?.target === button) hovered = null; refresh(); });
        button.addEventListener('click', () => record.item.clustered ? openList(record) : activate(record.item.events[0], false));
      }
      record.item = item; newRecords.set(item.key, record);
      const { button } = record, bookmark = item.events[0];
      const [glyph, palette] = Object.hasOwn(BOOKMARK_CATEGORIES, bookmark.category) ? BOOKMARK_CATEGORIES[bookmark.category] : BOOKMARK_CATEGORIES.other;
      button.style.setProperty('--bookmark-color', item.clustered ? 'var(--muted)' : `var(--community-${palette})`);
      button.style.left = `${item.left}px`; button.style.top = `${item.lane * 44}px`;
      button.setAttribute('aria-current', item.events.some(event => bookmarkCutoff(event) === selectedCutoff) ? 'date' : 'false');
      button.setAttribute('aria-label', item.clustered ? `${item.events.length} important dates, ${bookmark.date} to ${item.events.at(-1).date}. Open chronological list` : bookmarkDetails(bookmark));
      button.replaceChildren(); const badge = element('span', 'ag-bookmark-badge', button);
      badge.setAttribute('aria-hidden', 'true');
      if (item.clustered) {
        badge.textContent = String(item.events.length);
        button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-controls', list.id);
        button.setAttribute('aria-expanded', String(openRecord === record));
      } else {
        const icon = svgNode('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, badge);
        svgNode('path', { d: GLYPHS[glyph] }, icon);
      }
      const center = item.left + 22, top = item.lane * 44 + 35, bend = (top + layout.anchorY) / 2;
      const approximate = item.events.some(event => event.precision !== 'day');
      svgNode('path', { class: `ag-bookmark-leader${approximate ? ' ag-bookmark-approximate' : ''}`,
        mask: `url(#${maskId})`,
        d: Math.abs(center - item.x) < .01 ? `M${center} ${top}V${layout.anchorY}` :
          `M${center} ${top}V${bend}H${item.x}V${layout.anchorY}`,
        'data-elbow': String(Math.abs(center - item.x) >= .01) }, lines, item.clustered ? null : bookmark);
      if (item.clustered && item.firstX !== item.lastX) {
        svgNode('path', { class: 'ag-bookmark-bracket',
          d: `M${item.firstX} ${layout.anchorY - 3}V${layout.anchorY}H${item.lastX}V${layout.anchorY - 3}` }, lines);
      } else {
        // A shared dot is hollow if any event at that date is approximate;
        // interacting with an event overlays its own exact precision.
        const representative = bookmarks.find(event => event.start === bookmark.start && event.precision !== 'day') ?? bookmark;
        anchor(representative, lines, !drawnDates.has(bookmark.start), false);
        drawnDates.add(bookmark.start);
      }
      for (const event of item.events) if (event.end !== null) anchor(event, lines, false);
    }
    for (const [key, record] of records) if (!newRecords.has(key)) record.button.remove();
    records = newRecords;
    // Reconcile chronological tab order only when grouping or data changes.
    const targets = new Set([...records.values()].map(record => record.button));
    for (const [index, record] of [...records.values()].entries()) {
      const current = [...rail.children].filter(node => targets.has(node))[index];
      if (current !== record.button) rail.insertBefore(record.button, current ?? lines);
    }
    activeLines = svgNode('g', { class: 'ag-bookmark-active-anchor' }, lines);
    if (openRecord && !records.has(openRecord.item.key)) {
      closeList(false);
      const replacement = [...records.values()].find(record => openIds.some(id => record.item.events.some(event => event.id === id)));
      replacement?.button.focus({ preventScroll: true });
    }
    if (focused?.target && !rail.contains(focused.target) && !list.contains(focused.target)) focused = null;
    if (hovered?.target && !rail.contains(hovered.target) && !list.contains(hovered.target)) hovered = null;
    if (priorFocus && (!focused || document.activeElement !== focused.target)) {
      recordFor(bookmarks.find(bookmark => bookmark.id === priorFocus) ?? { id: priorFocus })?.button.focus({ preventScroll: true });
    }
    if (focused && rail.contains(focused.target)) {
      const record = [...records.values()].find(record => record.button === focused.target);
      if (record) focused = source(record);
    }
    refresh();
  }
  listen(document, 'keydown', event => {
    if (event.key !== 'Escape') return;
    if (openRecord) { event.preventDefault(); event.stopPropagation(); closeList(true); }
    else if (rail.contains(event.target)) { tooltip.hidden = true; focused = null; hovered = null; }
  }, true);
  listen(document, 'pointerdown', event => {
    if (openRecord && !list.contains(event.target) && !openRecord.button.contains(event.target)) closeList(false);
  }, true);
  listen(document, 'focusin', event => {
    if (openRecord && !list.contains(event.target) && !openRecord.button.contains(event.target)) closeList(false);
  });
  listen(document, 'scroll', refresh, true); listen(view, 'resize', refresh);
  if (view.visualViewport) { listen(view.visualViewport, 'resize', refresh); listen(view.visualViewport, 'scroll', refresh); }
  for (const node of [rail, list]) for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click', 'wheel', 'touchstart', 'touchmove', 'touchend']) {
    listen(node, type, event => event.stopPropagation(), { passive: true });
  }
  render();
  return {
    update(next) {
      if (disposed) return;
      if (Object.hasOwn(next, 'geometry')) geometry = next.geometry;
      if (Object.hasOwn(next, 'bookmarks')) {
        if (bookmarks !== next.bookmarks) closeList(true);
        bookmarks = next.bookmarks;
      }
      if (Object.hasOwn(next, 'selectedCutoff')) {
        if (next.selectedCutoff !== selectedCutoff) selectedId = null;
        selectedCutoff = next.selectedCutoff;
      }
      render();
    },
    destroy() {
      if (disposed) return;
      disposed = true; cleanup.forEach(remove => remove());
      rail.remove(); tooltip.remove(); list.remove(); container.hidden = true; onGuide(null);
    }
  };
}

// Retained until the separately owned app integration switches to createBookmarkRail.
export class TimelineBookmarks {
  constructor(root, onSelect) {
    this.root = root;
    this.track = root.querySelector('.timeline-bookmark-track');
    this.tooltip = root.querySelector('[role=tooltip]');
    this.onSelect = onSelect;
    this.buttons = [];
  }

  reset(model) {
    this.model = model;
    this.buttons = [];
    this.track.replaceChildren();
    this.hideLabel();
    this.root.hidden = !model?.bookmarks.length;
    if (this.root.hidden) return;
    const document = this.root.ownerDocument;
    for (const bookmark of model.bookmarks) {
      const [glyph, palette] = BOOKMARK_CATEGORIES[bookmark.category];
      const marker = document.createElement('button');
      marker.type = 'button'; marker.className = 'timeline-bookmark'; marker.disabled = true;
      marker.classList.toggle('approximate', bookmark.precision !== 'day');
      marker.style.setProperty('--bookmark-color', `var(--community-${palette})`);
      marker.setAttribute('aria-label', bookmarkLabel(bookmark));
      marker.setAttribute('aria-describedby', this.tooltip.id);
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', GLYPHS[glyph]); svg.append(path); marker.append(svg);
      const show = () => {
        this.tooltip.textContent = bookmarkLabel(bookmark); this.tooltip.hidden = false;
        this.positionLabel();
      };
      marker.addEventListener('pointerenter', show);
      marker.addEventListener('pointerleave', () => {
        if (document.activeElement !== marker) this.hideLabel();
      });
      marker.addEventListener('focus', () => {
        marker.scrollIntoView({ block: 'nearest', inline: 'nearest' }); show();
      });
      marker.addEventListener('blur', () => this.hideLabel());
      marker.addEventListener('click', () => this.onSelect(bookmark));
      let range;
      if (bookmark.end !== null) {
        range = document.createElement('span'); range.className = 'timeline-bookmark-range';
        range.classList.toggle('approximate', bookmark.precision !== 'day');
        range.style.setProperty('--bookmark-color', `var(--community-${palette})`);
        range.setAttribute('aria-hidden', 'true'); this.track.append(range);
      }
      this.track.append(marker); this.buttons.push({ marker, range });
    }
  }

  positionLabel() {
    if (this.tooltip.hidden) return;
    const tray = this.root.closest('#timeline').getBoundingClientRect();
    const view = this.root.ownerDocument.defaultView;
    this.tooltip.style.left = `${tray.left + 12}px`;
    this.tooltip.style.right = `${view.innerWidth - tray.right + 12}px`;
    this.tooltip.style.bottom = `${view.innerHeight - tray.top + 4}px`;
  }

  hideLabel() { this.tooltip.hidden = true; this.tooltip.textContent = ''; }

  update(position, ready) {
    for (const [index, { marker }] of this.buttons.entries()) {
      marker.disabled = !ready;
      const bookmark = this.model.bookmarks[index];
      const current = position !== null && this.model.bins[position] &&
        bookmark.start >= this.model.bins[position].start && bookmark.start < this.model.bins[position].end;
      marker.setAttribute('aria-current', current ? 'date' : 'false');
    }
    this.layout();
  }

  layout() {
    if (this.root.hidden) return;
    const { markers, height } = bookmarkLayout(this.model, this.track.getBoundingClientRect().width);
    if (!markers.length) return; // Docked: retain controls and focus until expanded.
    this.track.style.height = `${height}px`;
    markers.forEach(({ lane, left, rangeLeft, rangeWidth }, index) => {
      const { marker, range } = this.buttons[index];
      marker.style.left = `${left}px`; marker.style.top = `${lane * 44}px`;
      if (range) {
        range.style.left = `${rangeLeft}px`; range.style.width = `${rangeWidth}px`;
        range.style.top = `${lane * 44 + 32}px`;
      }
    });
    const focused = this.buttons.find(({ marker }) => marker === this.root.ownerDocument.activeElement)?.marker;
    this.positionLabel();
    focused?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}
