// DOM-free data and graph logic, shared by the browser worker and Node tests.
import { decodeColumn, expandSounds, soundGroup } from './sound.mjs';

export function decodeLayoutVector(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') throw new Error('Invalid layout vector.');
  const bytes = atob(value);
  return Float32Array.from(bytes, byte => {
    const number = byte.charCodeAt(0);
    return (number > 127 ? number - 256 : number) / 127;
  });
}
export function validateExport(data) {
  if (!data || ![1, 2, 3].includes(data.schema_version) || typeof data.model_id !== 'string' ||
      typeof data.exported_at !== 'string' || !Array.isArray(data.albums)) {
    throw new Error('Expected an album graph export with schema_version 1, 2 or 3.');
  }
  const ids = new Set();
  let dimension;
  for (const album of data.albums) {
    if (!album || !Number.isInteger(album.id) || album.id < 1 || ids.has(album.id)) {
      throw new Error('Album IDs must be unique positive integers.');
    }
    ids.add(album.id);
    if (data.schema_version >= 2 && album.cover !== null &&
        (typeof album.cover !== 'string' || !/^cover-[0-9a-f]{64}\.jpg$/.test(album.cover))) {
      throw new Error('Invalid cover filename.');
    }
    for (const key of ['album', 'albumartist', 'genre']) {
      if (typeof album[key] !== 'string') throw new Error(`Invalid album ${key}.`);
    }
    if (!Number.isInteger(album.year) || album.year < 0) throw new Error('Invalid album year.');
    if (!Number.isInteger(album.track_count) || album.track_count < 1 ||
        !Number.isInteger(album.embedded_tracks) || album.embedded_tracks < 1 ||
        album.embedded_tracks > album.track_count) throw new Error('Invalid track coverage.');
    for (const key of ['summed_plays', 'mean_plays']) {
      if (!Number.isFinite(album[key]) || album[key] < 0) throw new Error(`Invalid ${key}.`);
    }
    if (typeof album.vector === 'string' && (data.schema_version !== 3 || data.vector_encoding !== 'int8-base64')) {
      throw new Error('Unknown layout vector encoding.');
    }
    const vector = decodeLayoutVector(album.vector);
    if (!vector.length || vector.some(x => !Number.isFinite(x)) || !vector.some(x => x !== 0)) {
      throw new Error('Vectors must be nonzero finite numeric arrays.');
    }
    dimension ??= vector.length;
    if (vector.length !== dimension || (typeof album.vector === 'string' && data.vector_dimension !== dimension)) {
      throw new Error('Inconsistent vector dimensions.');
    }
  }
  if (data.schema_version === 3) {
    if (!Array.isArray(data.labels) || data.labels.length > 2048) throw new Error('Invalid label catalog.');
    const labels = new Set();
    for (const column of data.labels) {
      if (typeof column.id !== 'string' || labels.has(column.id) || typeof column.label !== 'string' ||
          typeof column.source !== 'string' || !['probability', 'category', 'relative', 'zscore'].includes(column.kind) ||
          typeof column.scores !== 'string' || column.scores.length > Math.ceil(data.albums.length / 3) * 4) {
        throw new Error('Invalid sound label.');
      }
      labels.add(column.id); decodeColumn(column, data.albums.length);
    }
    expandSounds(data);
  }
  return data;
}

export function similarityCache(albums) {
  const n = albums.length;
  const normalized = albums.map(a => {
    const vector = decodeLayoutVector(a.vector);
    const norm = Math.hypot(...vector);
    if (!Number.isFinite(norm) || norm === 0) throw new Error('Invalid vector norm.');
    return Float32Array.from(vector, x => x / norm);
  });
  const scores = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    scores[i * n + i] = 1;
    for (let j = i + 1; j < n; j++) {
      let score = 0;
      for (let d = 0; d < normalized[i].length; d++) score += normalized[i][d] * normalized[j][d];
      scores[i * n + j] = scores[j * n + i] = Math.max(-1, Math.min(1, score));
    }
  }
  const neighbors = albums.map((_, i) =>
    Uint32Array.from(Array.from({ length: n }, (_, j) => j).filter(j => j !== i)
      .sort((a, b) => scores[i * n + b] - scores[i * n + a] || albums[a].id - albums[b].id)));
  return { n, scores, neighbors };
}

export function buildEdges(cache, { useK = true, k = 8, useThreshold = true, threshold = 0.7 } = {}) {
  const { n, scores, neighbors } = cache;
  const edges = [];
  if (!useK && !useThreshold) return edges;
  const count = useK ? Math.max(0, Math.min(n - 1, Math.floor(k))) : n - 1;
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    for (const j of neighbors[i].subarray(0, count)) {
      const score = scores[i * n + j];
      if (useThreshold && score < threshold) continue;
      const source = Math.min(i, j), target = Math.max(i, j);
      const key = source * n + target;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push({ source, target, similarity: score, weight: Math.max(0.001, (score + 1) / 2) });
      }
    }
  }
  return edges;
}

export function communities(albums, edges) {
  const adjacency = albums.map(() => []);
  for (const { source, target, weight } of edges) {
    adjacency[source].push([target, weight]);
    adjacency[target].push([source, weight]);
  }
  const labels = albums.map(a => a.id);
  const order = albums.map((_, i) => i).sort((a, b) => albums[a].id - albums[b].id);
  for (let sweep = 0; sweep < 30; sweep++) {
    let changed = false;
    for (const i of order) {
      const votes = new Map();
      for (const [j, weight] of adjacency[i]) votes.set(labels[j], (votes.get(labels[j]) || 0) + weight);
      if (!votes.size) continue;
      let best = labels[i], score = votes.get(best) || 0;
      for (const [label, vote] of [...votes].sort((a, b) => a[0] - b[0])) {
        // Retain the current label on equal support to prevent oscillation.
        if (vote > score + 1e-10) { best = label; score = vote; }
      }
      if (best !== labels[i]) { labels[i] = best; changed = true; }
    }
    if (!changed) break;
  }
  const unique = [...new Set(labels)].sort((a, b) => a - b);
  const indices = new Map(unique.map((label, i) => [label, i]));
  return labels.map(label => indices.get(label));
}

export function groups(albums, mode, clusters) {
  return albums.map((a, i) => {
    const sound = soundGroup(a, mode);
    if (sound !== undefined) return sound;
    if (mode === 'cluster') return `Cluster ${(clusters[i] ?? i) + 1}`;
    if (mode === 'year') return a.year ? String(a.year) : 'Unknown';
    if (mode === 'decade') return a.year ? `${Math.floor(a.year / 10) * 10}s` : 'Unknown';
    return a[mode]?.trim() || 'Unknown';
  });
}

export function pointSizes(albums, metric) {
  if (metric === 'uniform') return new Float32Array(albums.length).fill(12);
  const values = albums.map(a => a[metric]);
  const maximum = Math.max(1, ...values);
  return Float32Array.from(values, value => 8 + 28 * Math.sqrt(value / maximum));
}

export function searchMatches(albums, search) {
  const needle = search.trim().toLocaleLowerCase();
  return albums.flatMap((a, i) =>
    `${a.album}\n${a.albumartist}`.toLocaleLowerCase().includes(needle) ? [i] : []);
}

// Auto alone applies the zoom/count cutoffs. Forced covers still use a bounded atlas.
export function showCovers(mode, zoom, count, threshold = 1) {
  return mode === 'covers' || (mode === 'auto' && zoom >= threshold && count <= 1000);
}

export function coverCandidates(albums, visible, priority = [], capacity = 256) {
  const onScreen = new Set(visible);
  const seen = new Set();
  const result = [];
  for (const index of [...priority, ...visible]) {
    if (result.length >= capacity) break;
    if (onScreen.has(index) && albums[index]?.cover && !seen.has(index)) {
      seen.add(index); result.push(index);
    }
  }
  return result;
}
