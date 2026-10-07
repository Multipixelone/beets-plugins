// Small bridge to the hash-guarded Cosmos 3.4.2 adapter. Visual sizes must not
// change collision forces when a phrase is applied or cleared.
export class VibeGraph {
  constructor(graph) { this.graph = graph; }
  collisionSizes(sizes) {
    const previous = this.graph.graph.albumCollisionSizes;
    if (previous?.length === sizes.length && sizes.every((size, i) => size === previous[i])) return;
    this.graph.graph.albumCollisionSizes = Float32Array.from(sizes);
    this.graph.isForceCollisionReady = false;
  }
}
