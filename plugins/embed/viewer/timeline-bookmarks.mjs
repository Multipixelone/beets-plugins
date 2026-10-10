import { BOOKMARK_CATEGORIES, bookmarkLabel, bookmarkLayout } from './timeline.mjs';

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
  note: 'M9 18V5l11-2v13M9 5v4l11-2M9 18a3 3 0 1 1-3-3h3M20 16a3 3 0 1 1-3-3h3',
  flag: 'M5 22V3h14l-3 4 3 4H5',
  circle: 'M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14'
};

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
    focused?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}
