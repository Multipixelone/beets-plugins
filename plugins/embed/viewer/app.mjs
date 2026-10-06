import { Graph, defaultConfigValues } from '@cosmos.gl/graph';
import { validateExport, groups, pointSizes, showCovers, coverCandidates } from './logic.mjs';

import { CoverLoader, decodeCover, coverPolicy, drawnCoverPixels, constrainedCovers } from './covers.mjs';
import { decodeColumn, selectionState, soundSections, groupLabels, placeLabels } from './sound.mjs';

const $ = id => document.getElementById(id);
let graph, worker, data, clusters = [], edges = [], selected, paused = false;
let coverLoader, coverTimer, atlasTimer, visibleCovers = [], atlasEntries = [], coverActive = false;
let dragging = false, zooming = false, graphReady = false;
let coverLimits, coverDpr = 1;
let labelTimer, labelGroups = [], labelDefinitions = [], trackedKey, hovered;
let groupNames = [], groupIds = new Map(), lensOptions = new Map();
let selection = { active: false, states: [], matches: [] }, lensScores, currentLens;
function scheduleLabels() {
  if (!labelTimer) labelTimer = setTimeout(() => { labelTimer = undefined; refreshLabels(); }, 250);
}
function refreshLabels() {
  $('map-labels').replaceChildren();
  if (!graphReady || !$('show-labels').checked || dragging) return;
  const positions = graph.getTrackedPointPositionsMap();
  const candidates = [];
  for (const group of labelGroups) {
    if (selection.active && !group.indices.some(i => selection.states[i]?.match)) continue;
    const points = group.tracked.map(i => positions.get(i)).filter(Boolean);
    if (!points.length) continue;
    const center = points.reduce((sum, point) => [sum[0] + point[0] / points.length, sum[1] + point[1] / points.length], [0, 0]);
    const [x, y] = graph.spaceToScreenPosition(center);
    candidates.push({ ...group, x, y });
  }
  const { width, height } = $('graph').getBoundingClientRect();
  for (const label of placeLabels(candidates, width, height, graph.getZoomLevel())) {
    const element = document.createElement('span'); element.className = 'map-label'; element.textContent = label.text;
    element.style.left = `${label.x}px`; element.style.top = `${label.y}px`; $('map-labels').append(element);
  }
}
function updateColors() {
  if (!graphReady) return;
  graph.setPointColors(Float32Array.from(groupNames.flatMap((name, i) => {
    const rgba = color(groupIds.get(name));
    rgba[3] = selection.states[i]?.match === false ? 1 : selection.states[i]?.opacity ?? 1;
    return rgba;
  })));
}
function updateLabelTracking() {
  if (!graphReady) return;
  labelGroups = labelDefinitions.filter(group => !selection.active || group.indices.some(i => selection.states[i]?.match))
    .slice(0, 96).map(group => ({ ...group,
      tracked: group.indices.filter(i => !selection.active || selection.states[i]?.match).slice(0, 4) }));
  const indices = labelGroups.flatMap(group => group.tracked), key = indices.join(',');
  if (key !== trackedKey) { trackedKey = key; graph.trackPointPositionsByIndices(indices); }
  scheduleLabels();
}
const coverURL = name => new URL(`covers/${name}`, location.href).href;
function albumImageSizes() {
  const sizes = pointSizes(data.albums, $('size').value);
  sizes.forEach((size, i) => { sizes[i] = size * (selection.states[i]?.size ?? 1); });
  return sizes;
}
function configureCovers(candidates) {
  const dpr = window.devicePixelRatio || 1;
  if (coverDpr !== dpr) { coverDpr = dpr; graph.setConfigPartial({ pixelRatio: dpr }); }
  const gl = $('graph').querySelector('canvas').getContext('webgl2');
  const sizes = albumImageSizes();
  const pixels = Math.max(0, ...candidates.map(i => drawnCoverPixels(sizes[i], {
    dpr, zoom: graph.getZoomLevel(), maxPointPixels: gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1],
  })));
  const limits = coverPolicy(pixels, {
    constrained: constrainedCovers({ width: window.innerWidth,
      coarsePointer: window.matchMedia('(pointer: coarse)').matches, deviceMemory: navigator.deviceMemory }),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
  });
  if (!coverLoader || limits.spriteSize !== coverLimits.spriteSize || limits.capacity !== coverLimits.capacity ||
      limits.concurrency !== coverLimits.concurrency) {
    coverLoader?.destroy();
    // Drop both browser and cosmos references to the previous resolution before decoding again.
    atlasEntries = []; graph.setImageData([]);
    coverLimits = limits; coverLoader = new CoverLoader(decodeCover, scheduleAtlas, limits);
  }
}
function scheduleCovers() {
  if (!coverTimer) coverTimer = setTimeout(() => { coverTimer = undefined; refreshCovers(); }, 500);
}
function scheduleAtlas() {
  if (!atlasTimer) atlasTimer = setTimeout(() => { atlasTimer = undefined; updateAtlas(); }, 250);
}
function refreshCovers() {
  if (!graphReady || dragging || zooming) return;
  coverActive = showCovers($('render-mode').value, graph.getZoomLevel(), data.albums.length, Number($('cover-zoom').value));
  if (!coverActive) {
    visibleCovers = []; coverLoader?.setWanted([]); updateCoverSizes(); graph.render();
    $('cover-status').textContent = 'Colored dots'; return;
  }
  // Native viewport query at most twice a second, never on every animation frame.
  const { width, height } = $('graph').getBoundingClientRect();
  const visible = graph.findPointsInRect([[0, 0], [width, height]]);
  const priority = [selected, ...(selection.active ? selection.matches : [])];
  const candidates = coverCandidates(data.albums, visible, priority, 256);
  configureCovers(candidates);
  visibleCovers = candidates.slice(0, coverLoader.capacity);
  coverLoader.setWanted(visibleCovers.map(i => coverURL(data.albums[i].cover)));
  scheduleAtlas();
}
function updateCoverSizes() {
  if (!graphReady) return;
  const sizes = albumImageSizes();
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
  clearCard($('info'));
  if (index === undefined) return;
  const album = data.albums[index];
  appendCover($('info'), album, 160);
  const title = document.createElement('h2'); title.textContent = album.album;
  const info = document.createElement('p'); info.style.whiteSpace = 'pre-line';
  info.textContent = detailText(album).split('\n').slice(1).join('\n');
  $('info').append(title, info);
  appendSounds($('info'), album);
  graph.setConfigPartial({ outlinedPointIndices: [index] }); graph.render();
}
function hover(index, event) {
  $('tooltip').hidden = index === undefined;
  if (index === undefined) { hovered = undefined; clearCard($('tooltip')); return; }
  if (hovered !== index) {
    hovered = index; clearCard($('tooltip'));
    appendCover($('tooltip'), data.albums[index], 80);
    const summary = document.createElement('div'); summary.style.whiteSpace = 'pre-line';
    summary.textContent = detailText(data.albums[index]); $('tooltip').append(summary);
    appendSounds($('tooltip'), data.albums[index]);
  }
  if (event?.clientX !== undefined) {
    $('tooltip').style.left = `${Math.max(8, Math.min(window.innerWidth - 330, event.clientX + 14))}px`;
    $('tooltip').style.top = `${Math.max(8, Math.min(window.innerHeight - $('tooltip').offsetHeight - 8, event.clientY + 14))}px`;
  }
}
function clearCard(container) {
  for (const image of container.querySelectorAll('img')) {
    image.onerror = null; image.removeAttribute('src');
  }
  container.replaceChildren();
}
function appendCover(container, album, size) {
  if (!album.cover) return;
  const image = document.createElement('img');
  image.className = 'card-cover'; image.alt = ''; image.width = image.height = size;
  image.decoding = 'async';
  const name = size > 80 ? album.cover_large ?? album.cover : album.cover;
  image.onerror = () => {
    if (!image.isConnected) return;
    if (name !== album.cover) { image.onerror = () => image.remove(); image.src = coverURL(album.cover); }
    else image.remove();
  };
  image.src = coverURL(name); container.append(image);
}
function appendSounds(container, album) {
  for (const section of soundSections(album)) {
    const title = document.createElement('h3');
    title.textContent = section.title + (section.coverage ? ` · ${section.coverage}` : ''); container.append(title);
    for (const row of section.rows) {
      const element = document.createElement('div'); element.className = 'score-row';
      const label = document.createElement('span'); label.textContent = row.label;
      const score = document.createElement('span'); score.className = 'muted';
      score.textContent = `${typeof row.value === 'number' ? row.value.toFixed(2) : row.value}${row.suffix || ''}${row.coverage ? ` (${row.coverage})` : ''}`;
      element.append(label, score);
      if (row.bar !== null) {
        const bar = document.createElement('progress'); bar.max = 1; bar.value = row.bar; element.append(bar);
      }
      container.append(element);
    }
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
  groupNames = names; groupIds = ids;
  graph.setPointClusters(names.map(name => ids.get(name)));
  updateColors();
  labelDefinitions = groupLabels(data.albums, names);
  // Bounded GPU readback, refreshed by cosmos alongside point rendering.
  updateLabelTracking();
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
  const lens = lensOptions.get($('lens').value);
  if (currentLens !== lens) { currentLens = lens; lensScores = lens ? decodeColumn(lens, data.albums.length) : undefined; }
  selection = selectionState(data.albums, { search, lens, scores: lensScores,
    danceMin: Number($('dance-min').value), danceMax: Number($('dance-max').value),
    vocal: $('vocal').value, includeUnknown: $('include-unknown').checked });
  const matches = selection.matches;
  const set = new Set(matches);
  graph.setConfigPartial({ highlightedPointIndices: selection.active ? matches : undefined,
    highlightedLinkIndices: selection.active ? edges.flatMap((e, i) => set.has(e.source) && set.has(e.target) ? [i] : []) : undefined });
  $('matches').textContent = selection.active ? `${matches.length} matching albums` : '';
  updateColors(); updateCoverSizes(); updateLabelTracking();
  graph.render(); scheduleCovers();
}
async function load(exported, name) {
  try {
    validateExport(exported);
    generation++; revision = 0; clearTimeout(edgeTimer);
    coverLoader?.destroy(); clearTimeout(coverTimer); clearTimeout(atlasTimer);
    coverTimer = atlasTimer = undefined; coverLoader = coverLimits = undefined;
    graphReady = false; dragging = zooming = false;
    clearTimeout(labelTimer); labelTimer = undefined; labelGroups = []; labelDefinitions = []; groupNames = [];
    trackedKey = hovered = undefined;
    $('map-labels').replaceChildren(); selection = { active: false, states: [], matches: [] };
    currentLens = lensScores = undefined; lensOptions = new Map(); $('lens').value = '';
    $('dance-min').value = 0; $('dance-max').value = 1; $('vocal').value = 'any'; $('include-unknown').checked = false;
    $('dance-min-value').value = '0.00'; $('dance-max-value').value = '1.00';
    atlasEntries = []; visibleCovers = [];
    worker?.terminate(); worker = undefined; graph?.destroy(); graph = undefined;
    data = exported;
    $('sound-labels').replaceChildren();
    for (const column of data.labels || []) {
      const name = `${column.label} [${column.source}]`; lensOptions.set(name, column);
      const option = document.createElement('option'); option.value = name; $('sound-labels').append(option);
    }
    $('sound-controls').disabled = data.schema_version < 3;
    for (const option of $('group').options) if (['style', 'mood', 'flavor'].includes(option.value)) option.disabled = data.schema_version < 3;
    if (data.schema_version < 3 && ['style', 'mood', 'flavor'].includes($('group').value)) $('group').value = 'cluster';
    if (data.schema_version === 1) data.albums.forEach(album => { album.cover = null; });
    edges = []; clusters = []; selected = undefined;
    $('details').hidden = true; $('tooltip').hidden = true;
    clearCard($('info')); clearCard($('tooltip'));
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
      pixelRatio: window.devicePixelRatio || 1,
      transitionDuration: 0, rescalePositions: false, linkOpacity: 0.35, pointGreyoutOpacity: 0.12,
      onMouseMove: (index, position, event) => hover(index, event),
      onPointMouseOver: (index, position, event) => hover(index, event?.sourceEvent ?? event),
      onPointMouseOut: () => hover(undefined), onPointClick: index => showInfo(index),
      onDragStart: () => { dragging = true; coverLoader?.setWanted([]); },
      onDragEnd: () => { dragging = false; scheduleCovers(); scheduleLabels(); if (!paused) graph.start(0.7); },
      onZoomStart: () => { zooming = true; coverLoader?.setWanted([]); },
      onZoom: scheduleLabels,
      onZoomEnd: () => { zooming = false; scheduleCovers(); scheduleLabels(); },
      onSimulationTick: () => { scheduleCovers(); scheduleLabels(); },
      onSimulationEnd: () => { scheduleCovers(); scheduleLabels(); } };
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
    coverDpr = window.devicePixelRatio || 1;
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
$('size').addEventListener('change', () => { if (graph) { updateCoverSizes(); graph.render(); scheduleCovers(); } });
$('render-mode').addEventListener('change', refreshCovers);
$('cover-zoom').addEventListener('input', () => {
  $('cover-zoom-value').value = Number($('cover-zoom').value).toFixed(2); refreshCovers();
});
window.addEventListener('resize', () => { scheduleCovers(); scheduleLabels(); });
let dprQuery;
function watchDpr() {
  dprQuery?.removeEventListener('change', watchDpr);
  dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  dprQuery.addEventListener('change', watchDpr);
  scheduleCovers();
}
watchDpr();
$('group').addEventListener('change', () => { if (graph) { updateGroups(); reheat(); } });
$('search').addEventListener('input', updateSearch);
for (const id of ['lens', 'vocal', 'include-unknown']) $(id).addEventListener('input', updateSearch);
for (const id of ['dance-min', 'dance-max']) $(id).addEventListener('input', () => {
  if (Number($('dance-min').value) > Number($('dance-max').value)) $(id === 'dance-min' ? 'dance-max' : 'dance-min').value = $(id).value;
  $('dance-min-value').value = Number($('dance-min').value).toFixed(2);
  $('dance-max-value').value = Number($('dance-max').value).toFixed(2); updateSearch();
});
$('clear-lens').addEventListener('click', () => { $('lens').value = ''; updateSearch(); });
$('show-labels').addEventListener('change', scheduleLabels);
$('controls-toggle').addEventListener('click', () => {
  const open = document.body.classList.toggle('controls-open'); $('controls-toggle').setAttribute('aria-expanded', String(open));
  setTimeout(() => { scheduleCovers(); scheduleLabels(); }, 50);
});
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
