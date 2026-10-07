import test from 'node:test';
import assert from 'node:assert/strict';
import { GatherPositions, gatherRings } from '../gather.mjs';
import { FilterPositions } from '../visibility.mjs';
import { VibeGraph } from '../cosmos-vibe.mjs';

const initial = new Float32Array([10.25, 20.75, 30.5, 40.5, 50, 60]);
const targets = new Map([[0, new Float32Array([100, 100])], [2, new Float32Array([200, 100])]]);
const apply = (positions, updates) => { for (const [index, point] of updates) positions.set(point, index * 2); };
test('gather rings keep covers apart throughout rotation for small and large result sets', () => {
  for (const count of [1, 2, 6, 7, 24, 177, 1000]) {
    const indices = Array.from({ length: count }, (_, i) => i);
    const sizes = indices.map(i => 32 + i % 6 * 7);
    const layout = gatherRings(indices, sizes, { center: [500, 500], spaceSize: 1000, margin: 100 });
    const gather = new GatherPositions(); gather.setOrbit(layout, 0);
    assert.equal(layout.positions.size, count);
    for (const angle of [0, .137, Math.PI / 4, 1.24, Math.PI, 5.9]) {
      gather.angle = angle;
      const points = indices.map(index => gather.orbitPosition(index));
      for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) {
        const clearance = (sizes[i] + sizes[j]) * layout.scale / 2;
        const dx = Math.abs(points[i][0] - points[j][0]), dy = Math.abs(points[i][1] - points[j][1]);
        assert.ok(dx + .001 >= clearance || dy + .001 >= clearance,
          `${count} matches overlap at angle ${angle}: ${i}, ${j}`);
      }
    }
  }
});
test('gather rings preserve score rank from the center outward and reserve space around the cluster', () => {
  const ranked = [8, 2, 0, 5, 1, 7, 6, 4, 3];
  const layout = gatherRings(ranked, new Array(9).fill(80), { center: [500, 500], spaceSize: 1000, margin: 100 });
  assert.deepEqual([...layout.positions.keys()], ranked);
  assert.deepEqual([...layout.positions.get(ranked[0])], layout.center);
  const radii = ranked.map(index => Math.hypot(...layout.positions.get(index).map((value, axis) => value - layout.center[axis])));
  for (let i = 1; i < radii.length; i++) assert.ok(radii[i] + .001 >= radii[i - 1]);
  assert.ok(radii[7] > radii[6], 'the seventh ring member starts a new ring');
  assert.ok(layout.radius <= (1000 - 100 * 2) / 4);
  const one = gatherRings([0], [80], { center: [500, 500], spaceSize: 1000, margin: 100 });
  assert.deepEqual([...one.positions.get(0)], [500, 500]);
});
test('large covers remain within map bounds at every angle, including off-map requested centers', () => {
  const indices = Array.from({ length: 177 }, (_, i) => i);
  const layout = gatherRings(indices, new Array(indices.length).fill(1000), { center: [-100, 2000], spaceSize: 1000, margin: 100 });
  assert.ok(layout.scale > 0 && layout.scale < 1);
  const gather = new GatherPositions(); gather.setOrbit(layout, 0);
  for (const angle of [0, .137, Math.PI / 4, 1.24, Math.PI, 5.9]) {
    gather.angle = angle;
    for (const index of indices) for (const value of gather.orbitPosition(index)) {
      assert.ok(value - 500 * layout.scale >= 100 - .001);
      assert.ok(value + 500 * layout.scale <= 900 + .001);
    }
  }
  assert.deepEqual(gatherRings([], [], {}), { positions: new Map(), scale: 1, radius: 0, center: undefined });
});

function orbitGather(duration = 0) {
  const gather = new GatherPositions(), positions = initial.slice();
  const layout = gatherRings([0, 2], [40, 40, 40], { center: [500, 500], spaceSize: 1000, margin: 100 });
  gather.reconcile([0, 2], positions, layout.positions, 0, duration);
  gather.setOrbit(layout, 0);
  apply(positions, gather.frame(0).positions);
  return { gather, positions, layout };
}
test('gathered albums keep orbiting after arrival without changing the background or canonical positions', () => {
  const { gather, positions, layout } = orbitGather(450);
  apply(positions, gather.frame(450, { rotate: true }).positions);
  assert.equal(gather.transitions.size, 0);
  const settled = positions.slice();
  apply(positions, gather.frame(500, { rotate: true }).positions);
  assert.notDeepEqual([...positions.slice(0, 2)], [...settled.slice(0, 2)]);
  assert.notDeepEqual([...positions.slice(4, 6)], [...settled.slice(4, 6)]);
  assert.deepEqual([...positions.slice(2, 4)], [...initial.slice(2, 4)]);
  for (const index of [0, 2]) {
    const radius = Math.hypot(positions[index * 2] - layout.center[0], positions[index * 2 + 1] - layout.center[1]);
    const originalRadius = Math.hypot(...layout.positions.get(index).map((value, axis) => value - layout.center[axis]));
    assert.ok(Math.abs(radius - originalRadius) < .001);
  }
  assert.deepEqual([...gather.canonical(positions)], [...initial]);
  positions.set([33, 44], 2);
  gather.end(positions, 510);
  apply(positions, gather.frame(960, { rotate: true }).positions);
  assert.deepEqual([...positions], [10.25, 20.75, 33, 44, 50, 60]);
  assert.equal(gather.saved.size, 0);
  assert.equal(gather.frame(1000, { rotate: true }).positions.size, 0);
});
test('disabled rotation freezes slots for pause or reduced motion and resumes without catching up', () => {
  const paused = orbitGather(), reference = orbitGather();
  const settled = paused.positions.slice();
  for (const now of [50, 5000, 100000]) apply(paused.positions, paused.gather.frame(now, { rotate: false }).positions);
  assert.deepEqual([...paused.positions], [...settled]);
  apply(paused.positions, paused.gather.frame(100016, { rotate: true }).positions);
  apply(reference.positions, reference.gather.frame(16, { rotate: true }).positions);
  assert.deepEqual([...paused.positions], [...reference.positions]);
});
test('returning from a background tab caps rotation elapsed time', () => {
  const delayed = orbitGather(), reference = orbitGather();
  apply(delayed.positions, delayed.gather.frame(1000000, { rotate: true }).positions);
  apply(reference.positions, reference.gather.frame(50, { rotate: true }).positions);
  assert.deepEqual([...delayed.positions], [...reference.positions]);
});
test('drag overrides a gathered slot and release rejoins its moving orbit', () => {
  const { gather, positions } = orbitGather();
  gather.drag(0); positions.set([100, 150], 0);
  const dragged = gather.frame(50, { rotate: true, dragIndex: 0 });
  assert.equal(dragged.positions.has(0), false);
  apply(positions, dragged.positions);
  assert.deepEqual([...positions.slice(0, 2)], [100, 150]);
  assert.deepEqual([...gather.canonical(positions)], [...initial]);
  gather.release(0, positions, 50, 100);
  apply(positions, gather.frame(50, { rotate: true }).positions);
  assert.deepEqual([...positions.slice(0, 2)], [100, 150]);
  apply(positions, gather.frame(100, { rotate: true }).positions);
  assert.notDeepEqual([...positions.slice(0, 2)], [100, 150]);
  apply(positions, gather.frame(150, { rotate: true }).positions);
  assert.deepEqual([...positions.slice(0, 2)], [...gather.orbitPosition(0)]);
  assert.equal(gather.transitions.size, 0);
  const rejoined = positions.slice(0, 2);
  apply(positions, gather.frame(200, { rotate: true }).positions);
  assert.notDeepEqual([...positions.slice(0, 2)], [...rejoined]);
  assert.deepEqual([...positions.slice(2, 4)], [...initial.slice(2, 4)]);
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
