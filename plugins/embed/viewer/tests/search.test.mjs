import test from 'node:test';
import assert from 'node:assert/strict';
import { textVectors, phraseScores, topMatches, PhraseSearch } from '../search.mjs';
import { selectionState } from '../sound.mjs';
import { validateExport } from '../logic.mjs';
const encoded = first => btoa(String.fromCharCode(first, ...new Array(511).fill(0)));
const vector = [1, ...new Array(511).fill(0)];
const albums = [
  { id: 3, album: 'One', albumartist: 'Finn', text_vector: encoded(127) },
  { id: 2, album: 'Two', albumartist: 'Finn', text_vector: encoded(127) },
  { id: 4, album: 'Three', albumartist: 'Other', text_vector: encoded(129) },
  { id: 5, album: 'Unknown', albumartist: 'Finn', text_vector: null },
];
test('cosines normalize decoded vectors, retain missing and rank ties by ID', () => {
  const result = phraseScores(textVectors(albums), vector.map(x => x * 2));
  assert.deepEqual(result.cosines, [1, 1, -1, null]);
  const state = selectionState(albums, { phraseScores: result.salience });
  assert.deepEqual(state.matches, [0, 1]);
  assert.equal(state.states[3].opacity, 0.15);
  assert.equal(state.states[3].visible, true);
  assert.ok(state.states[0].size > 1);
  assert.deepEqual(topMatches(albums, result.cosines, state.matches), [1, 0]);
  assert.deepEqual(topMatches(albums, result.cosines, state.matches, 1), [1]);
  assert.throws(() => phraseScores(textVectors(albums), []), /Invalid/);
  assert.throws(() => phraseScores(textVectors(albums), vector.map(() => 0)), /norm/);
  assert.throws(() => phraseScores(textVectors(albums), vector.map(() => NaN)), /Invalid/);
  assert.deepEqual(phraseScores(textVectors(albums.slice(0, 2)), vector).salience, [0, 0]);
});
test('phrase lens intersects labels, name and filters; clearing restores baseline', () => {
  const scores = phraseScores(textVectors(albums), vector).salience;
  assert.deepEqual(selectionState(albums, {phraseScores: scores, search: 'two'}).matches, [1]);
  assert.deepEqual(selectionState(albums, {phraseScores: scores, lens: {kind:'zscore'}, scores:[0, 2, 3, null]}).matches, [1]);
  assert.deepEqual(selectionState(albums, {phraseScores: scores, danceMin:.5}).matches, []);
  assert.deepEqual(selectionState(albums, {phraseScores: scores, danceMin:.5, includeUnknown:true}).matches, [0, 1]);
  assert.ok(selectionState(albums).states.every(s => s.opacity === 1 && s.size === 1));
});
test('new text vector metadata validates while legacy exports remain usable', () => {
  const album = {...albums[0], genre:'', year:0, track_count:1, embedded_tracks:1, summed_plays:0, mean_plays:0,
    cover:null, vector:[1,0]};
  const data = {schema_version:3, model_id:'style:test', exported_at:'now', albums:[album], labels:[],
    text_model_id:'text:test', text_vector_encoding:'int8-base64', text_vector_dimension:512};
  assert.equal(validateExport(data), data);
  assert.throws(() => validateExport({...data, text_vector_dimension:1280}), /text vector/);
  assert.throws(() => validateExport({...data, albums:[{...album,text_vector:encoded(0)}]}), /text vector/);
  assert.throws(() => validateExport({...data, albums:[{...album,text_vector:'AQ=='}]}), /text vector/);
  assert.equal(validateExport({...data, albums:[{...album,text_vector:null}]}).albums.length, 1);
  assert.equal(validateExport({...data, text_vector_encoding:undefined, albums:[{...album,text_vector:undefined}]}).albums.length, 1);
});
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
test('debounces, serializes latest phrase and ignores stale and cleared responses', async () => {
  const calls = [], changes = [], pending = [];
  const search = new PhraseSearch({delay:1, change:value=>changes.push(value), request:q=>{
    calls.push(q); return new Promise((resolve,reject)=>pending.push({resolve,reject}));
  }});
  search.set('old'); search.set('first'); await tick();
  assert.deepEqual(calls, ['first']);
  search.set('second'); search.set('last'); await tick();
  assert.deepEqual(calls, ['first']);
  pending[0].resolve('stale'); await tick();
  assert.deepEqual(calls, ['first','last']);
  assert.ok(changes.every(c=>c.result !== 'stale'));
  search.set(''); pending[1].resolve('cleared'); await tick();
  assert.equal(changes.at(-1).status, '');
  assert.ok(changes.every(c=>c.result !== 'cleared'));
  search.set('failure'); await tick(); pending[2].reject(new Error('missing model')); await tick();
  assert.equal(changes.at(-1).status, 'missing model');
});
