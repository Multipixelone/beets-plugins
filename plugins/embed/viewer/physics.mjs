import { artworkSizes, pointSizes, seedLayout } from './logic.mjs';

// Cosmos does not reheat on drag and has no persistent alpha-target API.
export const DRAG_ALPHA = 0.8;
export const RELEASE_ALPHA = 0.6;
export function dragAlpha(current, releasing = false) {
  return Math.max(Number.isFinite(current) ? current : 0, releasing ? RELEASE_ALPHA : DRAG_ALPHA);
}

// Optional companion to communityLayout: the coarse springs already carry
// cross-community attraction, while these springs retain every album link.
// Cosmos takes sqrt(raw strength), so .25 halves the physical cross spring.
// Pass 1 for the original force-only layout; this does not affect rendering.
export function communityLinkStrengths(edges, clusters, interCommunityScale = .25) {
  if (!Number.isFinite(interCommunityScale) || interCommunityScale <= 0 || interCommunityScale > 1) {
    throw new Error('Cross-community strength must be positive and no greater than one.');
  }
  const degrees = new Uint32Array(clusters.length);
  for (const { source, target } of edges) { degrees[source]++; degrees[target]++; }
  return Float32Array.from(edges, ({ source, target, weight = 1 }) =>
    weight / Math.max(1, Math.min(degrees[source], degrees[target])) *
      (clusters[source] === clusters[target] ? 1 : interCommunityScale));
}

// Coarse layout is solved only when the graph or artwork geometry changes.
// Native Cosmos springs, collision and per-point cluster forces then keep the
// albums live on the GPU. Camera movement never changes these world positions.
export function communityLayout(albums, edges, clusters, {
  spaceSize = 4096, margin = spaceSize * .1, spacing = 112,
  metric = 'summed_plays', artworkScale = 1, geometryScale = 1, padding = 10,
} = {}) {
  if (!Number.isFinite(geometryScale) || geometryScale <= 0 || !Number.isFinite(padding) || padding < 0) {
    throw new Error('Invalid community geometry.');
  }
  const seeded = seedLayout(albums, edges, clusters, spacing, { spaceSize, margin });
  const positions = seeded.positions;
  const members = [];
  for (let i = 0; i < albums.length; i++) {
    const group = clusters[i];
    if (!Number.isInteger(group) || group < 0 || group >= albums.length) throw new Error('Invalid community index.');
    (members[group] ??= []).push(i);
  }
  const count = members.length;
  const centers = new Float32Array(count * 2), radii = new Float32Array(count);
  const strengths = new Float32Array(albums.length), affinity = new Float32Array(albums.length);
  if (!albums.length) return { ...seeded, centers, radii, strengths, affinity };
  const images = artworkSizes(albums, metric, artworkScale), dots = pointSizes(albums, metric);
  const totals = new Float64Array(albums.length), internal = new Float64Array(albums.length);
  const volumes = new Float64Array(count), connections = new Map();
  for (const { source, target, weight = 1 } of edges) {
    totals[source] += weight; totals[target] += weight;
    const a = clusters[source], b = clusters[target];
    volumes[a] += weight; volumes[b] += weight;
    if (a === b) { internal[source] += weight; internal[target] += weight; }
    else {
      const key = Math.min(a, b) * count + Math.max(a, b);
      connections.set(key, (connections.get(key) ?? 0) + weight);
    }
  }
  for (let i = 0; i < albums.length; i++) {
    affinity[i] = totals[i] ? internal[i] / totals[i] : 1;
    // Mixed-affinity albums can sit in the corridors created by cross-community
    // springs; core albums supply most of the community's restoring force.
    // Edge-free albums need the same seed attraction as community cores:
    // they have no link springs to resist drifting outward and inflating Fit
    // view. They remain movable and still participate in native collision.
    strengths[i] = totals[i] ? .12 + .88 * affinity[i] ** 2 : 1;
  }
  for (let group = 0; group < count; group++) {
    const indices = members[group];
    if (!indices) { centers[group * 2] = centers[group * 2 + 1] = spaceSize / 2; continue; }
    let area = 0;
    for (const i of indices) {
      centers[group * 2] += positions[i * 2] / indices.length;
      centers[group * 2 + 1] += positions[i * 2 + 1] / indices.length;
      // Same selection-frame and square footprint budget as layoutParameters.
      const diameter = (albums[i].cover ? (images[i] + 8) / .8 : dots[i]) * geometryScale + 2 * padding;
      area += diameter ** 2;
    }
    // An area estimate, not a containing circle: bridges and irregular borders
    // remain free to extend outside it. Larger communities get more room.
    radii[group] = Math.sqrt(area / (Math.PI * .72));
  }
  const originalCenters = centers.slice();
  // Isolates keep an attraction to their compact seed. Including thousands
  // of disconnected one-album groups would waste quadratic coarse-layout work.
  const active = members.flatMap((indices, group) => indices && volumes[group] ? [group] : []);
  if (!active.length) return { ...seeded, positions, centers, radii, strengths, affinity, fit: 1 };
  // Only the coarse starting state: a footprint-weighted spiral gives groups
  // room to exchange neighbors in both dimensions. The shelf seed otherwise
  // leaves large groups in rows that the short coarse solve struggles to undo.
  // Unequal footprints start at 55% area occupancy; graph springs decide the
  // final placement, with no circular boundary or prescribed inter-group angle.
  let occupied = 0;
  const ordered = [...active].sort((a, b) => radii[b] - radii[a] || a - b);
  for (const [rank, group] of ordered.entries()) {
    const angle = rank * 2.3999632297, distance = Math.sqrt(occupied / .55);
    centers[group * 2] = spaceSize / 2 + Math.cos(angle) * distance;
    centers[group * 2 + 1] = spaceSize / 2 + Math.sin(angle) * distance;
    occupied += radii[group] ** 2;
  }
  const links = [...connections].map(([key, weight]) => {
    const source = Math.floor(key / count), target = key % count;
    return { source, target, strength: Math.sqrt(weight / Math.sqrt(volumes[source] * volumes[target])) };
  });
  const velocity = new Float64Array(count * 2);
  const force = new Float64Array(count * 2);
  // Bound work for exports with unusually many tiny/disconnected communities.
  const iterations = Math.max(1, Math.min(600, Math.floor(12000000 / Math.max(1, active.length ** 2))));
  for (let step = 0; step < iterations; step++) {
    force.fill(0);
    const cooling = 1 - .8 * step / iterations;
    for (let a = 0; a < active.length; a++) for (let b = a + 1; b < active.length; b++) {
      const i = active[a], j = active[b];
      let dx = centers[i * 2] - centers[j * 2], dy = centers[i * 2 + 1] - centers[j * 2 + 1];
      let distance = Math.hypot(dx, dy);
      if (distance < 1e-6) {
        const angle = (i + j * count) * 2.3999632297;
        dx = Math.cos(angle); dy = Math.sin(angle); distance = 1;
      }
      const footprint = radii[i] + radii[j] + 24 * seeded.spacing / 112;
      const magnitude = Math.max(0, footprint - distance) * .15 +
        Math.min(1, footprint ** 2 / distance ** 2) * 1.5;
      const fx = dx / distance * magnitude, fy = dy / distance * magnitude;
      force[i * 2] += fx; force[i * 2 + 1] += fy;
      force[j * 2] -= fx; force[j * 2 + 1] -= fy;
    }
    for (const { source: i, target: j, strength } of links) {
      const dx = centers[j * 2] - centers[i * 2], dy = centers[j * 2 + 1] - centers[i * 2 + 1];
      const distance = Math.max(1, Math.hypot(dx, dy));
      const rest = (radii[i] + radii[j]) * .9 + 24 * seeded.spacing / 112;
      const magnitude = (distance - rest) * .045 * strength;
      const fx = dx / distance * magnitude, fy = dy / distance * magnitude;
      force[i * 2] += fx; force[i * 2 + 1] += fy;
      force[j * 2] -= fx; force[j * 2 + 1] -= fy;
    }
    for (const group of active) for (let axis = 0; axis < 2; axis++) {
      const i = group * 2 + axis;
      force[i] += (spaceSize / 2 - centers[i]) * .001;
      velocity[i] = (velocity[i] + force[i] * cooling) * .7;
      centers[i] += Math.max(-24, Math.min(24, velocity[i]));
    }
  }
  // A single uniform fit keeps relative center distances and local geometry.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const group of active) {
    minX = Math.min(minX, centers[group * 2] - radii[group]);
    maxX = Math.max(maxX, centers[group * 2] + radii[group]);
    minY = Math.min(minY, centers[group * 2 + 1] - radii[group]);
    maxY = Math.max(maxY, centers[group * 2 + 1] + radii[group]);
  }
  const fit = Math.min(1, (spaceSize - 2 * margin) / Math.max(maxX - minX, maxY - minY));
  const centerX = (minX + maxX) / 2, centerY = (minY + maxY) / 2;
  for (const group of active) {
    centers[group * 2] = spaceSize / 2 + (centers[group * 2] - centerX) * fit;
    centers[group * 2 + 1] = spaceSize / 2 + (centers[group * 2 + 1] - centerY) * fit;
    for (const i of members[group]) {
      positions[i * 2] = centers[group * 2] + (positions[i * 2] - originalCenters[group * 2]) * fit;
      positions[i * 2 + 1] = centers[group * 2 + 1] + (positions[i * 2 + 1] - originalCenters[group * 2 + 1]) * fit;
    }
    radii[group] *= fit;
  }
  return { ...seeded, positions, centers, radii, strengths, affinity, fit };
}
