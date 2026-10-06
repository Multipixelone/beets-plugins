// Pure sound/lens/filter/label logic. Byte zero means missing, never score zero.
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
  const active = !!needle || !!lens || !!phraseScores || danceMin > 0 || danceMax < 1 || vocal !== 'any';
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
    if (phraseScores) {
      const score = phraseScores[index];
      match &&= score != null && score >= 0.5;
      strength = Math.min(strength, score == null ? 0 : Math.max(0, Math.min(1, (score - 0.5) / 3.5)));
    }
    if (danceMin > 0 || danceMax < 1) {
      const value = album.essentia?.danceable?.value;
      match &&= value == null ? includeUnknown : value >= danceMin && value <= danceMax;
    }
    if (vocal !== 'any') {
      const value = album.essentia?.voice_instrumental?.value;
      match &&= value == null ? includeUnknown : value === vocal;
    }
    return { match, strength: match ? strength : 0, opacity: !active ? 1 : match ? 0.65 + 0.35 * strength : 0,
             size: match && (lens || phraseScores) ? 1 + 0.75 * strength : 1 };
  });
  return { active, states, matches: states.flatMap((state, i) => state.match ? [i] : []) };
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
export function groupLabels(albums, names, visible = () => true) {
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
    const words = ranked(flavor).filter(([word, score]) => score / indices.length >= 0.25 && shortLabel(word) !== shortLabel(main || ''))
      .slice(0, 2).map(([word]) => shortLabel(word));
    return { name, indices, text: [main ? shortLabel(main) : name, ...words].join(' · ') };
  }).sort((a, b) => b.indices.length - a.indices.length || a.name.localeCompare(b.name));
}
export function placeLabels(candidates, width, height, zoom, limit = 24) {
  if (zoom < 1) return [];
  const placed = [];
  for (const label of candidates) {
    const w = Math.min(280, 18 + label.text.length * 7), h = 30;
    const rect = { left: label.x - w / 2, right: label.x + w / 2, top: label.y - h / 2, bottom: label.y + h / 2 };
    if (!Number.isFinite(label.x) || !Number.isFinite(label.y) || rect.left < 0 || rect.right > width || rect.top < 0 || rect.bottom > height) continue;
    if (placed.some(other => !(rect.right + 8 < other.rect.left || rect.left > other.rect.right + 8 ||
                              rect.bottom + 8 < other.rect.top || rect.top > other.rect.bottom + 8))) continue;
    placed.push({ ...label, rect });
    if (placed.length === limit) break;
  }
  return placed;
}
