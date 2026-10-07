// Temporary comparison coordinates never become canonical map coordinates.
const pair = (positions, index) => new Float32Array(positions.slice(index * 2, index * 2 + 2));
const same = (a, b) => a?.[0] === b?.[0] && a?.[1] === b?.[1];
export function gatherRings(indices, sizes, { center, spaceSize, margin, gap = 16 } = {}) {
  if (!indices.length) return { positions: new Map(), scale: 1, radius: 0, center };
  const diameter = Math.max(...indices.map(i => sizes[i]));
  // The diagonal clearance keeps upright square covers apart at every angle.
  const pitch = diameter * Math.SQRT2 + gap, offsets = new Map();
  let rank = 0, ring = 1, outer = 0;
  if (indices.length === 1 || indices.length > 6) offsets.set(indices[rank++], [0, 0]);
  while (rank < indices.length) {
    const radius = pitch * ring;
    const count = Math.min(indices.length - rank, Math.floor(Math.PI / Math.asin(pitch / (2 * radius)) + 1e-9));
    for (let slot = 0; slot < count; slot++) {
      const angle = Math.PI / 2 + slot * Math.PI * 2 / count + (ring % 2 ? 0 : Math.PI / count);
      offsets.set(indices[rank++], [Math.cos(angle) * radius, Math.sin(angle) * radius]);
    }
    outer = radius; ring++;
  }
  // Reserve the outer half of the map for the moving, unmatched albums.
  const scale = Math.min(1, (spaceSize - margin * 2) * .25 / (outer + diameter / 2));
  const radius = (outer + diameter / 2) * scale;
  const origin = center.map(value => Math.max(margin + radius, Math.min(spaceSize - margin - radius, value)));
  return { center: origin, radius, scale, positions: new Map([...offsets].map(([index, offset]) =>
    [index, Float32Array.from(offset, (value, axis) => origin[axis] + value * scale)])) };
}

export class GatherPositions {
  constructor() {
    this.saved = new Map(); this.members = new Set(); this.transitions = new Map();
    this.orbit = undefined; this.angle = 0; this.lastFrame = undefined;
  }
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
    this.orbit = undefined;
  }
  setOrbit(layout, now) { this.orbit = layout; this.angle = 0; this.lastFrame = now; }
  orbitPosition(index) {
    const point = this.orbit?.positions.get(index);
    if (!point) return;
    const [cx, cy] = this.orbit.center, x = point[0] - cx, y = point[1] - cy;
    const c = Math.cos(this.angle), s = Math.sin(this.angle);
    return new Float32Array([cx + x * c - y * s, cy + x * s + y * c]);
  }
  drag(index) { this.transitions.delete(index); }
  release(index, current, now, duration = 450) {
    const to = this.orbitPosition(index);
    if (this.members.has(index) && to) this.transitions.set(index, { from: pair(current, index), to, now, duration });
    else this.returnOne(index, current, now, duration);
  }
  // Canonical saving runs before this; filter-hidden members need no visible return animation.
  forgetHidden(visible) {
    for (const index of this.saved.keys()) if (!visible[index]) {
      this.saved.delete(index); this.members.delete(index); this.transitions.delete(index);
    }
  }
  frame(now, { rotate = false, dragIndex } = {}) {
    const positions = new Map(), restored = [];
    if (rotate && this.orbit && this.lastFrame !== undefined) {
      // Clamp elapsed time so returning from a background tab never jumps.
      this.angle = (this.angle + Math.max(0, Math.min(50, now - this.lastFrame)) * .000045) % (Math.PI * 2);
    }
    this.lastFrame = now;
    if (this.orbit) for (const index of this.members) {
      if (index !== dragIndex) positions.set(index, this.orbitPosition(index));
    }
    for (const [index, move] of this.transitions) {
      if (index === dragIndex) continue;
      const to = positions.get(index) ?? move.to;
      const t = move.duration ? Math.max(0, Math.min(1, (now - move.now) / move.duration)) : 1;
      const eased = t < .5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
      positions.set(index, t === 1 ? to.slice() : Float32Array.from(move.from, (value, i) => value + (to[i] - value) * eased));
      if (t === 1) {
        this.transitions.delete(index);
        if (!this.members.has(index)) { this.saved.delete(index); restored.push(index); }
      }
    }
    return { positions, restored };
  }
}
