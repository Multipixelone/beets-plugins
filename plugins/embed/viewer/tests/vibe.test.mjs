import test from 'node:test';
import assert from 'node:assert/strict';
import { vibeAppearance, vibeLinkOpacity, matchBounds } from '../vibe.mjs';
import { selectionState } from '../sound.mjs';
import { FilterPositions } from '../visibility.mjs';
import { VibeGraph } from '../cosmos-vibe.mjs';

const albums = [
  { id: 1, album: 'One', albumartist: 'Finn', essentia: { danceable: { value: .8 } } },
  { id: 2, album: 'Two', albumartist: 'Other', essentia: { danceable: { value: .2 } } },
  { id: 3, album: 'Unknown', albumartist: 'Finn' },
];
test('salience curve enlarges every match and clamps stronger size, opacity and brightness', () => {
  assert.deepEqual(vibeAppearance(.5), { match: true, size: 1.15, opacity: .7, brightness: 1.05 });
  assert.deepEqual(vibeAppearance(4), { match: true, size: 2, opacity: 1, brightness: 1.25 });
  assert.deepEqual(vibeAppearance(100), vibeAppearance(4));
  for (const score of [null, undefined, NaN, Infinity, -.5, .499]) {
    assert.deepEqual(vibeAppearance(score), { match: false, size: 1, opacity: .15, brightness: 1 });
  }
  for (const score of [.5, 1, 2, 3]) for (const property of ['size', 'opacity', 'brightness']) {
    assert.ok(vibeAppearance(score)[property] < vibeAppearance(score + .5)[property]);
  }
});
test('attribute visibility wins over vibes; non-matches stay finite and clearing restores filters', () => {
  const options = { search: 'finn', danceMin: .5, includeUnknown: true };
  const baseline = selectionState(albums, options);
  const vibe = selectionState(albums, { ...options, phraseScores: [1, 4, null] });
  assert.deepEqual(vibe.visibleIndices, [0, 2]);
  assert.deepEqual(vibe.matches, [0]);
  assert.equal(vibe.states[1].opacity, 0);
  assert.equal(vibe.states[2].opacity, .15);
  const positions = new FilterPositions(3); positions.seed([1, 2, 3, 4, 5, 6]);
  const filtered = positions.update(positions.saved, baseline.states.map(s => s.visible));
  assert.equal(positions.update(filtered, vibe.states.map(s => s.visible)), null);
  assert.equal(positions.update(filtered, selectionState(albums, options).states.map(s => s.visible)), null);
  assert.deepEqual(selectionState(albums, options), baseline);
  assert.ok(selectionState(albums).states.every(s => s.opacity === 1 && s.size === 1));
});
test('links inherit the dimmer endpoint, and a hidden endpoint remains absent', () => {
  const states = selectionState(albums, { search: 'finn', phraseScores: [4, 4, null] }).states;
  assert.equal(vibeLinkOpacity({ source: 0, target: 2 }, states), .15);
  assert.equal(vibeLinkOpacity({ source: 0, target: 1 }, states), 0);
});
test('camera bounds include cover footprints and ignore absent coordinates', () => {
  assert.deepEqual([...matchBounds([0, 1, 2], [10, 20, 100, 200, NaN, NaN], [20, 40, 10])], [0, 10, 120, 220]);
  assert.deepEqual([...matchBounds([0], [10, 20], [20])], [0, 10, 20, 30]);
  assert.equal(matchBounds([], [], []), null);
});
test('collision geometry is independent of visual scoring and leaves simulation state alone', () => {
  const graph = { graph: {}, isForceCollisionReady: true, store: { alpha: .42, isSimulationRunning: true } };
  const bridge = new VibeGraph(graph);
  bridge.collisionSizes(new Float32Array([10, 20]));
  graph.isForceCollisionReady = true;
  bridge.collisionSizes(new Float32Array([10, 20]));
  assert.equal(graph.isForceCollisionReady, true);
  assert.deepEqual(graph.store, { alpha: .42, isSimulationRunning: true });
});
