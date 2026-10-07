import test from 'node:test';
import assert from 'node:assert/strict';
import { GatherPositions, gatherGrid } from '../gather.mjs';
import { FilterPositions } from '../visibility.mjs';
import { VibeGraph } from '../cosmos-vibe.mjs';

const initial = new Float32Array([10.25, 20.75, 30.5, 40.5, 50, 60]);
const targets = new Map([[0, new Float32Array([100, 100])], [2, new Float32Array([200, 100])]]);
const apply = (positions, updates) => { for (const [index, point] of updates) positions.set(point, index * 2); };
test('comparison grid preserves score order, centers rows and fits map bounds', () => {
  const grid = gatherGrid([2, 0, 1], [40, 80, 60], { center: [500, 500], aspect: 1, spaceSize: 1000, margin: 100 });
  assert.deepEqual([...grid.positions.keys()], [2, 0, 1]);
  assert.ok(grid.positions.get(2)[0] < grid.positions.get(0)[0]);
  assert.ok(grid.positions.get(2)[1] > grid.positions.get(1)[1]);
  assert.equal(grid.positions.get(1)[0], 500);
  const tiny = gatherGrid([0, 1, 2], [1000, 1000, 1000], { center: [-100, 2000], aspect: .5, spaceSize: 1000, margin: 100 });
  assert.ok(tiny.scale < 1);
  for (const point of tiny.positions.values()) for (const value of point) assert.ok(value >= 100 && value <= 900);
  assert.equal(gatherGrid([], [], {}).positions.size, 0);
});
test('ungather exactly restores matches, retains live background moves and never saves comparison coordinates', () => {
  const gather = new GatherPositions(), positions = initial.slice(), filters = new FilterPositions(3);
  filters.seed(initial);
  gather.reconcile([0, 2], positions, targets, 0);
  apply(positions, gather.frame(225).positions);
  assert.notDeepEqual([...positions], [...initial]);
  const hideBackground = filters.update(gather.canonical(positions), [true, false, true]);
  assert.deepEqual([...filters.saved], [...initial]);
  assert.equal(hideBackground[0], initial[0]);
  apply(positions, gather.frame(450).positions);
  // Drag both a match and a background album during comparison.
  gather.drag(0); positions.set([120, 150], 0); positions.set([33, 44], 2);
  assert.deepEqual([...gather.canonical(positions)], [10.25, 20.75, 33, 44, 50, 60]);
  gather.end(positions, 500);
  apply(positions, gather.frame(725).positions);
  assert.equal(gather.saved.size, 2);
  apply(positions, gather.frame(950).positions);
  assert.deepEqual([...positions], [10.25, 20.75, 33, 44, 50, 60]);
  assert.equal(gather.saved.size, 0); assert.equal(gather.transitions.size, 0);
});
test('filter reconciliation and interrupted returns never replace the original snapshots', () => {
  const gather = new GatherPositions(), positions = initial.slice();
  gather.reconcile([0, 2], positions, targets, 0, 0); apply(positions, gather.frame(0).positions);
  gather.end(positions, 10); apply(positions, gather.frame(100).positions);
  gather.reconcile([0, 1], positions, new Map([[0, [300, 300]], [1, [400, 300]]]), 100);
  assert.deepEqual([...gather.saved.get(0)], [10.25, 20.75]);
  assert.deepEqual([...gather.saved.get(1)], [30.5, 40.5]);
  const canonical = gather.canonical(positions);
  gather.forgetHidden([false, true, true]);
  assert.equal(canonical[0], initial[0]); assert.equal(gather.saved.has(0), false);
  gather.end(positions, 200, 0); apply(positions, gather.frame(650).positions);
  assert.equal(positions[2], initial[2]); assert.equal(positions[4], initial[4]);
  assert.equal(gather.saved.size, 0);
});
test('empty/instant clear and drag interruptions leave no temporary state', () => {
  const gather = new GatherPositions(), positions = initial.slice();
  gather.end(positions, 0); assert.equal(gather.frame(0).positions.size, 0);
  gather.reconcile([0], positions, targets, 0); gather.drag(0);
  assert.equal(gather.transitions.size, 0); assert.equal(gather.saved.size, 1);
  gather.end(positions, 10, 0); const frame = gather.frame(10);
  assert.deepEqual(frame.restored, [0]); assert.deepEqual([...frame.positions.get(0)], [10.25, 20.75]);
  assert.equal(gather.active, false); assert.equal(gather.saved.size, 0);
});

function texture(values) {
  return { width: 2, data: Float32Array.from(values), copyImageData({ data, x, y, width }) {
    assert.equal(data.length, width * 4);
    this.data.set(data, (y * 2 + x) * 4);
  } };
}
test('indexed GPU moves preserve background positions, velocities, alpha and canonical coordinates', () => {
  const values = [10.25, 20.75, 0, 0, 30.5, 40.5, 1, 0, 50, 60, 2, 0, 0, 0, 0, 0];
  const graph = { graph: { pointPositions: initial.slice() },
    store: { pointsTextureSize: 2, alpha: .42, simulationProgress: 123, isSimulationRunning: true },
    points: { currentPositionTexture: texture(values), previousPositionTexture: texture(values),
      velocityTexture: texture(new Array(16).fill(7)), trackPoints() {}, updateSampledPointsGrid() {},
      discardPendingPick() {}, updateExit() {} }, markPickingBuffersStale() {}, requestRender() {} };
  const bridge = new VibeGraph(graph);
  const store = { ...graph.store };
  bridge.positions(targets);
  assert.deepEqual([...graph.graph.pointPositions], [...initial]);
  assert.deepEqual([...graph.points.currentPositionTexture.data.slice(4, 8)], values.slice(4, 8));
  assert.ok(graph.points.velocityTexture.data.every(value => value === 7));
  bridge.clearVelocity([0, 2]);
  assert.deepEqual([...graph.points.velocityTexture.data.slice(4, 8)], [7, 7, 7, 7]);
  assert.equal(graph.points.velocityTexture.data[0], 0);
  bridge.positions(new Map([[0, [NaN, NaN]]]), { visibility: true });
  assert.ok(Number.isNaN(graph.graph.pointPositions[0]));
  assert.equal(graph.graph.pointPositions[2], initial[2]);
  assert.deepEqual(graph.store, store);
});
test('attraction centroids use saved anchors and current background coordinates without moving the map', () => {
  const values = [100, 100, 0, 0, 35, 45, 1, 0, 200, 100, 2, 0, 0, 0, 0, 0];
  let copies = 0;
  const graph = { store: { pointsTextureSize: 2 }, points: { previousPositionTexture: texture(values) },
    device: { createTexture() { return { ...texture(new Array(16).fill(0)), destroy() { this.destroyed = true; } }; },
      createCommandEncoder() { return { copyTextureToTexture({ sourceTexture, destinationTexture }) {
        destinationTexture.data.set(sourceTexture.data); copies++;
      }, finish() {} }; }, submit() {} } };
  const bridge = new VibeGraph(graph);
  assert.equal(bridge.attractionPositions(), graph.points.previousPositionTexture);
  bridge.anchors = new Map([[0, initial.slice(0, 2)], [2, initial.slice(4, 6)]]);
  const attraction = bridge.attractionPositions();
  assert.deepEqual([...attraction.data.slice(0, 2)], [...initial.slice(0, 2)]);
  assert.deepEqual([...attraction.data.slice(4, 6)], [35, 45]);
  assert.deepEqual([...graph.points.previousPositionTexture.data], values);
  graph.points.previousPositionTexture.data[4] = 36;
  assert.equal(bridge.attractionPositions().data[4], 36);
  assert.equal(copies, 2);
  bridge.destroy(); assert.equal(attraction.destroyed, true);
});
