// Small bridge to the hash-guarded Cosmos 3.4.2 adapter. Visual sizes must not
// change collision forces when a phrase is applied or cleared.
function writeTexels(targets, updates, side, velocity = false) {
  const textures = (Array.isArray(targets) ? targets : [targets]).filter(texture => texture && !texture.destroyed);
  if (!textures.length) return;
  const sorted = [...updates].sort((a, b) => a[0] - b[0]);
  for (let offset = 0; offset < sorted.length;) {
    const start = offset, first = sorted[offset][0];
    while (++offset < sorted.length && sorted[offset][0] === sorted[offset - 1][0] + 1 &&
      Math.floor(sorted[offset][0] / side) === Math.floor(first / side)) {}
    const data = new Float32Array((offset - start) * 4);
    for (let i = start; i < offset; i++) {
      const [index, coordinates] = sorted[i];
      if (!velocity) data.set([coordinates[0], coordinates[1], index, 0], (i - start) * 4);
    }
    for (const texture of textures) texture.copyImageData({ data, bytesPerRow: data.byteLength,
      width: offset - start, height: 1, x: first % side, y: Math.floor(first / side), mipLevel: 0 });
  }
}

export class VibeGraph {
  constructor(graph) {
    this.graph = graph; this.anchors = new Map();
    if (graph.points) graph.points.albumAttractionPositions = () => this.attractionPositions();
  }
  collisionSizes(sizes) {
    const previous = this.graph.graph.albumCollisionSizes;
    if (previous?.length === sizes.length && sizes.every((size, i) => size === previous[i])) return;
    this.graph.graph.albumCollisionSizes = Float32Array.from(sizes);
    this.graph.isForceCollisionReady = false;
  }
  orbit(options) {
    if (!options) { this.graph.graph.albumOrbit = undefined; return; }
    const { center, innerRadius, outerRadius, speed = .06, strength = .08 } = options;
    if (center?.length !== 2 || ![...center, innerRadius, outerRadius, speed, strength].every(Number.isFinite) ||
        innerRadius < 0 || outerRadius <= innerRadius || speed < 0 || strength < 0) {
      throw new Error('Invalid gather orbit geometry.');
    }
    this.graph.graph.albumOrbit = { center: Array.from(center), innerRadius, outerRadius, speed, strength };
  }
  // No setPointPositions/render transition: those reset all velocities or pause
  // live physics. Only the supplied point texels change here.
  positions(updates, { visibility = false, resetVelocity = false } = {}) {
    if (!updates.size) return;
    const graph = this.graph, points = graph.points, side = graph.store.pointsTextureSize;
    writeTexels([points.currentPositionTexture, points.previousPositionTexture], updates, side);
    if (resetVelocity || visibility) writeTexels(points.velocityTexture, updates, side, true);
    if (visibility) {
      for (const [index, coordinates] of updates) {
        graph.graph.pointPositions.set(coordinates, index * 2);
      }
      points.updateExit();
    }
    points.isPositionsUpToDate = points.areClusterCentroidsUpToDate = false;
    points.trackPoints(); points.updateSampledPointsGrid();
    points.discardPendingPick(); graph.markPickingBuffersStale();
    graph._shouldForceHoverDetection = true;
    graph.requestRender();
  }
  clearVelocity(indices) {
    writeTexels(this.graph.points.velocityTexture, new Map(indices.map(i => [i, []])), this.graph.store.pointsTextureSize, true);
  }
  attractionPositions() {
    const graph = this.graph, source = graph.points.previousPositionTexture;
    if (!this.anchors.size) return source;
    const side = graph.store.pointsTextureSize;
    if (!this.anchorTexture || this.anchorTexture.width !== side) {
      this.anchorTexture?.destroy();
      this.anchorTexture = graph.device.createTexture({ width: side, height: side, format: 'rgba32float' });
    }
    const encoder = graph.device.createCommandEncoder();
    encoder.copyTextureToTexture({ sourceTexture: source, destinationTexture: this.anchorTexture, width: side, height: side });
    graph.device.submit(encoder.finish());
    writeTexels(this.anchorTexture, this.anchors, side);
    return this.anchorTexture;
  }
  destroy() {
    this.anchorTexture?.destroy();
    if (this.graph.graph) this.graph.graph.albumOrbit = undefined;
    if (this.graph.points) this.graph.points.albumAttractionPositions = undefined;
  }
}
