import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { vibeAppearance, vibeLinkOpacity, matchBounds, GatherAppearance } from '../vibe.mjs';
import { selectionState } from '../sound.mjs';
import { FilterPositions } from '../visibility.mjs';
import { VibeGraph } from '../cosmos-vibe.mjs';

const albums = [
  { id: 1, album: 'One', albumartist: 'Finn', essentia: { danceable: { value: .8 } } },
  { id: 2, album: 'Two', albumartist: 'Other', essentia: { danceable: { value: .2 } } },
  { id: 3, album: 'Unknown', albumartist: 'Finn' },
];
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
test('gather appearance animates enlarged matches and readable background, then restores plain vibes', () => {
  const states = selectionState(albums, { phraseScores: [.5, 4, null] }).states;
  const original = structuredClone(states), appearance = new GatherAppearance();
  appearance.set([0, 1], 1, 0);
  assert.equal(appearance.size(0), 1);
  assert.equal(appearance.opacity(states[2], true), .15);
  appearance.frame(225);
  close(appearance.size(0), 1.175);
  close(appearance.opacity(states[2], true), .275);
  appearance.frame(450);
  close(states[0].size * appearance.size(0), 1.15 * 1.35);
  close(states[1].size * appearance.size(1), 2 * 1.35);
  assert.equal(appearance.size(2), 1);
  assert.equal(appearance.opacity(states[2], true), .40);
  const effective = states.map(state => ({ ...state, opacity: appearance.opacity(state, true) }));
  assert.equal(vibeLinkOpacity({ source: 0, target: 2 }, effective), .40);
  assert.equal(vibeLinkOpacity({ source: 0, target: 1 }, effective), .70);
  assert.equal(appearance.opacity({ ...states[2], visible: false, opacity: 0 }, true), 0);
  assert.equal(appearance.opacity(states[2], false), .15);
  assert.deepEqual(states, original, 'display changes never mutate selection or collision inputs');
  appearance.set([], 1, 500);
  close(appearance.size(0), 1.35);
  appearance.frame(725);
  close(appearance.size(0), 1.175);
  close(appearance.opacity(states[2], true), .275);
  appearance.frame(950);
  assert.equal(appearance.size(0), 1);
  assert.equal(appearance.opacity(states[2], true), .15);
  assert.equal(appearance.transitions.size, 0);
  assert.equal(appearance.sizes.size, 0);
});
test('gather appearance handles fitted footprints, interrupted toggles and immediate reduced motion', () => {
  const appearance = new GatherAppearance();
  appearance.set([0], .5, 0);
  appearance.frame(225);
  close(appearance.size(0), (1 + .5 * 1.35) / 2);
  const current = appearance.size(0);
  appearance.set([], 1, 225);
  assert.equal(appearance.size(0), current);
  appearance.set([0], 1, 225);
  assert.equal(appearance.size(0), current);
  appearance.frame(675);
  close(appearance.size(0), 1.35);
  appearance.set([1], .5, 700, 0);
  assert.equal(appearance.size(0), 1);
  close(appearance.size(1), .675);
  assert.equal(appearance.background, 1);
  assert.equal(appearance.transitions.size, 0);
  appearance.set([], 1, 701, 0);
  assert.equal(appearance.size(1), 1);
  assert.equal(appearance.background, 0);
});
test('renderer boosts dots and artwork without changing collision sizes, and restores display sizes', async () => {
  const source = await readFile(new URL('../app.mjs', import.meta.url), 'utf8');
  const renderer = source.slice(source.indexOf('function updateCoverSizes()'), source.indexOf('function resizeArtwork()'));
  for (const coverActive of [false, true]) {
    const appearance = new GatherAppearance(), output = {};
    const context = {
      graphReady: true, coverActive, coverGeometry: '', geometryScale: 1, gatherScale: .8,
      selected: 0, atlasEntries: [], data: { albums: albums.map(album => ({ ...album, cover: 'cover.jpg' })) },
      selection: selectionState(albums, { phraseScores: [.5, 4, null] }),
      gather: { saved: new Map([[0, []], [1, []]]) }, gatherAppearance: appearance,
      gatheredScale: index => appearance.size(index), visibleAlbum: () => true,
      pointSizes: () => [20, 20, 20], artworkSizes: () => [80, 80, 80],
      $: () => ({ value: '1' }), coverURL: name => name,
      vibeGraph: { collisionSizes: sizes => { output.collisions = [...sizes]; } },
      graph: { setPointImageIndices() {}, setPointShapes() {},
        setPointImageSizes: sizes => { output.artwork = [...sizes]; },
        setPointSizes: sizes => { output.points = [...sizes]; } },
    };
    runInNewContext(`${renderer}; updateCoverSizes();`, context);
    const baseline = structuredClone(output);
    appearance.set([0, 1], .8, 0);
    for (const time of [225, 450]) {
      appearance.frame(time);
      runInNewContext('updateCoverSizes();', context);
      assert.deepEqual(output.collisions, baseline.collisions);
      close(output.artwork[0], baseline.artwork[0] * appearance.size(0));
    }
    close(output.points[0], baseline.points[0] * .8 * 1.35);
    assert.equal(output.points[2], baseline.points[2]);
    appearance.set([], 1, 500);
    appearance.frame(950);
    runInNewContext('updateCoverSizes();', context);
    assert.deepEqual(output, baseline);
  }
});
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
