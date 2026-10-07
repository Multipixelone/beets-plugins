export const EMPHASIS_SIZE_MIN = 1.15, EMPHASIS_SIZE_RANGE = 0.85;
export const EMPHASIS_OPACITY_MIN = 0.70, EMPHASIS_OPACITY_RANGE = 0.30;
export const EMPHASIS_BACKGROUND_OPACITY = 0.15;
export const GATHER_SIZE_MULTIPLIER = 1.35;
export const GATHER_BACKGROUND_OPACITY = 0.40;
export const GATHER_TRANSITION_MS = 450;

// Visual scoring is independent of filter visibility and simulation geometry.
export function vibeAppearance(score) {
  if (!Number.isFinite(score) || score < 0.5) return { match: false, size: 1, opacity: EMPHASIS_BACKGROUND_OPACITY, brightness: 1 };
  const strength = Math.max(0, Math.min(1, (score - 0.5) / 3.5));
  return { match: true, size: EMPHASIS_SIZE_MIN + EMPHASIS_SIZE_RANGE * strength,
    opacity: EMPHASIS_OPACITY_MIN + EMPHASIS_OPACITY_RANGE * strength,
    brightness: 1.05 + 0.2 * strength };
}

// Display-only factors: layout uses the final footprint, never an in-flight size.
export class GatherAppearance {
  constructor() { this.sizes = new Map(); this.transitions = new Map(); this.background = 0; }
  size(index) { return this.sizes.get(index) ?? 1; }
  opacity(state, vibeActive) {
    if (!state?.visible) return 0;
    return vibeActive && !state.match ? state.opacity +
      (GATHER_BACKGROUND_OPACITY - EMPHASIS_BACKGROUND_OPACITY) * this.background : state.opacity;
  }
  set(indices, scale, now, duration = GATHER_TRANSITION_MS) {
    this.frame(now);
    const wanted = new Set(indices);
    const targets = new Map([...this.sizes.keys(), ...this.transitions.keys(), ...indices]
      .filter(index => index !== -1).map(index => [index, wanted.has(index) ? scale * GATHER_SIZE_MULTIPLIER : 1]));
    targets.set(-1, indices.length ? 1 : 0);
    for (const [index, to] of targets) {
      const from = index === -1 ? this.background : this.size(index);
      if (this.transitions.get(index)?.to === to) continue;
      if (from === to) { this.transitions.delete(index); continue; }
      this.transitions.set(index, { from, to, now, duration });
    }
    this.frame(now);
  }
  frame(now) {
    for (const [index, move] of this.transitions) {
      const t = move.duration ? Math.max(0, Math.min(1, (now - move.now) / move.duration)) : 1;
      const eased = t < .5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
      const value = t === 1 ? move.to : move.from + (move.to - move.from) * eased;
      if (index === -1) this.background = value;
      else if (value === 1) this.sizes.delete(index);
      else this.sizes.set(index, value);
      if (t === 1) this.transitions.delete(index);
    }
  }
}

export function vibeLinkOpacity(edge, states) {
  const source = states[edge.source], target = states[edge.target];
  return source?.visible && target?.visible ? Math.min(source.opacity, target.opacity) : 0;
}

// Fit the entire footprint, not just its center; also gives single matches useful bounds.
export function matchBounds(indices, positions, sizes) {
  let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
  for (const i of indices) {
    const x = positions[i * 2], y = positions[i * 2 + 1], radius = Math.max(1, sizes[i] / 2);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    left = Math.min(left, x - radius); right = Math.max(right, x + radius);
    bottom = Math.min(bottom, y - radius); top = Math.max(top, y + radius);
  }
  return left === Infinity ? null : new Float32Array([left, bottom, right, top]);
}
