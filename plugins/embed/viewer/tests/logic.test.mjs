import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateExport, similarityCache, buildEdges, communities, seedPositions, seedLayout, layoutSpaceSize, layoutParameters, pointSizes, artworkSizes, groups, searchMatches } from '../logic.mjs';
const album = (id, vector, extra = {}) => ({ id, vector, album: `Album ${id}`, albumartist: 'Finn', genre: 'Folk',
  year: 2001, track_count: 3, embedded_tracks: 2, summed_plays: 16, mean_plays: 16 / 3, ...extra });
const exported = albums => ({ schema_version: 1, model_id: 'style:v1', exported_at: '2026-10-05T00:00:00Z', albums });

test('optional mip and overview metadata validates filenames, bounds and unique album mapping', () => {
  const name = 'cover-' + 'a'.repeat(64) + '.jpg';
  const data = exported([album(1, [1], { cover: name, cover_variants: { '32': name, '256': name } })]);
  data.cover_atlases = [{ file: name, tile_size: 32, columns: 1, album_ids: [1] }];
  assert.equal(validateExport(data), data);
  for (const change of [d => { d.albums[0].cover_variants['32'] = '../art.jpg'; },
    d => { d.cover_atlases[0].album_ids = [1, 1]; }, d => { d.cover_atlases[0].columns = 65; },
    d => { d.cover_atlases[0].album_ids = [2]; }, d => { d.cover_atlases[0].tile_size = 256; }]) {
    const bad = structuredClone(data); change(bad); assert.throws(() => validateExport(bad));
  }
});

test('validation accepts empty and current exports and rejects malformed vectors and metadata', () => {
  assert.equal(validateExport(exported([])).albums.length, 0);
  assert.equal(validateExport(exported([album(1, [1, 0])])).albums.length, 1);
  for (const data of [{}, exported([album(1, [0, 0])]), exported([album(1, [NaN, 1])]),
    exported([album(1, [1]), album(2, [1, 0])]), exported([album(1, [1]), album(1, [1])]),
    exported([album(1, [1], { mean_plays: -1 })]), exported([album(1, [1], { embedded_tracks: 4 })])]) {
    assert.throws(() => validateExport(data));
  }
});
test('cosine normalization, kNN filtering, threshold alone and undirected deduplication', () => {
  const cache = similarityCache([album(1, [2, 0]), album(2, [1, 0]), album(3, [0, 1])]);
  assert.equal(cache.scores[1], 1); assert.equal(cache.scores[2], 0);
  assert.equal(buildEdges(cache, { useK: true, k: 1, useThreshold: true, threshold: .7 }).length, 1);
  assert.equal(buildEdges(cache, { useK: false, useThreshold: true, threshold: 0 }).length, 3);
  assert.equal(buildEdges(cache, { useK: true, k: 99, useThreshold: false }).length, 3);
  assert.equal(buildEdges(cache, { useK: true, k: 0, useThreshold: false }).length, 0);
  assert.deepEqual(buildEdges(cache, { useK: false, useThreshold: false }), []);
  assert.equal(buildEdges(cache, { useK: true, k: 2, useThreshold: true, threshold: 1 }).length, 1);
});
test('empty and single-node graphs do not produce self-links', () => {
  for (const albums of [[], [album(1, [1, 0])]]) {
    assert.deepEqual(buildEdges(similarityCache(albums)), []);
    assert.equal(communities(albums, []).length, albums.length);
  }
});
test('communities are deterministic and distinguish disconnected pairs and isolates', () => {
  const albums = [1, 2, 3, 4, 5].map(id => album(id, [1, 0]));
  const edges = [{ source: 0, target: 1, weight: 1 }, { source: 2, target: 3, weight: 1 }];
  const result = communities(albums, edges);
  assert.deepEqual(result, communities(albums, edges));
  assert.equal(result[0], result[1]); assert.equal(result[2], result[3]);
  assert.notEqual(result[0], result[2]); assert.notEqual(result[4], result[0]);
});

function assertSeedSpacing(positions, count, spacing = 112) {
  assert.ok(positions instanceof Float32Array);
  assert.equal(positions.length, count * 2);
  assert.ok([...positions].every(Number.isFinite));
  for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) {
    assert.ok(Math.max(Math.abs(positions[i * 2] - positions[j * 2]),
      Math.abs(positions[i * 2 + 1] - positions[j * 2 + 1])) >= spacing - .001);
  }
}

test('initial seeds cover empty, single and disconnected libraries with room for square artwork', () => {
  assert.deepEqual(seedPositions([], [], []), new Float32Array());
  assert.deepEqual(seedPositions([album(1, [1])], [], [0]), new Float32Array([2048, 2048]));
  const albums = Array.from({ length: 41 }, (_, i) => album(i + 1, [1]));
  const clusters = albums.map((_, i) => i);
  assertSeedSpacing(seedPositions(albums, [], clusters), albums.length);
  assertSeedSpacing(seedPositions(albums, [], clusters, 140), albums.length, 140);
  for (const spacing of [0, -1, NaN, Infinity]) assert.throws(() => seedPositions(albums, [], clusters, spacing));
});

test('initial seeds put connected albums closer than unrelated communities without overlaps', () => {
  const albums = Array.from({ length: 24 }, (_, i) => album(i + 1, [1]));
  const edges = [];
  for (let i = 1; i < 10; i++) edges.push({ source: 0, target: i, weight: 1 - i / 100 });
  for (let i = 10; i < 18; i++) edges.push({ source: i, target: i + 1, weight: .9 });
  const clusters = albums.map((_, i) => i < 10 ? 0 : i < 19 ? 1 : i);
  const positions = seedPositions(albums, edges, clusters);
  assertSeedSpacing(positions, albums.length);
  assert.deepEqual(positions, seedPositions(albums, edges, clusters));
  const distance = (a, b) => Math.hypot(positions[a * 2] - positions[b * 2], positions[a * 2 + 1] - positions[b * 2 + 1]);
  const linkedMean = edges.reduce((sum, { source, target }) => sum + distance(source, target), 0) / edges.length;
  const unrelatedMean = Array.from({ length: 9 }, (_, i) => distance(i, i + 10)).reduce((a, b) => a + b) / 9;
  assert.ok(linkedMean < unrelatedMean * .65, `${linkedMean} versus ${unrelatedMean}`);
});

function libraryFixture(count, mode = 'balanced') {
  const albums = Array.from({ length: count }, (_, i) => album(i + 1, [1], {
    summed_plays: i % 549, cover: `cover-${'a'.repeat(64)}.jpg` }));
  const clusters = albums.map((_, i) => mode === 'skewed' && i < count * .9 ? 0 : i % 78);
  const previous = new Map(), edges = [];
  if (mode !== 'isolates') for (const [i, cluster] of clusters.entries()) {
    if (previous.has(cluster)) edges.push({ source: previous.get(cluster), target: i, weight: .9 });
    previous.set(cluster, i);
  }
  return { albums, edges, clusters };
}

test('large seeds fit the actual space with margins for balanced, uneven and isolated communities', () => {
  for (const count of [400, 2719, 6400]) for (const mode of ['balanced', 'skewed', 'isolates']) {
    const { albums, edges, clusters } = libraryFixture(count, mode);
    for (const spaceSize of [2048, 4096, 8192]) {
      const margin = spaceSize * .1, options = { spaceSize, margin };
      const seeded = seedLayout(albums, edges, clusters, 112, options);
      assert.equal(seeded.positions.length, count * 2);
      assert.ok(seeded.spacing > 0 && seeded.spacing <= 112);
      assert.deepEqual(seeded.positions, seedPositions(albums, edges, clusters, 112, options));
      const cells = new Set();
      for (let i = 0; i < count; i++) {
        const x = seeded.positions[i * 2], y = seeded.positions[i * 2 + 1];
        assert.ok(x >= margin && x <= spaceSize - margin, `${count}/${mode}/${spaceSize}: x=${x}`);
        assert.ok(y >= margin && y <= spaceSize - margin, `${count}/${mode}/${spaceSize}: y=${y}`);
        cells.add(`${Math.round(x / seeded.spacing)},${Math.round(y / seeded.spacing)}`);
      }
      assert.equal(cells.size, count, 'scaling must not clamp distinct albums onto the same cell');
      for (const axis of [0, 1]) {
        const values = Array.from(seeded.positions).filter((_, i) => i % 2 === axis);
        assert.ok(Math.abs((Math.min(...values) + Math.max(...values)) / 2 - spaceSize / 2) < .001);
      }
      if (mode === 'balanced') {
        const distance = (a, b) => Math.hypot(seeded.positions[a * 2] - seeded.positions[b * 2],
          seeded.positions[a * 2 + 1] - seeded.positions[b * 2 + 1]);
        const linked = edges.reduce((sum, e) => sum + distance(e.source, e.target), 0);
        const unrelated = edges.reduce((sum, e) => sum + distance(e.source, (e.target + 1) % count), 0);
        assert.ok(linked < unrelated * .65, 'community proximity survives fitting large libraries');
      }
    }
  }
});

test('space selection respects count, constrained devices and Cosmos texture-limit adjustment', () => {
  assert.equal(layoutSpaceSize(0), 4096);
  assert.equal(layoutSpaceSize(400), 4096);
  assert.equal(layoutSpaceSize(2719), 8192);
  assert.equal(layoutSpaceSize(6400), 8192);
  assert.equal(layoutSpaceSize(6400, { constrained: true }), 4096);
  for (const limit of [2048, 4096, 8192, 12000, 16384]) {
    const size = layoutSpaceSize(6400, { maxTextureSize: limit });
    assert.ok(size < limit && size <= 8192);
    assert.equal(Math.log2(size) % 1, 0);
  }
  assert.equal(layoutSpaceSize(2719, { maxTextureSize: 8192 }), 4096);
  assert.equal(layoutSpaceSize(2719, { maxTextureSize: 4096 }), 2048);
  for (const count of [-1, .5, NaN, Infinity]) assert.throws(() => layoutSpaceSize(count));
  for (const maxTextureSize of [0, 2, NaN, Infinity]) assert.throws(() => layoutSpaceSize(1, { maxTextureSize }));
});

test('derived physics and geometry fit the collision budget as the library and artwork grow', () => {
  for (const count of [400, 2719, 6400]) {
    const { albums, edges, clusters } = libraryFixture(count);
    for (const spaceSize of [2048, 4096, 8192]) {
      const seeded = seedLayout(albums, edges, clusters, 112, { spaceSize });
      for (const metric of ['uniform', 'summed_plays', 'mean_plays', 'track_count']) {
        for (const artworkScale of [.6, 1, 1.8]) {
          const emphasis = albums.map((_, i) => i % 2 ? 1.75 : 1);
          const parameters = layoutParameters(albums, { ...seeded, metric, artworkScale, emphasis });
          const { forces, geometryScale, distanceScale, repulsionScale } = parameters;
          assert.ok(geometryScale > 0 && geometryScale <= 1);
          assert.ok(parameters.collisionArea <= parameters.collisionAreaLimit + 1e-6);
          assert.ok(Object.values(forces).every(Number.isFinite));
          assert.ok(forces.simulationCollisionPadding >= 0 && forces.simulationCollisionPadding <= 12);
          assert.equal(forces.simulationLinkDistance, 150 * distanceScale);
          assert.equal(repulsionScale, Math.min(1, 400 / count * (spaceSize / 4096) ** 2) * distanceScale ** 2);
          assert.equal(forces.simulationRepulsion, 44 * repulsionScale);
          assert.equal(forces.simulationGravity, .004);
          assert.equal(forces.simulationCluster, .006);
          // Verify the footprint independently, including the highlighted artwork
          // and selection frame rather than just checking the helper's accounting.
          const sizes = artworkSizes(albums, metric, artworkScale);
          const footprint = sizes.reduce((sum, size, i) => sum +
            ((size * emphasis[i] + 8) / .8 * geometryScale + 2 * forces.simulationCollisionPadding) ** 2, 0);
          assert.ok(footprint <= parameters.collisionAreaLimit + .01);
        }
      }
    }
  }
});

test('small layouts retain discovery defaults and custom spaces handle empty/single libraries', () => {
  const { albums } = libraryFixture(100);
  const small = layoutParameters(albums, { metric: 'uniform' });
  assert.equal(small.geometryScale, 1);
  assert.equal(small.forces.simulationCollisionPadding, 12);
  assert.equal(small.forces.simulationRepulsion, 44);
  assert.equal(small.forces.simulationLinkDistance, 150);
  assert.deepEqual(seedPositions([], [], [], 112, { spaceSize: 8192 }), new Float32Array());
  assert.deepEqual(seedPositions([album(1, [1])], [], [0], 112, { spaceSize: 8192 }),
    new Float32Array([4096, 4096]));
  assert.ok(Object.values(layoutParameters([]).forces).every(Number.isFinite));
  for (const options of [{ spaceSize: 0 }, { margin: -1 }, { margin: 2048 }, { spacing: 0 },
    { artworkScale: NaN }, { emphasis: [0] }]) assert.throws(() => layoutParameters(albums, options));
  for (const options of [{ spaceSize: NaN }, { spaceSize: 0 }, { margin: -1 }, { margin: 2048 }]) {
    assert.throws(() => seedPositions(albums, [], [], 112, options));
  }
});

test('a dense cover layout gains local padding while retaining artwork and force sizes', () => {
  const { albums } = libraryFixture(700);
  const parameters = layoutParameters(albums, { metric: 'uniform', spaceSize: 4096 });
  assert.equal(parameters.geometryScale, 1);
  assert.equal(artworkSizes(albums, 'uniform')[0], 56);
  assert.ok(parameters.forces.simulationCollisionPadding >= 5 && parameters.forces.simulationCollisionPadding <= 6);
  assert.ok(Math.abs(parameters.forces.simulationRepulsion - 44 * 400 / 700) < 1e-10);
  assert.equal(parameters.forces.simulationLinkDistance, 150);
  const diameter = (56 + 8) / .8 + 2 * parameters.forces.simulationCollisionPadding;
  assert.ok(albums.length * diameter ** 2 <= .55 * (4096 * .8) ** 2 + 1e-6);
});

test('collision budgeting includes missing-cover dots and sound emphasis', () => {
  const { albums } = libraryFixture(6400);
  albums.forEach((a, i) => { if (i % 2) a.cover = null; });
  const emphasis = albums.map((_, i) => i % 3 ? 1 : 1.75);
  const parameters = layoutParameters(albums, { metric: 'uniform', emphasis });
  const { geometryScale, forces } = parameters;
  const footprint = albums.reduce((sum, a, i) => sum +
    ((a.cover ? (56 * emphasis[i] + 8) / .8 : 12 * emphasis[i]) * geometryScale +
      2 * forces.simulationCollisionPadding) ** 2, 0);
  assert.ok(footprint <= parameters.collisionAreaLimit + .01);
  const allDots = albums.map(a => ({ ...a, cover: null }));
  assert.equal(layoutParameters(allDots, { metric: 'uniform', emphasis }).geometryScale, 1);
});

test('size metrics, missing metadata grouping and search', () => {
  const albums = [album(1, [1, 0], { summed_plays: 0, year: 0, genre: '' }), album(2, [1, 0])];
  assert.equal(pointSizes(albums, 'summed_plays')[0], 8);
  assert.equal(pointSizes(albums, 'summed_plays')[1], 36);
  assert.deepEqual([...pointSizes(albums, 'uniform')], [12, 12]);
  for (const metric of ['mean_plays', 'track_count']) assert.ok([...pointSizes(albums, metric)].every(Number.isFinite));
  assert.deepEqual(groups(albums, 'decade', []), ['Unknown', '2000s']);
  assert.deepEqual(groups(albums, 'genre', []), ['Unknown', 'Folk']);
  assert.deepEqual(groups(albums, 'cluster', [0, 1]), ['Cluster 1', 'Cluster 2']);
  assert.deepEqual(searchMatches(albums, '  FINN  '), [0, 1]);
  assert.deepEqual(searchMatches(albums, 'album 2'), [1]);
  assert.deepEqual(searchMatches(albums, 'missing'), []);
});

test('artwork sizes show ordinary listening differences despite a heavily played outlier', () => {
  const albums = [0, 4, 16, 42, 84, 548].map((summed_plays, i) => album(i + 1, [1], { summed_plays }));
  const sizes = artworkSizes(albums, 'summed_plays');
  assert.ok(sizes instanceof Float32Array);
  assert.equal(sizes[0], 28);
  assert.equal(sizes.at(-1), 104);
  for (let i = 1; i < sizes.length; i++) assert.ok(sizes[i] - sizes[i - 1] > 7);
  // A middle-of-library album still occupies more than half the visual range.
  assert.ok(sizes[3] > (sizes[0] + sizes.at(-1)) / 2);
});

test('artwork sizing handles zero activity, alternate metrics and the size slider', () => {
  const albums = [album(1, [1], { summed_plays: 0, mean_plays: .25, track_count: 20 }),
    album(2, [1], { summed_plays: 0, mean_plays: 2, track_count: 5 })];
  assert.deepEqual([...artworkSizes(albums, 'summed_plays')], [28, 28]);
  assert.deepEqual([...artworkSizes([], 'summed_plays')], []);
  assert.deepEqual([...artworkSizes(albums, 'uniform')], [56, 56]);
  assert.deepEqual([...artworkSizes(albums, 'uniform', 1.5)], [84, 84]);
  const meanSizes = artworkSizes(albums, 'mean_plays');
  const trackSizes = artworkSizes(albums, 'track_count');
  assert.ok(meanSizes[0] < meanSizes[1]);
  assert.ok(trackSizes[0] > trackSizes[1]);
  const scaled = artworkSizes(albums, 'mean_plays', .75);
  for (let i = 0; i < scaled.length; i++) assert.ok(Math.abs(scaled[i] - meanSizes[i] * .75) < .00001);
});

test('v2 accepts null and hashed covers; v1 works without covers', () => {
  const make = cover => ({ ...exported([album(1, [1], { cover })]), schema_version: 2 });
  for (const cover of [null, `cover-${'a'.repeat(64)}.jpg`]) assert.doesNotThrow(() => validateExport(make(cover)));
  for (const cover of [undefined, '../art.jpg', 'https://example.com/art.jpg', 'cover-abc.jpg', 3]) {
    assert.throws(() => validateExport(make(cover)));
  }
});


test('optional large artwork keeps legacy exports compatible and rejects unsafe paths', () => {
  const make = cover_large => ({ ...exported([album(1, [1], { cover: null, cover_large })]), schema_version: 2 });
  for (const value of [undefined, null, `cover-${'a'.repeat(64)}.jpg`]) {
    assert.doesNotThrow(() => validateExport(make(value)));
  }
  for (const value of ['../art.jpg', 'https://example.com/art.jpg', 'cover-abc.jpg', 3]) {
    assert.throws(() => validateExport(make(value)), /large cover filename/);
  }
});
