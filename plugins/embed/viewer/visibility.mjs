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
