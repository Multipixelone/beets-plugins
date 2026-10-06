import { Graph, defaultConfigValues } from '@cosmos.gl/graph';
import { validateExport, groups, pointSizes, artworkSizes, seedLayout, layoutSpaceSize, layoutParameters, searchMatches, showCovers, coverCandidates } from './logic.mjs';

import { CoverLoader, decodeCover, coverPolicy, drawnCoverPixels, constrainedCovers } from './covers.mjs';
import { decodeColumn, selectionState, soundSections, groupLabels, placeLabels } from './sound.mjs';
import { textVectors, phraseScores, topMatches, PhraseSearch } from './search.mjs';

const $ = id => document.getElementById(id);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let graph, worker, data, clusters = [], edges = [], selected, paused = false;
let coverLoader, coverTimer, atlasTimer, visibleCovers = [], atlasEntries = [], coverActive = false;
let dragging = false, zooming = false, graphReady = false;
let coverLimits, coverDpr = 1;
let labelTimer, labelGroups = [], labelDefinitions = [], trackedKey, hovered;
let groupNames = [], groupIds = new Map(), lensOptions = new Map();
let selection = { active: false, states: [], matches: [] }, lensScores, currentLens;
let queryVectors = [], phraseResult;
const phraseSearch = new PhraseSearch({
  request: async q => {
    let response;
    try {
      response = await fetch('/api/embed-text', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q }), signal: AbortSignal.timeout(125000) });
    } catch (error) {
      throw new Error(error.name === 'TimeoutError' ? 'Text search timed out. Try again.' :
        'Text search endpoint unavailable. Serve this viewer with the updated album graph server.');
    }
    if ([404, 405, 501].includes(response.status)) throw new Error('Text search needs the updated album graph server.');
    let result;
    try { result = await response.json(); } catch { throw new Error('Text search endpoint returned an invalid response.'); }
    if (!response.ok) throw new Error(result.error || `Text search failed (HTTP ${response.status}).`);
    return result;
  },
  change: ({ status: message, result }) => {
    phraseResult = undefined;
    if (result && data) {
      try {
        if (result.model_id !== data.text_model_id) throw new Error('Text model differs from this export. Export again with the current package.');
        phraseResult = phraseScores(queryVectors, result.vector);
        message = 'Ranked by cosine; map emphasis is relative to this library.';
      } catch (error) { message = error.message; }
    }
    $('phrase-status').textContent = message; updateSearch();
  }
});
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
    const rgba = i === selected ? [0.88, 0.94, 1, 1] : color(groupIds.get(name));
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
let initialFitPending = false, strongestEdges = new Set();
let coverGeometry = '', appliedLayout = false;
let layout = { spaceSize: 4096, margin: 409.6, spacing: 112 }, geometryScale = 1;
const coverURL = name => new URL(`covers/${name}`, location.href).href;
function albumImageSizes() {
  const sizes = artworkSizes(data.albums, $('size').value, Number($('art-size').value));
  sizes.forEach((size, i) => { sizes[i] = size * (selection.states[i]?.size ?? 1) * geometryScale; });
  return sizes;
}
function configureCovers(candidates) {
  const dpr = window.devicePixelRatio || 1;
  if (coverDpr !== dpr) { coverDpr = dpr; graph.setConfigPartial({ pixelRatio: dpr }); }
  const gl = $('graph').querySelector('canvas').getContext('webgl2');
  const sizes = albumImageSizes();
  const pixels = Math.max(0, ...candidates.map(i => drawnCoverPixels(sizes[i], {
    dpr, zoom: graph.getZoomLevel(), scaleOnZoom: true, maxPointPixels: gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1],
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
  const geometry = `${coverActive}:${$('size').value}:${$('art-size').value}:${selected}:${geometryScale}`;
  const geometryChanged = geometry !== coverGeometry;
  const sizes = pointSizes(data.albums, $('size').value);
  // Artwork needs a readable baseline independent of the much smaller dot sizes.
  const artworkScale = Number($('art-size').value);
  const imageSizes = artworkSizes(data.albums, $('size').value, artworkScale);
  sizes.forEach((size, i) => { sizes[i] = size * (selection.states[i]?.size ?? 1) * geometryScale; });
  imageSizes.forEach((size, i) => { imageSizes[i] = size * (selection.states[i]?.size ?? 1) * geometryScale; });
  const shapes = new Float32Array(sizes.length);
  const indices = new Float32Array(sizes.length).fill(-1);
  const atlas = new Map(atlasEntries.map(([url], i) => [url, i]));
  if (coverActive) for (let index = 0; index < sizes.length; index++) {
    if (!data.albums[index].cover) continue;
    // Keep loaded artwork resident while panning; unloaded images use the same square footprint.
    indices[index] = atlas.get(coverURL(data.albums[index].cover)) ?? -1;
    shapes[index] = 1;
    // Cosmos draws squares at 80% of their point size. Selection stays rectangular.
    sizes[index] = (imageSizes[index] + (index === selected ? 8 : 6) * geometryScale) / 0.8;
  }
  graph.setPointImageIndices(indices);
  if (geometryChanged) {
    graph.setPointImageSizes(imageSizes); graph.setPointShapes(shapes); graph.setPointSizes(sizes);
    coverGeometry = geometry;
  }
}
function resizeArtwork() {
  if (!graphReady) return;
  configureLayout();
  updateCoverSizes(); reheat(); scheduleCovers();
}
function updateAtlas() {
  if (!graphReady || !coverLoader) return;
  if (dragging || zooming) { scheduleAtlas(); return; }
  const entries = [...coverLoader.images.entries()].sort(([a], [b]) => a.localeCompare(b));
  // setImageData repacks the whole texture. Never upload an unchanged atlas.
  const atlasChanged = entries.length !== atlasEntries.length || entries.some(([url, image], i) =>
    url !== atlasEntries[i]?.[0] || image !== atlasEntries[i]?.[1]);
  if (atlasChanged) {
    graph.setImageData(entries.map(([, image]) => image)); atlasEntries = entries;
  }
  const geometry = `${coverActive}:${$('size').value}:${$('art-size').value}:${selected}:${geometryScale}`;
  if (atlasChanged || geometry !== coverGeometry) {
    updateCoverSizes(); graph.render();
  }
  if (coverActive) $('cover-status').textContent = `${visibleCovers.filter(i => coverLoader.images.has(coverURL(data.albums[i].cover))).length} covers in view · ${coverLoader.failed.size} unavailable`;
}
let generation = 0, revision = 0, edgeTimer;
const forceSpecs = [
  ['Repulsion', 'simulationRepulsion', 0, 100, 1],
  ['Link strength', 'simulationLinkSpring', 0, 0.1, 0.001],
  ['Link distance', 'simulationLinkDistance', 40, 300, 5],
  ['Cover spacing', 'simulationCollisionPadding', 0, 50, 1],
  ['Gravity', 'simulationGravity', 0, 0.1, 0.001],
  ['Cluster force', 'simulationCluster', 0, 0.01, 0.0001],
  ['Friction (damping)', 'simulationFriction', 0, 1, 0.01],
];
const forceInputs = new Map();
const forceOutputs = new Map(), forceOverrides = new Map();
let forceScales = {};
const discoveryForces = layoutParameters([]).forces;
for (const [name, key, min, max, step] of forceSpecs) {
  const label = document.createElement('label');
  label.append(name);
  const output = document.createElement('output');
  const input = document.createElement('input');
  Object.assign(input, { type: 'range', min, max, step, id: key });
  const initial = discoveryForces[key] ?? defaultConfigValues[key];
  input.value = key === 'simulationFriction' ? 1 - initial : initial;
  const precision = step < 0.001 ? 4 : step < 0.01 ? 3 : step < 1 ? 2 : 0;
  output.value = Number(input.value).toFixed(precision);
  label.append(output, input); $('forces').append(label); forceInputs.set(key, input);
  forceOutputs.set(key, output);
  input.addEventListener('input', () => {
    output.value = Number(input.value).toFixed(forcePrecision(step * (forceScales[key] ?? 1)));
    // Preserve the user's choice relative to the library's distance/count scale.
    forceOverrides.set(key, Number(input.value) / (forceScales[key] ?? 1));
    if (!graph) return;
    graph.setConfigPartial({ [key]: key === 'simulationFriction' ? 1 - Number(input.value) : Number(input.value) });
    reheat();
  });
}
function forcePrecision(step) {
  return Math.max(0, Math.min(6, Math.ceil(-Math.log10(step)) + (step < 1 ? 1 : 0)));
}
function configureLayout() {
  const parameters = layoutParameters(data.albums, { ...layout,
    metric: $('size').value, artworkScale: Number($('art-size').value),
    emphasis: selection.states.map(state => state.size) });
  geometryScale = parameters.geometryScale;
  forceScales = { simulationRepulsion: parameters.repulsionScale,
    simulationLinkDistance: parameters.distanceScale, simulationCollisionPadding: parameters.distanceScale };
  const forces = {};
  for (const [, key, min, max, step] of forceSpecs) {
    const input = forceInputs.get(key), scale = forceScales[key] ?? 1;
    const initial = forceOverrides.has(key) ? forceOverrides.get(key) * scale :
      key === 'simulationFriction' ? 1 - parameters.forces[key] : parameters.forces[key];
    Object.assign(input, { min: min * scale, max: max * scale, step: step * scale });
    // Round padding down so slider quantization never exceeds the default budget.
    input.value = key === 'simulationCollisionPadding' && !forceOverrides.has(key) ?
      Math.floor(initial / (step * scale)) * step * scale : initial;
    forceOutputs.get(key).value = Number(input.value).toFixed(forcePrecision(step * scale));
    forces[key] = key === 'simulationFriction' ? 1 - Number(input.value) : Number(input.value);
  }
  graph.setConfigPartial(forces);
}
function status(message, error = false) {
  $('status').textContent = message; $('status').classList.toggle('error', error);
}
function options() {
  return { useK: $('use-k').checked, k: Number($('k').value),
    useThreshold: $('use-threshold').checked, threshold: Number($('threshold').value) };
}
function reheat() { graph.render(); if (!paused) graph.start(0.3); }
function fitInitialView(settled = false) {
  if (!initialFitPending || !graphReady) return;
  const duration = reducedMotion ? 0 : 450;
  // Scale artwork with the camera so zooming out never piles fixed-size covers together.
  const scale = window.matchMedia('(max-width: 760px)').matches ? 1.15 : 1;
  const counts = new Map();
  for (const cluster of clusters) counts.set(cluster, (counts.get(cluster) || 0) + 1);
  const largest = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  const positions = graph.getPointPositions();
  // Open on a populated community; Fit view remains the whole-library overview.
  const initial = positions.filter((coordinate, i) => clusters[Math.floor(i / 2)] === largest);
  graph.setZoomTransformByPointPositions(Float32Array.from(initial), duration, scale, 0.08, false);
  if (settled || paused) initialFitPending = false;
  scheduleCovers();
}
function coverElement(album, className) {
  const fallback = () => {
    const element = document.createElement('span');
    element.className = `${className} cover-fallback`; element.textContent = '◎';
    element.setAttribute('aria-hidden', 'true'); return element;
  };
  if (!album.cover) return fallback();
  const image = document.createElement('img');
  const name = className === 'detail-cover' ? album.cover_large ?? album.cover : album.cover;
  image.className = className; image.src = coverURL(name); image.alt = ''; image.decoding = 'async';
  image.onerror = () => {
    if (!image.isConnected) return;
    if (name !== album.cover) {
      image.onerror = () => image.replaceWith(fallback()); image.src = coverURL(album.cover);
    } else image.replaceWith(fallback());
  };
  return image;
}
function albumButton(index) {
  const album = data.albums[index];
  const button = document.createElement('button'); button.className = 'album-result';
  const text = document.createElement('span');
  const title = document.createElement('strong'); title.textContent = album.album;
  const artist = document.createElement('small'); artist.textContent = album.albumartist;
  const arrow = document.createElement('span'); arrow.className = 'result-arrow'; arrow.textContent = '↗'; arrow.setAttribute('aria-hidden', 'true');
  text.append(title, artist); button.append(coverElement(album, 'result-cover'), text, arrow);
  button.addEventListener('click', () => focusAlbum(index));
  return button;
}
function focusAlbum(index) {
  if (!graphReady) return;
  initialFitPending = false;
  $('search').value = ''; updateSearch(); setSettingsOpen(false);
  showInfo(index);
  $('clear').focus({ preventScroll: true });
}
function updateHighlights() {
  if (!graphReady) return;
  const query = selection.active;
  const matching = new Set(query ? selection.matches : selected === undefined ? [] : [selected]);
  const links = edges.flatMap((edge, i) => matching.has(edge.source) || matching.has(edge.target) ? [i] : []);
  const points = new Set(matching);
  if (!query) for (const i of links) { points.add(edges[i].source); points.add(edges[i].target); }
  const focus = query || selected !== undefined;
  const emphasized = new Set(links);
  const mode = $('edge-view').value;
  graph.setLinkColors(Float32Array.from(edges.flatMap((edge, i) => {
    if (focus) return emphasized.has(i) ? [0.64, 0.79, 0.94, 1] : [0, 0, 0, 0];
    return mode === 'all' || (mode === 'strongest' && strongestEdges.has(i)) ? [0.39, 0.48, 0.60, 0.4] : [0, 0, 0, 0];
  })));
  graph.setConfigPartial({ highlightedPointIndices: focus ? [...points] : undefined,
    highlightedLinkIndices: query || selected !== undefined ? links : undefined,
    linkOpacity: 1, linkDefaultWidth: focus ? 1.65 : 1.1,
    outlinedPointIndices: undefined, focusedPointIndex: undefined });
  updateColors(); updateCoverSizes();
  graph.render();
}
function detailText(album) {
  return `${album.album}\n${album.albumartist}\n${album.genre || 'Unknown genre'} · ${album.year || 'Unknown year'}\n` +
    `${album.embedded_tracks}/${album.track_count} tracks embedded\n` +
    `${album.summed_plays.toLocaleString()} plays · ${album.mean_plays.toLocaleString(undefined, { maximumFractionDigits: 1 })} mean plays`;
}
function showInfo(index) {
  selected = index; scheduleCovers();
  $('details').hidden = index === undefined;
  document.querySelector('main').classList.toggle('has-selection', index !== undefined);
  clearCard($('info'));
  updateHighlights();
  if (index === undefined) return;
  const album = data.albums[index];
  const eyebrow = document.createElement('p'); eyebrow.className = 'detail-eyebrow'; eyebrow.textContent = 'SELECTED ALBUM';
  const title = document.createElement('h2'); title.textContent = album.album;
  const artist = document.createElement('p'); artist.className = 'album-artist'; artist.textContent = album.albumartist;
  const info = document.createElement('p'); info.className = 'album-meta';
  info.textContent = [album.year || null, album.genre || null].filter(Boolean).join(' · ');
  const plays = document.createElement('p'); plays.className = 'album-meta';
  plays.textContent = `${album.track_count} tracks · ${album.summed_plays.toLocaleString()} plays`;
  const related = edges.filter(edge => edge.source === index || edge.target === index)
    .sort((a, b) => b.similarity - a.similarity);
  const heading = document.createElement('p'); heading.className = 'related-heading';
  heading.textContent = related.length ? `CONNECTED ALBUMS · ${related.length}` : 'NO CONNECTIONS IN THIS VIEW';
  $('info').append(coverElement(album, 'detail-cover'), eyebrow, title, artist, info, plays, heading);
  appendSounds($('info'), album);
  for (const edge of related.slice(0, 4)) $('info').append(albumButton(edge.source === index ? edge.target : edge.source));
  if (!related.length) {
    const hint = document.createElement('p'); hint.className = 'muted'; hint.textContent = 'Try a lower similarity threshold in Connections.'; $('info').append(hint);
  }
  $('details').scrollTop = 0;
  requestAnimationFrame(() => {
    // Let the graph resize beside (or above) the details before centering the album.
    if (selected === index && graphReady) {
      const position = Float32Array.from(graph.getPointPositions().slice(index * 2, index * 2 + 2));
      graph.setZoomTransformByPointPositions(position, reducedMotion ? 0 : 350, Math.max(graph.getZoomLevel(), 1.25), 0.1, false);
    }
  });
}
function hover(index, event) {
  if (zooming || dragging) index = undefined;
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
    return 0.62 - 0.22 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  });
  return [...rgb, 1];
}
function updateGroups() {
  if (!graph || !data) return;
  const names = groups(data.albums, $('group').value, clusters);
  const unique = [...new Set(names)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const ids = new Map(unique.map((name, i) => [name, i]));
  groupNames = names; groupIds = ids;
  updateColors();
  labelDefinitions = groupLabels(data.albums, names);
  // Bounded GPU readback, refreshed by cosmos alongside point rendering.
  updateLabelTracking();
  $('legend').replaceChildren();
  const counts = new Map();
  for (const name of names) counts.set(name, (counts.get(name) || 0) + 1);
  $('group-count').textContent = unique.length;
  for (const name of unique) {
    const row = document.createElement('div'); row.className = 'legend-row';
    const swatch = document.createElement('span'); swatch.className = 'swatch';
    swatch.style.backgroundColor = `rgb(${color(ids.get(name)).slice(0, 3).map(x => Math.round(x * 255)).join(' ')})`;
    const text = document.createElement('span'); text.textContent = name.replace(/^Cluster /, 'Community ');
    const count = document.createElement('span'); count.className = 'legend-count'; count.textContent = counts.get(name);
    row.append(swatch, text, count); $('legend').append(row);
  }
}
function updateSearch() {
  if (!graph || !data) return;
  const search = $('search').value.trim();
  const lens = lensOptions.get($('lens').value);
  if (currentLens !== lens) { currentLens = lens; lensScores = lens ? decodeColumn(lens, data.albums.length) : undefined; }
  selection = selectionState(data.albums, { search, lens, scores: lensScores,
    phraseScores: phraseResult?.salience,
    danceMin: Number($('dance-min').value), danceMax: Number($('dance-max').value),
    vocal: $('vocal').value, includeUnknown: $('include-unknown').checked });
  if (graphReady) configureLayout();
  const matches = selection.matches;
  $('matches').textContent = matches.length ? `${matches.length} matching albums${matches.length > 30 ? ' · showing the first 30' : ''}` : 'No albums found. Try another album or artist.';
  $('search-results').hidden = !search;
  $('search-list').replaceChildren(...(search ? matches.slice(0, 30).map(albumButton) : []));
  $('phrase-results').replaceChildren();
  if (phraseResult) {
    $('phrase-status').textContent = 'Ranked by cosine; map emphasis is relative to this library.';
    for (const index of topMatches(data.albums, phraseResult.cosines, matches)) {
      const album = data.albums[index], row = document.createElement('li'), button = document.createElement('button');
      button.textContent = `${album.albumartist} — ${album.album} (${phraseResult.cosines[index].toFixed(3)})`;
      button.addEventListener('click', () => focusAlbum(index));
      row.append(button); $('phrase-results').append(row);
    }
    if (!$('phrase-results').children.length) $('phrase-status').textContent = 'No salient matches under the current filters.';
  }
  coverGeometry = '';
  updateHighlights(); updateLabelTracking(); scheduleCovers();
}
async function load(exported, name) {
  try {
    validateExport(exported);
    phraseSearch.set(''); $('phrase').value = ''; $('phrase-results').replaceChildren();
    generation++; revision = 0; clearTimeout(edgeTimer);
    initialFitPending = true;
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
    coverGeometry = ''; appliedLayout = false;
    geometryScale = 1;
    worker?.terminate(); worker = undefined; graph?.destroy(); graph = undefined;
    data = exported;
    queryVectors = textVectors(data.albums);
    $('phrase').disabled = !queryVectors.some(vector => vector !== null);
    $('phrase-status').textContent = $('phrase').disabled ? 'This export has no CLAP audio vectors. Export again after embedding albums.' : '';
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
    document.querySelector('main').classList.remove('has-selection');
    clearCard($('info')); clearCard($('tooltip'));
    $('search').value = ''; $('matches').textContent = ''; $('legend').replaceChildren();
    $('search-results').hidden = true; $('search-list').replaceChildren();
    const skipped = data.summary?.skipped_albums ?? 0;
    $('source').textContent = `${name}\n${data.albums.length} albums · ${skipped.toLocaleString()} skipped\nExported ${new Date(data.exported_at).toLocaleDateString()}`;
    $('source').title = `Embedding model: ${data.model_id}`;
    $('source').style.whiteSpace = 'pre-line';
    $('search').disabled = true;
    $('surprise').disabled = true;
    $('library-count').textContent = `${data.albums.length.toLocaleString()} albums in your collection`;
    $('k').max = Math.max(0, data.albums.length - 1);
    $('k').value = Math.min(8, Number($('k').max));
    $('k-value').value = $('k').value;
    $('empty').hidden = !!data.albums.length;
    if (!data.albums.length) { $('empty').textContent = 'No albums with current embeddings in this export.'; status('Empty export loaded.'); return; }
    const config = { backgroundColor: '#0d1117', spaceSize: 4096, enableDrag: true, fitViewOnInit: false,
      pixelRatio: window.devicePixelRatio || 1,
      enableSimulation: !paused, enableSimulationDuringZoom: false,
      transitionDuration: 0, rescalePositions: false, scalePointsOnZoom: true,
      pointGreyoutOpacity: 0.2, linkOpacity: 1, linkDefaultColor: '#637b99',
      linkDefaultWidth: 1.1, scaleLinksOnZoom: false, linkGreyoutOpacity: 0,
      linkVisibilityDistanceRange: [0, 1], linkVisibilityMinTransparency: 1,
      hoveredLinkColor: '#c3dbf2', renderHoveredPointRing: false,
      simulationCollision: 2, simulationLinkDistRandomVariationRange: [1, 1.12],
      // Derive collision bounds from each album's size, including unloaded covers.
      simulationCollisionRadius: undefined,
      // Decay is measured in simulation ticks, not milliseconds.
      simulationDecay: 1800,
      onMouseMove: (index, position, event) => hover(index, event),
      onPointMouseOver: (index, position, event) => hover(index, event?.sourceEvent ?? event),
      onPointMouseOut: () => hover(undefined), onPointClick: index => {
        initialFitPending = false; showInfo(index); $('search-results').hidden = true;
      },
      onDragStart: () => { initialFitPending = false; dragging = true; hover(undefined); if (!paused) graph.start(0.25); },
      onDragEnd: () => { dragging = false; scheduleCovers(); scheduleLabels(); if (!paused) graph.start(0.2); },
      onZoomStart: event => { if (event?.sourceEvent) initialFitPending = false; zooming = true; hover(undefined); },
      onZoom: scheduleLabels,
      onZoomEnd: () => { zooming = false; scheduleCovers(); scheduleLabels(); },
      onSimulationTick: () => { scheduleCovers(); scheduleLabels(); },
      onSimulationEnd: () => { fitInitialView(true); scheduleCovers(); scheduleLabels(); } };
    for (const [key, input] of forceInputs) config[key] = key === 'simulationFriction' ? 1 - Number(input.value) : Number(input.value);
    graph = new Graph($('graph'), config);
    const currentGeneration = generation;
    await graph.ready;
    if (generation !== currentGeneration) return;
    const gl = $('graph').querySelector('canvas').getContext('webgl2');
    const constrained = constrainedCovers({ width: window.innerWidth,
      coarsePointer: window.matchMedia('(pointer: coarse)').matches, deviceMemory: navigator.deviceMemory }) ||
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const spaceSize = layoutSpaceSize(data.albums.length, {
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE), constrained });
    layout = { spaceSize, margin: spaceSize * 0.1, spacing: 112 };
    graph.setConfigPartial({ spaceSize });
    coverDpr = window.devicePixelRatio || 1;
    $('graph').style.visibility = 'hidden';
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onerror = event => status(`Graph worker failed: ${event.message}`, true);
    worker.onmessage = ({ data: response }) => {
      if (response.generation !== generation || response.revision !== revision) return;
      if (response.error) { status(response.error, true); return; }
      edges = response.edges; clusters = response.clusters;
      strongestEdges = new Set();
      const strongest = new Map();
      edges.forEach((edge, index) => {
        for (const endpoint of [edge.source, edge.target]) {
          const previous = strongest.get(endpoint);
          if (previous === undefined || edge.similarity > edges[previous].similarity) strongest.set(endpoint, index);
        }
      });
      for (const index of strongest.values()) strongestEdges.add(index);
      if (!appliedLayout) {
        // Start close neighbors together; Cosmos freely moves every album from here.
        const seeded = seedLayout(data.albums, edges, clusters, 112, layout);
        layout = { spaceSize: seeded.spaceSize, margin: seeded.margin, spacing: seeded.spacing };
        graph.setPointPositions(seeded.positions);
      }
      graphReady = true;
      coverActive = showCovers($('render-mode').value, graph.getZoomLevel(), data.albums.length, Number($('cover-zoom').value));
      graph.setLinks(Float32Array.from(edges.flatMap(e => [e.source, e.target])));
      // Sound similarity determines layout even when covers use metadata colors.
      graph.setPointClusters(clusters);
      const degrees = new Uint32Array(data.albums.length);
      for (const edge of edges) { degrees[edge.source]++; degrees[edge.target]++; }
      // Explicit strengths replace Cosmos's degree normalization; preserve it so
      // hubs do not accumulate hundreds of full-strength attraction forces.
      graph.setLinkStrength(Float32Array.from(edges, edge => edge.weight / Math.max(1, Math.min(degrees[edge.source], degrees[edge.target]))));
      updateGroups(); updateSearch(); updateCoverSizes(); graph.render();
      if (paused) graph.pause(); else graph.start(appliedLayout ? 0.3 : 1);
      $('graph').style.visibility = '';
      $('search').disabled = false; $('surprise').disabled = false;
      if (!appliedLayout) { fitInitialView(); appliedLayout = true; }
      scheduleCovers();
      if (selected !== undefined) showInfo(selected);
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
$('size').addEventListener('change', resizeArtwork);
$('art-size').addEventListener('input', () => {
  $('art-size-value').value = `${Math.round(Number($('art-size').value) * 100)}%`;
  resizeArtwork();
});
$('render-mode').addEventListener('change', () => { refreshCovers(); if (graphReady) reheat(); });
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
$('group').addEventListener('change', () => { if (graphReady) { updateGroups(); updateHighlights(); } });
$('edge-view').addEventListener('change', updateHighlights);
$('search').addEventListener('input', updateSearch);
$('phrase').addEventListener('input', () => phraseSearch.set($('phrase').value));
$('clear-phrase').addEventListener('click', () => { $('phrase').value = ''; phraseSearch.set(''); });
for (const id of ['lens', 'vocal', 'include-unknown']) $(id).addEventListener('input', updateSearch);
for (const id of ['dance-min', 'dance-max']) $(id).addEventListener('input', () => {
  if (Number($('dance-min').value) > Number($('dance-max').value)) $(id === 'dance-min' ? 'dance-max' : 'dance-min').value = $(id).value;
  $('dance-min-value').value = Number($('dance-min').value).toFixed(2);
  $('dance-max-value').value = Number($('dance-max').value).toFixed(2); updateSearch();
});
$('clear-lens').addEventListener('click', () => { $('lens').value = ''; updateSearch(); });
$('show-labels').addEventListener('change', scheduleLabels);
$('fit').addEventListener('click', () => { initialFitPending = false; graph?.fitView(reducedMotion ? 0 : 350, 0.08, false); });
for (const [id, multiplier] of [['zoom-in', 1.4], ['zoom-out', 1 / 1.4]]) $(id).addEventListener('click', () => {
  initialFitPending = false;
  if (graphReady) graph.setZoomLevel(graph.getZoomLevel() * multiplier, reducedMotion ? 0 : 250, false);
});
function updatePauseButton() {
  $('pause').textContent = paused ? 'Resume physics' : 'Pause physics';
  $('pause').setAttribute('aria-pressed', String(paused));
}
updatePauseButton();
$('pause').addEventListener('click', () => {
  paused = !paused; initialFitPending = false; updatePauseButton();
  if (graphReady) {
    graph.setConfigPartial({ enableSimulation: !paused });
    if (paused) graph.pause(); else graph.start(0.2);
  }
});
$('clear').addEventListener('click', () => { showInfo(undefined); $('search').focus({ preventScroll: true }); });
$('surprise').addEventListener('click', () => {
  if (data?.albums.length) focusAlbum(Math.floor(Math.random() * data.albums.length));
});
function setSettingsOpen(open) {
  document.body.classList.toggle('settings-open', open);
  $('settings-toggle').setAttribute('aria-expanded', String(open));
  $('settings-backdrop').hidden = !open;
  $('settings-toggle').lastChild.textContent = open ? 'Close settings' : 'Map settings';
  document.querySelector('main').inert = open;
}
$('settings-toggle').addEventListener('click', () => setSettingsOpen($('settings-backdrop').hidden));
$('settings-backdrop').addEventListener('click', () => setSettingsOpen(false));
$('empty-load').addEventListener('click', () => $('file').click());
$('search').addEventListener('focus', () => { if ($('search').value.trim()) $('search-results').hidden = false; });
$('search').addEventListener('keydown', event => {
  if (event.key === 'ArrowDown') { $('search-list').querySelector('button')?.focus(); event.preventDefault(); }
  if (event.key === 'Enter' && data) {
    const [match] = searchMatches(data.albums, $('search').value);
    if ($('search').value.trim() && match !== undefined) focusAlbum(match);
  }
});
document.addEventListener('pointerdown', event => {
  if (!event.target.closest('.search-wrap')) $('search-results').hidden = true;
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (document.body.classList.contains('settings-open')) { setSettingsOpen(false); $('settings-toggle').focus(); }
    else if (!$('search-results').hidden) { $('search').focus(); $('search-results').hidden = true; }
    else if (selected !== undefined) { showInfo(undefined); $('search').focus({ preventScroll: true }); }
  }
});
for (const event of ['pointerdown', 'wheel', 'touchstart']) $('graph').addEventListener(event, () => { initialFitPending = false; }, { passive: true });
window.matchMedia('(min-width: 761px)').addEventListener('change', event => { if (event.matches) setSettingsOpen(false); });
const url = new URLSearchParams(location.search).get('data');
if (url) {
  status('Loading export…');
  fetch(url).then(response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); })
    .then(exported => load(exported, url)).catch(error => status(`Cannot fetch export: ${error.message}`, true));
}
