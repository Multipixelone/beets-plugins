// Pure sound/lens/filter/label logic. Byte zero means missing, never score zero.
import { vibeAppearance } from './vibe.mjs';
export function expandSounds(data) {
  if (data.sound_encoding === undefined) return;
  if (data.sound_encoding !== 'catalog-pairs-v1' || !Array.isArray(data.essentia_fields) ||
      data.essentia_fields.length > 64 || data.essentia_fields.some(key => typeof key !== 'string')) {
    throw new Error('Invalid sound encoding.');
  }
  for (const album of data.albums) {
    if (Array.isArray(album.essentia)) {
      if (album.essentia.length !== data.essentia_fields.length) throw new Error('Invalid Essentia fields.');
      album.essentia = Object.fromEntries(data.essentia_fields.map((key, i) => {
        const row = album.essentia[i];
        if (row !== null && (!Array.isArray(row) || row.length < 2 || row.length > 3 ||
            !Number.isInteger(row[1]) || row[1] < 0 || row[1] > album.track_count ||
            (row[0] !== null && typeof row[0] !== 'string' && !Number.isFinite(row[0])) ||
            (row.length === 3 && !Number.isFinite(row[2])))) throw new Error('Invalid Essentia value.');
        return [key, { value: row?.[0] ?? null, count: row?.[1] ?? 0, support: row?.[2] ?? null, total: album.track_count }];
      }));
    }
    for (const group of Object.values(album.sound || {})) {
      if (!Array.isArray(group.labels)) throw new Error('Invalid sound labels.');
      group.total = album.track_count;
      group.labels = group.labels.map(label => {
        if (!Array.isArray(label)) return label; // Already decoded before crossing the worker boundary.
        const column = data.labels[label[0]];
        if (label.length !== 2 || !Number.isInteger(label[0]) || !column || !Number.isFinite(label[1])) {
          throw new Error('Invalid sound label reference.');
        }
        return { id: column.id, label: column.label, score: label[1], axis: column.axis };
      });
    }
  }
}
export function decodeColumn(column, count) {
  const binary = atob(column.scores);
  if (binary.length !== count || !Number.isFinite(column.min) || !Number.isFinite(column.max) || column.max <= column.min) {
    throw new Error('Invalid sound score column.');
  }
  return Array.from(binary, byte => byte.charCodeAt(0) === 0 ? null :
    column.min + (byte.charCodeAt(0) - 1) * (column.max - column.min) / 254);
}
export function shortLabel(label) {
  return label.includes('---') ? label.split('---').slice(1).join(' / ') : label.replaceAll('_', ' ');
}
export function soundGroup(album, mode) {
  const source = { style: 'style', mood: 'mood', flavor: 'flavor' }[mode];
  if (!source) return undefined;
  const label = album.sound?.[source]?.labels?.[0]?.label || 'Unknown';
  // Discogs reuses some style names in different families; keep groups distinct.
  return mode === 'style' && label.includes('---') ? `${shortLabel(label)} (${label.split('---')[0]})` : shortLabel(label);
}
export function selectionState(albums, { search = '', lens, scores, danceMin = 0, danceMax = 1,
                                       vocal = 'any', includeUnknown = false, phraseScores } = {}) {
  const needle = search.trim().toLocaleLowerCase();
  const filterActive = !!needle || !!lens || danceMin > 0 || danceMax < 1 || vocal !== 'any';
  const vibeActive = !!phraseScores, active = filterActive || vibeActive;
  const states = albums.map((album, index) => {
    let match = `${album.album}\n${album.albumartist}`.toLocaleLowerCase().includes(needle);
    let strength = 1;
    if (lens) {
      const score = scores?.[index];
      const relative = lens.kind === 'relative' || lens.kind === 'zscore';
      const floor = relative ? 0.5 : lens.source === 'essentia' && lens.kind !== 'category' ? 0.5 : 0.05;
      match &&= score != null && score >= floor;
      strength = score == null ? 0 : Math.max(0, Math.min(1, relative ? (score - 0.5) / 3.5 : score));
    }
    if (danceMin > 0 || danceMax < 1) {
      const value = album.essentia?.danceable?.value;
      match &&= value == null ? includeUnknown : value >= danceMin && value <= danceMax;
    }
    if (vocal !== 'any') {
      const value = album.essentia?.voice_instrumental?.value;
      match &&= value == null ? includeUnknown : value === vocal;
    }
    const visible = match, baseSize = match && lens ? 1 + 0.75 * strength : 1;
    const appearance = vibeActive ? vibeAppearance(phraseScores[index]) : null;
    return { visible, match: visible && (!vibeActive || appearance.match), strength: visible ? strength : 0,
      opacity: !visible ? 0 : vibeActive ? appearance.opacity : !filterActive ? 1 : 0.65 + 0.35 * strength,
      size: baseSize * (appearance?.size ?? 1), baseSize, brightness: visible ? appearance?.brightness ?? 1 : 1 };
  });
  return { active, filterActive, vibeActive, states,
    visibleIndices: states.flatMap((state, i) => state.visible ? [i] : []),
    matches: states.flatMap((state, i) => state.match ? [i] : []) };
}
export function soundSections(album) {
  const sections = [];
  for (const [key, title] of [['style', 'Style'], ['mood', 'Mood'], ['instruments', 'Instruments'],
                            ['flavor', 'Sounds like'], ['approachability', 'Approachability'], ['engagement', 'Engagement']]) {
    const group = album.sound?.[key];
    if (!group?.labels?.length) continue;
    sections.push({ title, coverage: `${group.count}/${group.total} tracks`, rows: group.labels.map(label => ({
      label: shortLabel(label.label), value: label.score,
      bar: Math.max(0, Math.min(1, key === 'flavor' ? label.score / 4 : label.score)),
      suffix: key === 'flavor' ? ' z' : '' })) });
  }
  const essentia = Object.entries(album.essentia || {}).filter(([, field]) => field.value != null).map(([key, field]) => ({
    label: shortLabel(key), value: field.value, coverage: `${field.count}/${field.total}`,
    bar: typeof field.value === 'number' && key !== 'danceability' ? Math.max(0, Math.min(1, field.value)) : null,
  }));
  if (essentia.length) sections.push({ title: 'Essentia', rows: essentia });
  return sections;
}
// Favor connected community cores over bridge albums. IDs break ties so an
// export's album order cannot move the label to a different part of a group.
export function representativeLabelAnchors(albums, indices, edges = [], limit = 4) {
  const members = new Set(indices), internal = new Map(), total = new Map();
  for (const { source, target, weight = 1 } of edges) {
    if (!Number.isFinite(weight) || weight <= 0) continue;
    for (const [index, other] of [[source, target], [target, source]]) {
      if (!members.has(index)) continue;
      total.set(index, (total.get(index) || 0) + weight);
      if (members.has(other)) internal.set(index, (internal.get(index) || 0) + weight);
    }
  }
  const score = index => (internal.get(index) || 0) ** 2 / (total.get(index) || 1);
  const key = index => `${albums[index]?.albumartist || ''}\n${albums[index]?.album || ''}`;
  return [...indices].sort((a, b) => score(b) - score(a) ||
    (internal.get(b) || 0) - (internal.get(a) || 0) ||
    (albums[a]?.id ?? Infinity) - (albums[b]?.id ?? Infinity) || key(a).localeCompare(key(b)))
    .slice(0, Math.max(0, limit));
}

const labelKey = text => shortLabel(text).normalize('NFKC').toLocaleLowerCase()
  .replace(/[_\s-]+/g, ' ').trim();
export function groupLabels(albums, names, visible = () => true, { edges = [], anchorCount = 4 } = {}) {
  const members = new Map();
  names.forEach((name, index) => {
    if (!visible(index)) return;
    if (!members.has(name)) members.set(name, []); members.get(name).push(index);
  });
  return [...members].map(([name, indices]) => {
    const scores = new Map(), flavor = new Map();
    for (const i of indices) {
      const album = albums[i];
      const main = album.sound?.style?.labels?.length ? album.sound.style :
        album.sound?.mood?.labels?.length ? album.sound.mood : album.sound?.instruments;
      for (const label of main?.labels || []) scores.set(label.label, (scores.get(label.label) || 0) + label.score);
      for (const label of album.sound?.flavor?.labels || []) flavor.set(label.label, (flavor.get(label.label) || 0) + label.score);
    }
    const ranked = map => [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const main = ranked(scores)[0]?.[0];
    const text = main ? shortLabel(main) : name, seen = new Set([labelKey(text)]), words = [];
    for (const [word, score] of ranked(flavor)) {
      const key = labelKey(word);
      if (score / indices.length < 0.25 || seen.has(key)) continue;
      seen.add(key); words.push(shortLabel(word));
      if (words.length === 2) break;
    }
    const representatives = representativeLabelAnchors(albums, indices, edges,
      Math.max(anchorCount, Math.ceil(indices.length * .6)));
    return { name, indices, text, description: [text, ...words].join(' · '),
      tracked: representatives.slice(0, anchorCount), representatives };
  }).sort((a, b) => b.indices.length - a.indices.length || a.name.localeCompare(b.name));
}

function intersects(a, b, gap) {
  return !(a.right + gap <= b.left || a.left >= b.right + gap ||
    a.bottom + gap <= b.top || a.top >= b.bottom + gap);
}
function obstacleGrid(obstacles, width, height, gap) {
  const cell = 64, columns = Math.max(1, Math.ceil(width / cell)), rows = Math.max(1, Math.ceil(height / cell)), bins = new Map();
  const visit = (rect, padding, callback) => {
    const left = Math.max(0, Math.floor((rect.left - padding) / cell)), right = Math.min(columns - 1, Math.floor((rect.right + padding) / cell));
    const top = Math.max(0, Math.floor((rect.top - padding) / cell)), bottom = Math.min(rows - 1, Math.floor((rect.bottom + padding) / cell));
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) if (callback(y * columns + x)) return true;
    return false;
  };
  for (const obstacle of obstacles) visit(obstacle, gap, key => {
    if (!bins.has(key)) bins.set(key, []); bins.get(key).push(obstacle); return false;
  });
  return {
    blocked: rect => visit(rect, 0, key => bins.get(key)?.some(obstacle => intersects(rect, obstacle, gap))),
    nearby: rect => {
      const found = new Set();
      visit(rect, 0, key => { for (const obstacle of bins.get(key) || []) if (intersects(rect, obstacle, gap)) found.add(obstacle); return false; });
      return [...found];
    },
  };
}
function* placementAttempts(last, anchors, offsets, nearby, width, height, gap) {
  if (last) yield { ...last, anchor: anchors.find(anchor => anchor.id === (last.anchorId ?? 'center')) };
  for (const anchor of anchors) yield { dx: 0, dy: 0, anchor };
  // Exact cover-edge candidates can fit in small gaps that regular rings skip.
  for (const anchor of anchors) for (const obstacle of nearby({ left: anchor.x - width / 2, right: anchor.x + width / 2,
    top: anchor.y - height / 2, bottom: anchor.y + height / 2 }).slice(0, 4)) {
    yield { dx: 0, dy: obstacle.top - gap - height / 2 - anchor.y, anchor };
    yield { dx: 0, dy: obstacle.bottom + gap + height / 2 - anchor.y, anchor };
    yield { dx: obstacle.left - gap - width / 2 - anchor.x, dy: 0, anchor };
    yield { dx: obstacle.right + gap + width / 2 - anchor.x, dy: 0, anchor };
  }
  for (const offset of offsets) for (const anchor of anchors) yield { ...offset, anchor };
}
// Placement is separate from camera projection: retain dx/dy while the camera
// moves, then use previous offsets first on the next placement pass.
export function placeLabels(candidates, width, height, zoom, limit = 24,
    { obstacles = [], previous = new Map(), minZoom = 1, gap = 6, maxOffset = 120 } = {}) {
  if (zoom < minZoom || limit <= 0) return [];
  const placed = [], { blocked, nearby } = obstacleGrid(obstacles, width, height, gap);
  for (const label of candidates) {
    const w = label.width ?? 6 + label.text.length * 7, h = label.height ?? 20;
    if (!Number.isFinite(label.x) || !Number.isFinite(label.y) || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) continue;
    const last = previous.get(label.name ?? label.text), step = h + gap;
    const anchors = [{ id: 'center', x: label.x, y: label.y }, ...(label.anchors || [])];
    const offsets = [{ dx: 0, dy: 0 }, { dx: 0, dy: -step }, { dx: 0, dy: step },
      { dx: -w / 2 - gap, dy: -step }, { dx: w / 2 + gap, dy: -step },
      { dx: -w / 2 - gap, dy: step }, { dx: w / 2 + gap, dy: step }];
    for (const radius of [...new Set([step * 2, step * 3, step * 4, maxOffset])].filter(radius => radius <= maxOffset)) {
      const diagonal = radius / Math.SQRT2;
      offsets.push(...[[0, -radius], [0, radius], [-radius, 0], [radius, 0],
        [-diagonal, -diagonal], [diagonal, -diagonal], [-diagonal, diagonal], [diagonal, diagonal]].map(([dx, dy]) => ({ dx, dy })));
    }
    // Try nearby places at each representative before searching farther away.
    for (const { dx, dy, anchor } of placementAttempts(last, anchors, offsets, nearby, w, h, gap)) {
      if (!anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y) ||
          !Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) > maxOffset) continue;
      const x = anchor.x + dx, y = anchor.y + dy;
      const rect = { left: x - w / 2, right: x + w / 2, top: y - h / 2, bottom: y + h / 2 };
      if (rect.left < 0 || rect.right > width || rect.top < 0 || rect.bottom > height ||
          blocked(rect) || placed.some(other => intersects(rect, other.rect, gap))) continue;
      placed.push({ ...label, anchorId: anchor.id, anchorX: anchor.x, anchorY: anchor.y, x, y, dx, dy, rect });
      break;
    }
    if (placed.length === limit) break;
  }
  return placed;
}
