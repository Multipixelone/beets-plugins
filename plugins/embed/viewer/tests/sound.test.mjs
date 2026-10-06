import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeColumn, soundGroup, selectionState, soundSections, groupLabels, placeLabels } from '../sound.mjs';
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
test('labels prioritize trained classes and garnish; clutter and far zoom suppression', () => {
  const labels = groupLabels(albums, ['A', 'B', 'A']);
  assert.equal(labels[0].text, 'Boom Bap · gritty · sample-heavy');
  assert.equal(labels[1].text, 'B');
  const candidates = [{ text: 'Boom Bap', x: 100, y: 100 }, { text: 'gritty', x: 105, y: 100 }, { text: 'lush', x: 300, y: 100 }];
  assert.equal(placeLabels(candidates, 500, 500, .5).length, 0);
  assert.equal(placeLabels(candidates, 500, 500, 2).length, 2);
  assert.equal(placeLabels(candidates, 500, 500, 2, 1).length, 1);
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
