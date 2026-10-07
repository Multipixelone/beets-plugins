// Visual scoring is independent of filter visibility and simulation geometry.
export function vibeAppearance(score) {
  if (!Number.isFinite(score) || score < 0.5) return { match: false, size: 1, opacity: 0.15, brightness: 1 };
  const strength = Math.max(0, Math.min(1, (score - 0.5) / 3.5));
  return { match: true, size: 1.15 + 0.85 * strength, opacity: 0.7 + 0.3 * strength,
    brightness: 1.05 + 0.2 * strength };
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
