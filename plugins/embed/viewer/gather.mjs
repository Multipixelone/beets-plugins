// Temporary comparison coordinates never become canonical map coordinates.
const pair = (positions, index) => new Float32Array(positions.slice(index * 2, index * 2 + 2));
const same = (a, b) => a?.[0] === b?.[0] && a?.[1] === b?.[1];
export function gatherGrid(indices, sizes, { center, aspect = 1, spaceSize, margin, gap = 16 }) {
  if (!indices.length) return { positions: new Map(), scale: 1 };
  const columns = Math.min(indices.length, Math.max(1, Math.ceil(Math.sqrt(indices.length * aspect))));
  const rows = Math.ceil(indices.length / columns);
  const pitch = Math.max(...indices.map(i => sizes[i])) + gap;
  const available = spaceSize - 2 * margin;
  const scale = Math.min(1, available / (columns * pitch), available / (rows * pitch));
  const step = pitch * scale, width = columns * step, height = rows * step;
  const cx = Math.max(margin + width / 2, Math.min(spaceSize - margin - width / 2, center[0]));
  const cy = Math.max(margin + height / 2, Math.min(spaceSize - margin - height / 2, center[1]));
  return { scale, positions: new Map(indices.map((index, rank) => {
    const row = Math.floor(rank / columns), col = rank % columns;
    const rowCount = Math.min(columns, indices.length - row * columns);
    // Map Y increases upward; highest scores read left-to-right, top-to-bottom.
    return [index, new Float32Array([cx + (col - (rowCount - 1) / 2) * step, cy + ((rows - 1) / 2 - row) * step])];
  })) };
}

export class GatherPositions {
  constructor() { this.saved = new Map(); this.members = new Set(); this.transitions = new Map(); }
  get active() { return this.members.size > 0; }
  canonical(current) {
    const positions = Float32Array.from(current);
    for (const [index, saved] of this.saved) positions.set(saved, index * 2);
    return positions;
  }
  reconcile(indices, current, targets, now, duration = 450) {
    const wanted = new Set(indices);
    for (const index of this.members) if (!wanted.has(index)) this.returnOne(index, current, now, duration);
    for (const index of indices) {
      const from = pair(current, index), to = targets.get(index);
      if (!to || ![...from].every(Number.isFinite)) continue;
      if (!this.saved.has(index)) this.saved.set(index, from.slice());
      if (!this.members.has(index) || !same(this.transitions.get(index)?.to, to)) {
        this.transitions.set(index, { from, to, now, duration });
      }
    }
    this.members = new Set(indices.filter(i => this.saved.has(i)));
  }
  returnOne(index, current, now, duration = 450) {
    if (!this.saved.has(index)) return;
    this.members.delete(index);
    this.transitions.set(index, { from: pair(current, index), to: this.saved.get(index), now, duration });
  }
  end(current, now, duration = 450) {
    for (const index of this.members) this.returnOne(index, current, now, duration);
  }
  drag(index) { this.transitions.delete(index); }
  // Canonical saving runs before this; filter-hidden members need no visible return animation.
  forgetHidden(visible) {
    for (const index of this.saved.keys()) if (!visible[index]) {
      this.saved.delete(index); this.members.delete(index); this.transitions.delete(index);
    }
  }
  frame(now) {
    const positions = new Map(), restored = [];
    for (const [index, move] of this.transitions) {
      const t = move.duration ? Math.max(0, Math.min(1, (now - move.now) / move.duration)) : 1;
      const eased = t < .5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
      positions.set(index, t === 1 ? move.to.slice() : Float32Array.from(move.from, (value, i) => value + (move.to[i] - value) * eased));
      if (t === 1) {
        this.transitions.delete(index);
        if (!this.members.has(index)) { this.saved.delete(index); restored.push(index); }
      }
    }
    return { positions, restored };
  }
}
