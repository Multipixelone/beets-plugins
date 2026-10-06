// Pure scoring and a serialized, latest-input-only query controller.
import { decodeLayoutVector } from './logic.mjs';
export function textVectors(albums) {
  return albums.map(album => {
    if (album.text_vector == null) return null;
    const vector = decodeLayoutVector(album.text_vector), norm = Math.hypot(...vector);
    return Float32Array.from(vector, value => value / norm);
  });
}
export function phraseScores(vectors, query) {
  if (!Array.isArray(query) || query.length !== 512 || query.some(x => typeof x !== 'number' || !Number.isFinite(x))) {
    throw new Error('Invalid text embedding from server.');
  }
  const norm = Math.hypot(...query);
  if (!Number.isFinite(norm) || norm === 0) throw new Error('Invalid text embedding norm.');
  const cosines = vectors.map(vector => vector === null ? null :
    Math.max(-1, Math.min(1, vector.reduce((sum, value, d) => sum + value * query[d] / norm, 0))));
  const known = cosines.filter(x => x !== null);
  const mean = known.reduce((a, b) => a + b, 0) / (known.length || 1);
  const std = Math.sqrt(known.reduce((sum, score) => sum + (score - mean) ** 2, 0) / (known.length || 1));
  return { cosines, salience: cosines.map(score => score === null ? null : std < 1e-8 ? 0 : (score - mean) / std) };
}
export function topMatches(albums, cosines, matches, limit = 10) {
  return matches.filter(i => cosines[i] !== null)
    .sort((a, b) => cosines[b] - cosines[a] || albums[a].id - albums[b].id).slice(0, limit);
}
export class PhraseSearch {
  constructor({ request, change, delay = 400 }) {
    Object.assign(this, { request, change, delay });
    this.revision = 0; this.busy = false;
  }
  set(value) {
    this.value = value.trim(); this.revision++; clearTimeout(this.timer); this.ready = false;
    this.change({ status: this.value ? 'Waiting to search…' : '', result: null });
    if (this.value) this.timer = setTimeout(() => { this.ready = true; this.run(); }, this.delay);
  }
  async run() {
    if (this.busy || !this.ready || !this.value) return;
    const revision = this.revision, value = this.value;
    this.busy = true; this.ready = false;
    this.change({ status: 'Searching… First query loads the CPU model.', result: null });
    try {
      const result = await this.request(value);
      if (revision === this.revision) this.change({ status: '', result });
    } catch (error) {
      if (revision === this.revision) this.change({ status: error.message, result: null });
    } finally {
      this.busy = false; this.run();
    }
  }
}
