import { test } from 'node:test';
import assert from 'node:assert/strict';
import { communityLayout, communityLinkStrengths, dragAlpha } from '../physics.mjs';
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
test('local spring and repulsion retain their scaling with gentler global gravity', () => {
  for (const count of [400, 2719, 6400]) {
    const albums = Array.from({ length: count }, () => ({ cover: null, summed_plays: 0 }));
    const { forces, distanceScale, repulsionScale } = layoutParameters(albums);
    assert.equal(forces.simulationLinkSpring, .05);
    assert.equal(forces.simulationLinkDistance, 150 * distanceScale);
    assert.equal(forces.simulationRepulsion, 44 * repulsionScale);
    assert.equal(forces.simulationGravity, .004); assert.equal(forces.simulationCluster, .006);
    assert.equal(forces.simulationFriction, .5);
    // Cosmos applies sqrt(raw link strength), degree bias, then spring * alpha.
    const response = spring => (200 - forces.simulationLinkDistance) * Math.sqrt(.8 / 8) * .5 * spring;
    assert.ok(Math.abs(response(.05) / response(.01) - 5) < 1e-9);
  }
});

test('a larger world preserves repulsion per area as the library grows', () => {
  const album = { cover: 'cover.jpg', summed_plays: 0 };
  const reference = layoutParameters(Array(400).fill(album), { spaceSize: 4096 });
  const expanded = layoutParameters(Array(1600).fill(album), { spaceSize: 8192 });
  assert.equal(expanded.forces.simulationRepulsion, reference.forces.simulationRepulsion);
  const full = Array(2719).fill(album);
  assert.equal(layoutParameters(full, { spaceSize: 8192 }).forces.simulationRepulsion,
    4 * layoutParameters(full, { spaceSize: 4096 }).forces.simulationRepulsion);
});

test('hierarchical links retain degree normalization and intra-community response', () => {
  const clusters = [0, 0, 0, 1, 1, 1];
  const edges = [
    { source: 0, target: 1, weight: .9 }, { source: 1, target: 2, weight: .8 },
    { source: 3, target: 4, weight: .7 }, { source: 4, target: 5, weight: .6 },
    { source: 1, target: 4, weight: .5 }, { source: 2, target: 3, weight: .4 },
  ];
  const original = structuredClone(edges);
  const hierarchical = communityLinkStrengths(edges, clusters);
  const free = communityLinkStrengths(edges, clusters, 1);
  assert.equal(hierarchical.length, edges.length);
  assert.deepEqual(edges, original);
  for (let i = 0; i < 4; i++) assert.equal(hierarchical[i], free[i]);
  // Both bridge endpoints retain all their neighbors in the degree count:
  // weakening cross springs must not accidentally strengthen local springs.
  assert.ok(Math.abs(free[4] - .5 / 3) < 1e-7);
  assert.ok(Math.abs(free[5] - .4 / 2) < 1e-7);
  for (let i = 4; i < edges.length; i++) {
    assert.ok(hierarchical[i] > 0);
    assert.equal(hierarchical[i], free[i] * .25);
    assert.ok(Math.abs(Math.sqrt(hierarchical[i]) / Math.sqrt(free[i]) - .5) < 1e-7);
  }
  for (const scale of [.2, .35]) {
    const alternative = communityLinkStrengths(edges, clusters, scale);
    assert.ok(Math.abs(alternative[4] / free[4] - scale) < 1e-7);
  }
  assert.deepEqual(communityLinkStrengths([], []), new Float32Array());
  for (const scale of [0, -1, 1.1, Infinity, NaN]) assert.throws(() => communityLinkStrengths([], [], scale));
});

function fixture(sizes) {
  const albums = [], clusters = [], edges = [];
  for (const [group, size] of sizes.entries()) {
    const start = albums.length;
    for (let j = 0; j < size; j++) {
      albums.push({ id: albums.length + 1, cover: 'cover.jpg', summed_plays: 1 });
      clusters.push(group);
      if (j) edges.push({ source: start + j - 1, target: start + j, weight: 1 });
    }
  }
  return { albums, clusters, edges };
}

test('coarse centers respect cover footprint and preserve unequal community sizes', () => {
  const { albums, edges, clusters } = fixture([8, 32, 2]);
  edges.push({ source: 7, target: 8, weight: 1 }, { source: 39, target: 40, weight: .5 });
  const layout = communityLayout(albums, edges, clusters, { metric: 'uniform' });
  assert.ok(layout.radii[1] > layout.radii[0] * 1.9);
  assert.ok(layout.radii[0] > layout.radii[2] * 1.9);
  assert.ok([...layout.positions, ...layout.centers, ...layout.radii].every(Number.isFinite));
  assert.deepEqual(layout, communityLayout(albums, edges, clusters, { metric: 'uniform' }));
  const larger = communityLayout(albums, edges, clusters, { metric: 'uniform', artworkScale: 1.6 });
  const distance = result => Math.hypot(result.centers[0] - result.centers[2], result.centers[1] - result.centers[3]);
  assert.ok(distance(larger) > distance(layout));
  const closePadding = communityLayout(albums, edges, clusters, { metric: 'uniform', padding: 2 });
  const extraPadding = communityLayout(albums, edges, clusters, { metric: 'uniform', padding: 5 });
  assert.equal(closePadding.fit, 1); assert.equal(extraPadding.fit, 1);
  for (let group = 0; group < 3; group++) {
    const growth = extraPadding.radii[group] / closePadding.radii[group];
    assert.ok(growth > 1.03 && growth < 1.09);
  }
});

test('bridge albums have weaker community attraction while local springs remain available', () => {
  const { albums, edges, clusters } = fixture([5, 5]);
  edges.push({ source: 4, target: 5, weight: 1 }, { source: 4, target: 6, weight: 1 });
  const layout = communityLayout(albums, edges, clusters);
  assert.ok(layout.affinity[4] < .34);
  assert.ok(layout.strengths[4] < layout.strengths[2] / 3);
  assert.equal(layout.strengths[2], 1);
  assert.equal(edges.filter(edge => edge.source === 4 || edge.target === 4).length, 3);
});

test('inter-community similarity changes proximity independently of local repulsion', () => {
  const { albums, edges, clusters } = fixture([6, 6, 6]);
  const relationship = (target, weight) => ({ source: 0, target, weight });
  const a = communityLayout(albums, [...edges, relationship(6, 5), relationship(12, .05)], clusters);
  const b = communityLayout(albums, [...edges, relationship(6, .05), relationship(12, 5)], clusters);
  const distance = (layout, group) => Math.hypot(layout.centers[0] - layout.centers[group * 2],
    layout.centers[1] - layout.centers[group * 2 + 1]);
  assert.ok(distance(a, 1) < distance(a, 2));
  assert.ok(distance(b, 2) < distance(b, 1));
});

test('equally related communities use both dimensions rather than inheriting a shelf', () => {
  const { albums, edges, clusters } = fixture([6, 6, 6, 6]);
  for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) {
    edges.push({ source: a * 6, target: b * 6, weight: 1 });
  }
  const { centers } = communityLayout(albums, edges, clusters);
  const mx = (centers[0] + centers[2] + centers[4] + centers[6]) / 4;
  const my = (centers[1] + centers[3] + centers[5] + centers[7]) / 4;
  let xx = 0, yy = 0, xy = 0;
  for (let i = 0; i < 4; i++) {
    const x = centers[i * 2] - mx, y = centers[i * 2 + 1] - my;
    xx += x * x; yy += y * y; xy += x * y;
  }
  // Eigenvalues detect a collapsed diagonal too, unlike axis-aligned bounds.
  const spread = Math.sqrt((xx - yy) ** 2 + 4 * xy ** 2);
  assert.ok((xx + yy - spread) / (xx + yy + spread) > .65);
});

test('empty, singleton, sparse community IDs and isolates remain finite', () => {
  assert.equal(communityLayout([], [], []).positions.length, 0);
  const single = communityLayout([{ id: 1, cover: null, summed_plays: 0 }], [], [0]);
  assert.deepEqual(single.positions, new Float32Array([2048, 2048]));
  assert.equal(single.strengths[0], 1);
  const { albums } = fixture([4]);
  const sparse = communityLayout(albums, [{ source: 0, target: 1 }], [1, 1, 3, 3]);
  assert.ok([...sparse.positions, ...sparse.centers].every(Number.isFinite));
  assert.equal(sparse.strengths[2], 1);
  assert.throws(() => communityLayout(albums, [], [0, 1, 2, 4]));
});
