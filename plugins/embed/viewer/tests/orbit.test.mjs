import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { patchCosmosAtlas } from '../cosmos-atlas-patch.mjs';
import { VibeGraph } from '../cosmos-vibe.mjs';

const orbit = { center: [500, 600], innerRadius: 120, outerRadius: 400, speed: .06, strength: .08 };
test('orbit configuration leaves positions and canonical anchors alone and can be cleared', () => {
  const graph = { graph: { pointPositions: new Float32Array([10, 20]) }, points: {}, store: { alpha: .3 } };
  const bridge = new VibeGraph(graph);
  bridge.anchors.set(0, [10, 20]);
  bridge.orbit(orbit);
  assert.deepEqual(graph.graph.albumOrbit, orbit);
  assert.notEqual(graph.graph.albumOrbit.center, orbit.center);
  assert.deepEqual([...graph.graph.pointPositions], [10, 20]);
  assert.equal(graph.store.alpha, .3);
  assert.deepEqual(bridge.anchors.get(0), [10, 20]);
  bridge.orbit({ ...orbit, speed: 0 });
  assert.equal(graph.graph.albumOrbit.speed, 0);
  for (const invalid of [{ ...orbit, center: [NaN, 10] }, { ...orbit, innerRadius: -1 },
    { ...orbit, outerRadius: 120 }, { ...orbit, speed: -1 }]) {
    assert.throws(() => bridge.orbit(invalid), /Invalid gather orbit/);
  }
  bridge.orbit(null);
  assert.equal(graph.graph.albumOrbit, undefined);
  bridge.orbit(orbit); bridge.destroy();
  assert.equal(graph.graph.albumOrbit, undefined);
});

test('GPU orbit pass binds valid pins, skips dragged and absent albums, and uses bounded elapsed time', async () => {
  const source = await readFile(new URL('../node_modules/@cosmos.gl/graph/dist/index.js', import.meta.url), 'utf8');
  const patched = patchCosmosAtlas(source, '3.4.2', '/tmp/atlas.mjs');
  const shader = patched.slice(patched.indexOf('const Ht = `'), patched.indexOf('class we extends V {'));
  assert.match(shader, /any\(isnan\(pointPosition.rg\)\)/);
  assert.match(shader, /any\(isinf\(pointPosition.rg\)\)/);
  assert.match(shader, /texelFetch\(pinnedStatusTexture, pointTexel, 0\).r > 0.5/);
  assert.match(shader, /index == albumOrbitMotion.w/);
  assert.ok(patched.includes('(t || this.graph.albumOrbit) && ((c = this.points)'));
  const gravity = patched.slice(patched.indexOf('class we extends V {'), patched.indexOf('\nfunction Xt('));
  const Gravity = new Function('V', `${gravity}; return we;`)(class {});
  const force = new Gravity(), uniforms = [], bindings = [];
  force.data = { albumOrbit: orbit };
  force.config = { simulationGravity: 0 };
  force.store = { adjustedSpaceSize: 4096, alpha: .3, draggingPointIndex: 7 };
  force.points = { pinnedStatusTexture: {}, previousPositionTexture: {}, velocityFbo: {} };
  force.device = { beginRenderPass() { return { end() {} }; } };
  force.uniformStore = { setUniforms(value) { uniforms.push(value.forceGravityUniforms); } };
  force.runCommand = { setBindings(value) { bindings.push(value); }, draw() {} };
  force.albumOrbitTime = performance.now() - 5000;
  force.run();
  assert.deepEqual(uniforms[0].albumOrbitGeometry, [500, 600, 120, 400]);
  assert.deepEqual(uniforms[0].albumOrbitMotion, [1, .004, .16, 7]);
  assert.equal(bindings[0].pinnedStatusTexture, force.points.pinnedStatusTexture);
  // Restoring ordinary gravity clears all temporary orbit uniforms.
  force.data.albumOrbit = undefined; force.config.simulationGravity = .004;
  force.run();
  assert.equal(uniforms[1].gravity, .004);
  assert.deepEqual(uniforms[1].albumOrbitMotion, [0, 0, 0, -1]);
  assert.equal(force.albumOrbitTime, undefined);
  force.points.pinnedStatusTexture.destroyed = true;
  force.run();
  assert.equal(uniforms.length, 2);
});
