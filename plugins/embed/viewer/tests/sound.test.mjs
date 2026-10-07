import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeColumn, soundGroup, selectionState, soundSections, groupLabels, placeLabels, representativeLabelAnchors } from '../sound.mjs';
import { groups, validateExport } from '../logic.mjs';
const albums = [
  { album: 'One', albumartist: 'Finn', sound: { style: { labels: [{ label: 'Hip Hop---Boom Bap', score: .8 }], count: 1, total: 3 },
      flavor: { labels: [{ label: 'gritty', score: 2 }, { label: 'sample-heavy', score: 1.5 }], count: 1, total: 3 } },
    essentia: { danceable: { value: .8, count: 2, total: 3 }, voice_instrumental: { value: 'voice', count: 2, total: 3 } } },
  { album: 'Two', albumartist: 'Other', essentia: { danceable: { value: .2 }, voice_instrumental: { value: 'instrumental' } } },
  { album: 'Three', albumartist: 'Finn' },
];
test('score columns distinguish zero from missing and calibrate z ranges', () => {
  const column = { min: 0, max: 1, scores: btoa(String.fromCharCode(1, 255, 0)) };
  assert.deepEqual(decodeColumn(column, 3), [0, 1, null]);
  assert.deepEqual(decodeColumn({ ...column, min: -4, max: 4 }, 3), [-4, 4, null]);
  assert.throws(() => decodeColumn(column, 2), /Invalid/);
});
test('sound grouping and legacy albums without labels', () => {
  assert.equal(soundGroup(albums[0], 'style'), 'Boom Bap (Hip Hop)');
  assert.equal(soundGroup(albums[0], 'flavor'), 'gritty');
  assert.deepEqual(groups(albums, 'style', []), ['Boom Bap (Hip Hop)', 'Unknown', 'Unknown']);
  assert.notEqual(soundGroup({sound:{style:{labels:[{label:'Rock---Gospel'}]}}}, 'style'),
                  soundGroup({sound:{style:{labels:[{label:'Blues---Gospel'}]}}}, 'style'));
  assert.deepEqual(soundSections(albums[2]), []);
  assert.equal(soundSections(albums[0])[0].coverage, '1/3 tracks');
});
test('lens and name search intersect; clear restores sizes and opacity', () => {
  const lens = { kind: 'zscore', source: 'clap' };
  const state = selectionState(albums, { lens, scores: [2, 1, null], search: 'finn' });
  assert.deepEqual(state.matches, [0]);
  assert.ok(state.states[0].size > 1);
  assert.equal(state.states[1].opacity, 0);
  const cleared = selectionState(albums);
  assert.equal(cleared.active, false);
  assert.ok(cleared.states.every(s => s.size === 1 && s.opacity === 1));
  assert.deepEqual(selectionState(albums, { lens, scores: [0, -.2, null] }).matches, []);
});
test('Essentia filters hide unknowns unless included; missing is never zero', () => {
  assert.deepEqual(selectionState(albums, { danceMin: .5, vocal: 'voice' }).matches, [0]);
  assert.deepEqual(selectionState(albums, { danceMin: .5, vocal: 'voice', includeUnknown: true }).matches, [0, 2]);
  assert.deepEqual(selectionState(albums, { vocal: 'instrumental' }).matches, [1]);
  assert.deepEqual(selectionState(albums, { danceMax: .3 }).matches, [1]);
});
test('labels keep concise names separate from interaction descriptions', () => {
  const labels = groupLabels(albums, ['A', 'B', 'A']);
  assert.equal(labels[0].text, 'Boom Bap');
  assert.equal(labels[0].description, 'Boom Bap · gritty · sample-heavy');
  assert.equal(labels[1].text, 'B');
  const candidates = [{ text: 'Boom Bap', x: 100, y: 100 }, { text: 'gritty', x: 105, y: 100 }, { text: 'lush', x: 300, y: 100 }];
  assert.equal(placeLabels(candidates, 500, 500, .5).length, 0);
  assert.equal(placeLabels(candidates, 500, 500, 2).length, 3);
  assert.equal(placeLabels(candidates, 500, 500, 2, 1).length, 1);
});
test('long descriptions remain available without duplicate style or flavor words', () => {
  const phrase = 'sparkling synth arpeggios and slowly evolving layered harmonies';
  const album = { id: 1, sound: { style: { labels: [{ label: 'Electronic---Chiptune', score: 1 }] },
    flavor: { labels: [{ label: 'chiptune', score: 4 }, { label: 'CHIPTUNE', score: 3 },
      { label: phrase, score: 1.5 }, { label: 'sample-heavy', score: 2 }, { label: 'sample_heavy', score: 1.8 }] } } };
  const [label] = groupLabels([album], ['A']);
  assert.equal(label.text, 'Chiptune');
  assert.equal(label.description, `Chiptune · sample-heavy · ${phrase}`);
  assert.equal(label.description.includes('…'), false);
});
test('representative anchors favor internal connections and survive album reorder', () => {
  const library = [40, 30, 20, 10, 50].map(id => ({ id }));
  const edges = [[0, 1, 1], [0, 2, 1], [0, 3, 1], [1, 2, 1], [1, 3, 1], [2, 3, 1], [0, 4, 15]]
    .map(([source, target, weight]) => ({ source, target, weight }));
  const anchors = representativeLabelAnchors(library, [0, 1, 2, 3], edges, 2);
  assert.deepEqual(anchors.map(i => library[i].id), [10, 20]);
  const order = [2, 4, 0, 3, 1], reordered = order.map(i => library[i]);
  const remapped = edges.map(edge => ({ ...edge, source: order.indexOf(edge.source), target: order.indexOf(edge.target) }));
  assert.deepEqual(representativeLabelAnchors(reordered, [0, 2, 3, 4], remapped, 2).map(i => reordered[i].id), [10, 20]);
  const labels = groupLabels(library, ['A', 'A', 'A', 'A', 'B'], () => true, { edges, anchorCount: 2 });
  assert.deepEqual(labels[0].tracked, anchors);
  assert.equal(groupLabels(library, ['A', 'A', 'A', 'A', 'B'], i => i !== 3, { edges })[0].tracked.includes(3), false);
});
test('placement avoids covers and other labels, retaining safe offsets across passes', () => {
  const candidates = [{ name: 'A', text: 'Ambient', x: 100, y: 100, width: 70, height: 20 },
    { name: 'B', text: 'House', x: 102, y: 100, width: 50, height: 20 }];
  const obstacle = { left: 90, right: 110, top: 90, bottom: 110 };
  const placed = placeLabels(candidates, 400, 300, .5, 24, { minZoom: 0, obstacles: [obstacle] });
  assert.equal(placed.length, 2);
  assert.deepEqual([placed[0].dx, placed[0].dy], [0, -26]);
  assert.deepEqual([placed[1].dx, placed[1].dy], [0, 26]);
  const previous = new Map(placed.map(label => [label.name, label]));
  const next = placeLabels(candidates, 400, 300, 2, 24, { previous });
  assert.deepEqual(next, placed); // Removing an obstacle does not snap labels back to their anchors.
  assert.equal(placeLabels(candidates, 400, 300, 2, 24,
    { obstacles: [{ left: 0, right: 400, top: 0, bottom: 300 }] }).length, 0);
});
test('labels never silently shrink their collision box for long text', () => {
  const placed = placeLabels([{ text: 'A long name', x: 170, y: 100, width: 320, height: 20 }], 340, 200, 2);
  assert.equal(placed[0].rect.right - placed[0].rect.left, 320);
  assert.equal(placeLabels([{ text: 'Wide', x: 170, y: 100, width: 360, height: 20 }], 340, 200, 2).length, 0);
});
test('labels find room beyond the immediate cover footprint without wandering far', () => {
  const obstacle = { left: 160, right: 300, top: 130, bottom: 270 };
  const candidates = [{ name: 'core', text: 'Ambient', x: 230, y: 200, width: 70, height: 20 }];
  const [label] = placeLabels(candidates, 500, 400, 1, 24, { obstacles: [obstacle] });
  assert.ok(label);
  assert.ok(Math.hypot(label.dx, label.dy) > 70);
  assert.ok(Math.hypot(label.dx, label.dy) <= 120);
  assert.ok(label.rect.bottom + 6 <= obstacle.top);
  assert.equal(placeLabels(candidates, 500, 400, 1, 24, { obstacles: [obstacle], maxOffset: 60 }).length, 0);
});
test('visible representative anchors label communities whose main core is offscreen', () => {
  const candidate = { name: 'community', text: 'Jazz', x: -300, y: 200, width: 60, height: 20,
    anchors: [{ id: 42, x: 140, y: 150 }, { id: 79, x: 270, y: 180 }] };
  const obstacles = [{ left: 120, right: 160, top: 130, bottom: 170 }];
  const [first] = placeLabels([candidate], 500, 400, 1, 24, { obstacles });
  assert.equal(first.anchorId, 79);
  const previous = new Map([['community', { anchorId: first.anchorId, dx: first.dx, dy: first.dy }]]);
  const [next] = placeLabels([{ ...candidate, anchors: [...candidate.anchors].reverse() }], 500, 400, 1, 24, { previous });
  assert.equal(next.anchorId, 79);
  assert.deepEqual([next.x, next.y], [first.x, first.y]);
});
test('expanded searches still avoid obstacles across spatial bin boundaries', () => {
  const obstacles = Array.from({ length: 40 }, (_, i) => ({ left: i % 8 * 61 + 3,
    right: i % 8 * 61 + 43, top: Math.floor(i / 8) * 75 + 3, bottom: Math.floor(i / 8) * 75 + 43 }));
  const labels = placeLabels([{ name: 'A', text: 'Sparse', x: 190, y: 200, width: 74, height: 20 },
    { name: 'B', text: 'Other', x: 380, y: 270, width: 60, height: 20 }], 520, 400, 1, 24, { obstacles });
  assert.equal(labels.length, 2);
  for (const { rect } of labels) for (const other of obstacles) assert.ok(
    rect.right + 6 <= other.left || rect.left >= other.right + 6 || rect.bottom + 6 <= other.top || rect.top >= other.bottom + 6);
});
test('v3 validates packed columns and still accepts v1/v2', () => {
  const album = { ...albums[0], id: 1, genre: '', year: 2001, track_count: 3, embedded_tracks: 1,
                  summed_plays: 0, mean_plays: 0, vector: [1, 0], cover: null };
  const exported = { schema_version: 3, model_id: 'style:test', exported_at: 'now', albums: [album],
                     labels: [{ id: 'style:A', label: 'A', source: 'style', kind: 'probability', min: 0, max: 1, scores: '/w==' }] };
  assert.equal(validateExport(exported), exported);
  for (const version of [1, 2]) assert.equal(validateExport({ ...exported, schema_version: version }).schema_version, version);
  assert.throws(() => validateExport({ ...exported, labels: [{ ...exported.labels[0], scores: '' }] }), /Invalid/);
});
test('compact v3 reconstructs labels/coverage idempotently and decodes signed layout vectors', async () => {
  const {decodeLayoutVector, similarityCache} = await import('../logic.mjs');
  const encoded = btoa(String.fromCharCode(127, 129)); // +127, -127
  assert.deepEqual([...decodeLayoutVector(encoded)], [1, -1]);
  const album = { id: 1, album: 'One', albumartist: 'Finn', genre: '', year: 2001,
    track_count: 3, embedded_tracks: 1, summed_plays: 0, mean_plays: 0, cover: null, vector: encoded,
    sound: {style:{labels:[[0, .8]], count:1}}, essentia: [[.8, 2], null, [null, 2]] };
  const data = {schema_version:3, model_id:'style:test', exported_at:'now', albums:[album],
    vector_encoding:'int8-base64', vector_dimension:2, sound_encoding:'catalog-pairs-v1',
    essentia_fields:['danceable','is_voice','gender'],
    labels:[{id:'style:A', label:'Hip Hop---Boom Bap', source:'style', kind:'probability', min:0, max:1, scores:'/w=='}]};
  validateExport(data); validateExport(data);
  assert.equal(album.sound.style.labels[0].label, 'Hip Hop---Boom Bap');
  assert.equal(album.sound.style.total, 3);
  assert.deepEqual(album.essentia.danceable, {value:.8,count:2,support:null,total:3});
  assert.equal(album.essentia.is_voice.value, null);
  assert.equal(album.essentia.gender.count, 2);
  assert.equal(selectionState(data.albums,{danceMin:.5}).matches.length, 1);
  assert.ok(Math.abs(similarityCache([{vector:encoded},{vector:[1,-1]}]).scores[1] - 1) < 1e-6);
  assert.throws(() => validateExport({...data,vector_dimension:3}), /dimensions/);
});
