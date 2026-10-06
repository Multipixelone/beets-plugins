import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateExport, similarityCache, buildEdges, communities, pointSizes, groups, searchMatches } from '../logic.mjs';
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

test('v2 accepts null and hashed covers; v1 works without covers', () => {
  const make = cover => ({ ...exported([album(1, [1], { cover })]), schema_version: 2 });
  for (const cover of [null, `cover-${'a'.repeat(64)}.jpg`]) assert.doesNotThrow(() => validateExport(make(cover)));
  for (const cover of [undefined, '../art.jpg', 'https://example.com/art.jpg', 'cover-abc.jpg', 3]) {
    assert.throws(() => validateExport(make(cover)));
  }
});
