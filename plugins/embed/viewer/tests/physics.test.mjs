import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dragAlpha } from '../physics.mjs';
import { layoutParameters } from '../logic.mjs';

test('drag reheating maintains its floor without cooling an already hotter simulation', () => {
  assert.equal(dragAlpha(.01), .8);
  assert.equal(dragAlpha(.01, true), .6);
  assert.equal(dragAlpha(1), 1);
  assert.equal(dragAlpha(1, true), 1);
  for (let tick = 0, alpha = .01; tick < 500; tick++) {
    alpha = dragAlpha(alpha * .99); assert.ok(alpha >= .8);
  }
});
test('stronger spring increases local drag response without changing rest distance or grouping defaults', () => {
  for (const count of [400, 2719, 6400]) {
    const albums = Array.from({ length: count }, () => ({ cover: null, summed_plays: 0 }));
    const { forces, distanceScale, repulsionScale } = layoutParameters(albums);
    assert.equal(forces.simulationLinkSpring, .05);
    assert.equal(forces.simulationLinkDistance, 150 * distanceScale);
    assert.equal(forces.simulationRepulsion, 40 * repulsionScale);
    assert.equal(forces.simulationGravity, .008); assert.equal(forces.simulationCluster, .001);
    assert.equal(forces.simulationFriction, .5);
    // Cosmos applies sqrt(raw link strength), degree bias, then spring * alpha.
    const response = spring => (200 - forces.simulationLinkDistance) * Math.sqrt(.8 / 8) * .5 * spring;
    assert.ok(Math.abs(response(.05) / response(.01) - 5) < 1e-9);
  }
});
