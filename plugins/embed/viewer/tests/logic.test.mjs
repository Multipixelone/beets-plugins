import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateExport, similarityCache, buildEdges, communities, seedPositions, pointSizes, artworkSizes, groups, searchMatches } from '../logic.mjs';
const album = (id, vector, extra = {}) => ({ id, vector, album: `Album ${id}`, albumartist: 'Finn', genre: 'Folk',
  year: 2001, track_count: 3, embedded_tracks: 2, summed_plays: 16, mean_plays: 16 / 3, ...extra });
const exported = albums => ({ schema_version: 1, model_id: 'style:v1', exported_at: '2026-10-05T00:00:00Z', albums });

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
