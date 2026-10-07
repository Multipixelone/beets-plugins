// Keep stable indices and saved finite coordinates; NaN makes Cosmos skip forces.
export class FilterPositions {
  constructor(count) {
    this.saved = new Float32Array(count * 2).fill(NaN);
    this.visible = new Uint8Array(count).fill(1);
  }
  seed(positions) { this.saved.set(positions); }
  update(current, visible) {
    if (visible.every((value, i) => Number(value) === this.visible[i])) return null;
    for (let i = 0; i < this.visible.length; i++) {
      if (this.visible[i] && Number.isFinite(current[i * 2]) && Number.isFinite(current[i * 2 + 1])) {
        this.saved[i * 2] = current[i * 2]; this.saved[i * 2 + 1] = current[i * 2 + 1];
      }
    }
    this.visible = Uint8Array.from(visible, Number);
    return Float32Array.from(this.saved, (coordinate, i) => this.visible[Math.floor(i / 2)] ? coordinate : NaN);
  }
}

export function visibleLinks(edges, visible, mode, selected) {
  const eligible = edges.flatMap((edge, i) => visible[edge.source] && visible[edge.target] ? [i] : []);
  if (mode === 'all') return new Set(eligible);
  if (mode === 'selected') return new Set(eligible.filter(i => edges[i].source === selected || edges[i].target === selected));
  const strongest = new Map();
  for (const i of eligible) for (const endpoint of [edges[i].source, edges[i].target]) {
    const previous = strongest.get(endpoint);
    if (previous === undefined || edges[i].similarity > edges[previous].similarity) strongest.set(endpoint, i);
  }
  return new Set(strongest.values());
}

const linkScore = edge => Number.isFinite(edge.similarity) ? edge.similarity : edge.weight ?? 0;
const eligibleLink = (edge, visible) => !visible || !!visible[edge.source] && !!visible[edge.target];
const endpointOrder = (a, b) => Math.min(a.source, a.target) - Math.min(b.source, b.target) ||
  Math.max(a.source, a.target) - Math.max(b.source, b.target);

// One representative connection per community pair preserves the coarse sound
// network without drawing all the parallel edges through its bridge corridors.
export function bridgeLinks(edges, clusters, visible) {
  const pairs = new Map();
  edges.forEach((edge, index) => {
    if (!eligibleLink(edge, visible)) return;
    const a = clusters[edge.source], b = clusters[edge.target];
    if (a === undefined || b === undefined || a === b) return;
    const key = JSON.stringify([a, b].sort((x, y) => String(x).localeCompare(String(y))));
    const previous = pairs.get(key);
    if (previous === undefined || linkScore(edge) > linkScore(edges[previous]) ||
        linkScore(edge) === linkScore(edges[previous]) && endpointOrder(edge, edges[previous]) < 0) pairs.set(key, index);
  });
  return new Set(pairs.values());
}

// Sizes are CSS pixels, independent of display DPR. Only visual emphasis changes
// with zoom; every focus-incident link remains available, including weak ones.
export function edgeStyles(edges, { clusters = [], visible, mode = 'strongest', selected, hovered,
    coverPixels = 16, bridges = bridgeLinks(edges, clusters, visible), strongest, detailLimit = 6 } = {}) {
  const colors = new Float32Array(edges.length * 4), widths = new Float32Array(edges.length);
  const focus = Number.isInteger(hovered) && (!visible || visible[hovered]) ? hovered :
    Number.isInteger(selected) && (!visible || visible[selected]) ? selected : undefined;
  const incident = new Set(), detail = new Set(), points = new Set(focus === undefined ? [] : [focus]);
  if (!strongest) {
    const best = new Map();
    edges.forEach((edge, index) => {
      if (!eligibleLink(edge, visible)) return;
      for (const endpoint of [edge.source, edge.target]) {
        const previous = best.get(endpoint);
        if (previous === undefined || linkScore(edge) > linkScore(edges[previous]) ||
            linkScore(edge) === linkScore(edges[previous]) && endpointOrder(edge, edges[previous]) < 0) best.set(endpoint, index);
      }
    });
    strongest = new Set(best.values());
  }
  if (focus !== undefined) {
    edges.forEach((edge, index) => {
      if (eligibleLink(edge, visible) && (edge.source === focus || edge.target === focus)) {
        incident.add(index); points.add(edge.source); points.add(edge.target);
      }
    });
    [...incident].sort((a, b) => linkScore(edges[b]) - linkScore(edges[a]) || endpointOrder(edges[a], edges[b]))
      .slice(0, Math.max(0, detailLimit)).forEach(index => detail.add(index));
  }
  const amount = Math.max(0, Math.min(1, (Number.isFinite(coverPixels) ? coverPixels - 10 : 0) / 62));
  const close = amount * amount * (3 - 2 * amount);
  edges.forEach((edge, index) => {
    if (!eligibleLink(edge, visible)) return;
    let rgb = [0.36, 0.45, 0.54], opacity, width;
    if (incident.has(index)) {
      if (detail.has(index)) {
        rgb = [0.62, 0.73, 0.82]; opacity = 0.3 + 0.4 * close; width = 0.65 + 0.65 * close;
      } else {
        rgb = [0.43, 0.53, 0.62]; opacity = 0.09 + 0.12 * close; width = 0.45 + 0.3 * close;
      }
    } else if (mode === 'selected') return;
    else if (bridges.has(index)) {
      rgb = [0.47, 0.58, 0.66]; opacity = 0.23 + 0.1 * close; width = 0.65 + 0.2 * close;
    } else if (strongest.has(index)) {
      opacity = 0.1 + 0.12 * close; width = 0.5 + 0.2 * close;
    } else if (mode === 'all') {
      opacity = 0.045 + 0.055 * close; width = 0.4 + 0.15 * close;
    } else return;
    if (focus !== undefined && !incident.has(index)) opacity *= 0.45;
    colors.set([...rgb, opacity], index * 4); widths[index] = width;
  });
  return { colors, widths, focus, incident, detail, points };
}
