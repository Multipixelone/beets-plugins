import { validateExport, similarityCache, buildEdges, communities } from './logic.mjs';
let cache, albums;
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'load') {
      albums = validateExport(data.export).albums;
      cache = similarityCache(albums);
    }
    if (!cache) throw new Error('Load an export first.');
    const edges = buildEdges(cache, data.options);
    const clusters = communities(albums, edges);
    self.postMessage({ generation: data.generation, revision: data.revision, edges, clusters });
  } catch (error) {
    self.postMessage({ generation: data.generation, revision: data.revision, error: error.message });
  }
};
