import { Graph, defaultConfigValues } from '@cosmos.gl/graph';
import { validateExport, groups, pointSizes, searchMatches, showCovers, coverCandidates } from './logic.mjs';

import { CoverLoader, decodeCover } from './covers.mjs';

const $ = id => document.getElementById(id);
let graph, worker, data, clusters = [], edges = [], selected, paused = false;
let coverLoader, coverTimer, atlasTimer, visibleCovers = [], atlasEntries = [], coverActive = false;
let dragging = false, zooming = false, graphReady = false;
const coverURL = name => new URL(`covers/${name}`, location.href).href;
function scheduleCovers() {
  if (!coverTimer) coverTimer = setTimeout(() => { coverTimer = undefined; refreshCovers(); }, 500);
}
function scheduleAtlas() {
  if (!atlasTimer) atlasTimer = setTimeout(() => { atlasTimer = undefined; updateAtlas(); }, 250);
}
function refreshCovers() {
  if (!graphReady || !coverLoader || dragging || zooming) return;
  coverActive = showCovers($('render-mode').value, graph.getZoomLevel(), data.albums.length, Number($('cover-zoom').value));
  if (!coverActive) {
    visibleCovers = []; coverLoader.setWanted([]); updateCoverSizes(); graph.render();
    $('cover-status').textContent = 'Colored dots'; return;
  }
  // Native viewport query at most twice a second, never on every animation frame.
  const { width, height } = $('graph').getBoundingClientRect();
  const visible = graph.findPointsInRect([[0, 0], [width, height]]);
  const priority = [selected, ...($('search').value.trim() ? searchMatches(data.albums, $('search').value) : [])];
  visibleCovers = coverCandidates(data.albums, visible, priority);
  coverLoader.setWanted(visibleCovers.map(i => coverURL(data.albums[i].cover)));
  scheduleAtlas();
}
function updateCoverSizes() {
  if (!graphReady) return;
  const sizes = pointSizes(data.albums, $('size').value);
  const imageSizes = Float32Array.from(sizes);
  const shapes = new Float32Array(sizes.length);
  const indices = new Float32Array(sizes.length).fill(-1);
  const atlas = new Map(atlasEntries.map(([url], i) => [url, i]));
  if (coverActive) for (const index of visibleCovers) {
    const image = atlas.get(coverURL(data.albums[index].cover));
    if (image !== undefined) { indices[index] = image; shapes[index] = 1; sizes[index] += 4; }
  }
  graph.setPointImageIndices(indices); graph.setPointImageSizes(imageSizes);
  graph.setPointShapes(shapes); graph.setPointSizes(sizes);
}
function updateAtlas() {
  if (!graphReady || !coverLoader) return;
  if (dragging || zooming) { scheduleAtlas(); return; }
  const entries = [...coverLoader.images.entries()].sort(([a], [b]) => a.localeCompare(b));
  // setImageData repacks the whole texture. Never upload an unchanged atlas.
  if (entries.length !== atlasEntries.length || entries.some(([url, image], i) =>
    url !== atlasEntries[i]?.[0] || image !== atlasEntries[i]?.[1])) {
    graph.setImageData(entries.map(([, image]) => image)); atlasEntries = entries;
  }
  updateCoverSizes(); graph.render();
  if (coverActive) $('cover-status').textContent = `${visibleCovers.filter(i => coverLoader.images.has(coverURL(data.albums[i].cover))).length} covers in view · ${coverLoader.failed.size} unavailable`;
}
let generation = 0, revision = 0, edgeTimer;
const forceSpecs = [
  ['Repulsion', 'simulationRepulsion', 0, 5, 0.05],
  ['Link strength', 'simulationLinkSpring', 0, 5, 0.05],
  ['Gravity', 'simulationGravity', 0, 2, 0.01],
  ['Cluster force', 'simulationCluster', 0, 2, 0.01],
  ['Friction (damping)', 'simulationFriction', 0, 1, 0.01],
];
const forceInputs = new Map();
for (const [name, key, min, max, step] of forceSpecs) {
  const label = document.createElement('label');
  label.append(name);
  const output = document.createElement('output');
  const input = document.createElement('input');
  Object.assign(input, { type: 'range', min, max, step, id: key });
  const initial = defaultConfigValues[key];
  input.value = key === 'simulationFriction' ? 1 - initial : initial;
  output.value = Number(input.value).toFixed(2);
  label.append(output, input); $('forces').append(label); forceInputs.set(key, input);
  input.addEventListener('input', () => {
    output.value = Number(input.value).toFixed(2);
    if (!graph) return;
    graph.setConfigPartial({ [key]: key === 'simulationFriction' ? 1 - Number(input.value) : Number(input.value) });
    reheat();
  });
}
function status(message, error = false) {
  $('status').textContent = message; $('status').classList.toggle('error', error);
}
function options() {
  return { useK: $('use-k').checked, k: Number($('k').value),
    useThreshold: $('use-threshold').checked, threshold: Number($('threshold').value) };
}
function reheat() { graph.render(); if (!paused) graph.start(0.7); }
function detailText(album) {
  return `${album.album}\n${album.albumartist}\n${album.genre || 'Unknown genre'} · ${album.year || 'Unknown year'}\n` +
    `${album.embedded_tracks}/${album.track_count} tracks embedded\n` +
    `${album.summed_plays.toLocaleString()} plays · ${album.mean_plays.toLocaleString(undefined, { maximumFractionDigits: 1 })} mean plays`;
}
function showInfo(index) {
  selected = index; scheduleCovers();
  $('details').hidden = index === undefined;
  $('info').replaceChildren();
  if (index === undefined) return;
  const album = data.albums[index];
  const title = document.createElement('h2'); title.textContent = album.album;
  const info = document.createElement('p'); info.style.whiteSpace = 'pre-line';
  info.textContent = detailText(album).split('\n').slice(1).join('\n');
  $('info').append(title, info);
  graph.setConfigPartial({ outlinedPointIndices: [index] }); graph.render();
}
function hover(index, event) {
  $('tooltip').hidden = index === undefined;
  if (index === undefined) return;
  $('tooltip').textContent = detailText(data.albums[index]);
  $('tooltip').style.whiteSpace = 'pre-line';
  if (event?.clientX !== undefined) {
    $('tooltip').style.left = `${Math.max(8, Math.min(window.innerWidth - 330, event.clientX + 14))}px`;
    $('tooltip').style.top = `${Math.max(8, Math.min(window.innerHeight - 160, event.clientY + 14))}px`;
  }
}
function color(index) {
  const h = (index * 0.61803398875) % 1;
  const rgb = [0, 8, 4].map(offset => {
    const k = (offset + h * 12) % 12;
    return 0.65 - 0.25 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  });
  return [...rgb, 1];
}
function updateGroups() {
  if (!graph || !data) return;
  const names = groups(data.albums, $('group').value, clusters);
  const unique = [...new Set(names)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const ids = new Map(unique.map((name, i) => [name, i]));
  graph.setPointClusters(names.map(name => ids.get(name)));
  graph.setPointColors(Float32Array.from(names.flatMap(name => color(ids.get(name)))));
  $('legend').replaceChildren();
  const counts = new Map();
  for (const name of names) counts.set(name, (counts.get(name) || 0) + 1);
  for (const name of unique) {
    const row = document.createElement('div'); row.className = 'legend-row';
    const swatch = document.createElement('span'); swatch.className = 'swatch';
    swatch.style.backgroundColor = `rgb(${color(ids.get(name)).slice(0, 3).map(x => Math.round(x * 255)).join(' ')})`;
    const text = document.createElement('span'); text.textContent = `${name} (${counts.get(name)})`;
    row.append(swatch, text); $('legend').append(row);
  }
}
function updateSearch() {
  if (!graph || !data) return;
  const search = $('search').value.trim();
  const matches = searchMatches(data.albums, search);
  const set = new Set(matches);
  graph.setConfigPartial({ highlightedPointIndices: search ? matches : undefined,
    highlightedLinkIndices: search ? edges.flatMap((e, i) => set.has(e.source) && set.has(e.target) ? [i] : []) : undefined });
  $('matches').textContent = search ? `${matches.length} matching albums` : '';
  graph.render(); scheduleCovers();
}
async function load(exported, name) {
  try {
    validateExport(exported);
    generation++; revision = 0; clearTimeout(edgeTimer);
    coverLoader?.destroy(); clearTimeout(coverTimer); clearTimeout(atlasTimer);
    coverTimer = atlasTimer = undefined; graphReady = false; dragging = zooming = false;
    atlasEntries = []; visibleCovers = [];
    worker?.terminate(); worker = undefined; graph?.destroy(); graph = undefined;
    data = exported;
    if (data.schema_version === 1) data.albums.forEach(album => { album.cover = null; });
    edges = []; clusters = []; selected = undefined;
    $('details').hidden = true; $('tooltip').hidden = true;
    $('search').value = ''; $('matches').textContent = ''; $('legend').replaceChildren();
    const skipped = data.summary?.skipped_albums ?? 0;
    $('source').textContent = `${name}\n${data.model_id}\n${data.exported_at}\n${data.albums.length} albums · ${skipped} skipped`;
    $('source').style.whiteSpace = 'pre-line';
    $('search').disabled = !data.albums.length;
    $('k').max = Math.max(0, data.albums.length - 1);
    $('k').value = Math.min(8, Number($('k').max));
    $('k-value').value = $('k').value;
    $('empty').hidden = !!data.albums.length;
    if (!data.albums.length) { $('empty').textContent = 'No albums with current embeddings in this export.'; status('Empty export loaded.'); return; }
    const config = { backgroundColor: '#10151c', enableDrag: true, fitViewOnInit: true,
      transitionDuration: 0, rescalePositions: false, linkOpacity: 0.35,
      onMouseMove: (index, position, event) => hover(index, event),
      onPointMouseOver: (index, position, event) => hover(index, event?.sourceEvent ?? event),
      onPointMouseOut: () => hover(undefined), onPointClick: index => showInfo(index),
      onDragStart: () => { dragging = true; coverLoader?.setWanted([]); },
      onDragEnd: () => { dragging = false; scheduleCovers(); if (!paused) graph.start(0.7); },
      onZoomStart: () => { zooming = true; coverLoader?.setWanted([]); },
      onZoomEnd: () => { zooming = false; scheduleCovers(); },
      onSimulationTick: scheduleCovers, onSimulationEnd: scheduleCovers };
    for (const [key, input] of forceInputs) config[key] = key === 'simulationFriction' ? 1 - Number(input.value) : Number(input.value);
    graph = new Graph($('graph'), config);
    const currentGeneration = generation;
    await graph.ready;
    if (generation !== currentGeneration) return;
    const positions = new Float32Array(data.albums.length * 2);
    data.albums.forEach((a, i) => {
      const angle = i * 2.3999632297, radius = 20 * Math.sqrt(i + 1);
      positions[i * 2] = 2048 + Math.cos(angle) * radius;
      positions[i * 2 + 1] = 2048 + Math.sin(angle) * radius;
    });
    graph.setPointPositions(positions);
    graphReady = true;
    coverLoader = new CoverLoader(decodeCover, scheduleAtlas);
    updateCoverSizes(); scheduleCovers();
    graph.render(); if (paused) graph.pause(); else graph.start();
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onerror = event => status(`Graph worker failed: ${event.message}`, true);
    worker.onmessage = ({ data: response }) => {
      if (response.generation !== generation || response.revision !== revision) return;
      if (response.error) { status(response.error, true); return; }
      edges = response.edges; clusters = response.clusters;
      graph.setLinks(Float32Array.from(edges.flatMap(e => [e.source, e.target])));
      graph.setLinkStrength(Float32Array.from(edges, e => e.weight));
      updateGroups(); updateSearch(); reheat();
      status(`${data.albums.length} albums · ${edges.length} links · ${new Set(clusters).size} sound communities`);
    };
    status('Computing similarities…');
    worker.postMessage({ type: 'load', export: data, options: options(), generation, revision });
  } catch (error) {
    status(`Cannot load graph: ${error.message}`, true);
  }
}
$('file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try { await load(JSON.parse(await file.text()), file.name); }
  catch (error) { status(`Cannot read export: ${error.message}`, true); }
});
for (const id of ['use-k', 'k', 'use-threshold', 'threshold']) {
  $(id).addEventListener('input', () => {
    $('k-value').value = $('k').value; $('threshold-value').value = Number($('threshold').value).toFixed(2);
    revision++; clearTimeout(edgeTimer);
    if (!worker) return;
    status('Updating edges…');
    edgeTimer = setTimeout(() => worker.postMessage({ type: 'edges', options: options(), generation, revision }), 100);
  });
}
$('size').addEventListener('change', () => { if (graph) { updateCoverSizes(); graph.render(); } });
$('render-mode').addEventListener('change', refreshCovers);
$('cover-zoom').addEventListener('input', () => {
  $('cover-zoom-value').value = Number($('cover-zoom').value).toFixed(2); refreshCovers();
});
window.addEventListener('resize', scheduleCovers);
$('group').addEventListener('change', () => { if (graph) { updateGroups(); reheat(); } });
$('search').addEventListener('input', updateSearch);
$('fit').addEventListener('click', () => graph?.fitView(250, 0.1, !paused));
$('pause').addEventListener('click', () => {
  paused = !paused; $('pause').textContent = paused ? 'Resume' : 'Pause';
  if (graph) { if (paused) graph.pause(); else graph.start(0.7); }
});
$('clear').addEventListener('click', () => { showInfo(undefined); graph?.setConfigPartial({ outlinedPointIndices: undefined }); graph?.render(); });
const url = new URLSearchParams(location.search).get('data');
if (url) {
  status('Loading export…');
  fetch(url).then(response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); })
    .then(exported => load(exported, url)).catch(error => status(`Cannot fetch export: ${error.message}`, true));
}
