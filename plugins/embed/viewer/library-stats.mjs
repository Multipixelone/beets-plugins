// Optional export metadata: presentation only, independent of map filtering.
const count = value => Number.isInteger(value) && value >= 0;
const quantity = value => Number.isFinite(value) && value >= 0;
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const number = (value, digits = 0) => value.toLocaleString('en-US', { maximumFractionDigits: digits });
const rounded = (value, digits = 1) => value > 0 && value < 10 ** -digits ? `<${10 ** -digits}` : number(value, digits);
const DAY = 86400, YEAR = DAY * 365.25, LIFETIME = YEAR * 80;

export function formatBytes(value) {
  if (!quantity(value)) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const unit = value ? Math.min(Math.floor(Math.log(value) / Math.log(1000)), units.length - 1) : 0;
  return `${rounded(value / 1000 ** Math.max(0, unit), unit > 0 ? 1 : 0)} ${units[Math.max(0, unit)]}`;
}

export function formatHours(seconds) {
  if (!quantity(seconds)) return null;
  const amount = rounded(seconds / 3600, seconds >= 360000 ? 0 : 1);
  return `${amount} ${amount === '1' ? 'hour' : 'hours'}`;
}

export function listeningScale(seconds) {
  if (!quantity(seconds) || seconds === 0) return null;
  if (seconds >= LIFETIME) {
    const amount = rounded(seconds / LIFETIME);
    return `That's ${amount} 80-year lifetime${amount === '1' ? '' : 's'} of nonstop listening`;
  }
  const [divisor, unit] = seconds >= YEAR ? [YEAR, 'year'] : seconds >= DAY ? [DAY, 'day'] : [3600, 'hour'];
  const amount = rounded(seconds / divisor);
  return `That's ${amount} ${unit}${amount === '1' ? '' : 's'} of nonstop listening`;
}

export function librarySummary(library) {
  const primary = [], secondary = [];
  if (!library || typeof library !== 'object') return { primary, secondary };
  if (count(library.albums)) primary.push(`${number(library.albums)} ${library.albums === 1 ? 'album' : 'albums'}`);
  const size = formatBytes(library.size_bytes), hours = formatHours(library.duration_seconds);
  if (size) primary.push(size);
  if (hours) primary.push(`${hours} of music`);
  const scale = listeningScale(library.duration_seconds);
  if (scale) secondary.push(scale);
  if (count(library.albums) && library.albums > 0 && count(library.lossless_albums) && library.lossless_albums <= library.albums) {
    const share = library.lossless_albums / library.albums * 100;
    const percent = share > 0 && share < 1 ? '<1' : share < 100 && share > 99 ? '>99' : number(share);
    secondary.push(`${percent}% lossless`);
  }
  if (library.formats && typeof library.formats === 'object' && !Array.isArray(library.formats)) {
    const formats = Object.entries(library.formats).filter(([name, stats]) => text(name) && count(stats?.tracks) && stats.tracks > 0)
      .sort((a, b) => b[1].tracks - a[1].tracks || a[0].localeCompare(b[0], 'en'));
    if (formats.length) secondary.push(`Formats (tracks): ${formats.slice(0, 2).map(([name, stats]) => `${name} ${number(stats.tracks)}`).join(' · ')}${formats.length > 2 ? ` · +${number(formats.length - 2)} formats` : ''}`);
  }
  const listened = formatHours(library.listened_seconds_estimate);
  if (listened) secondary.push(`Estimated listened: ${listened}`);
  return { primary, secondary };
}

export function albumQualityParts(album) {
  const format = text(album.format), parts = [];
  if (format) parts.push(format);
  if (format === 'Mixed') {
    if (album.formats && typeof album.formats === 'object' && !Array.isArray(album.formats)) {
      const formats = Object.entries(album.formats).filter(([name, tracks]) => text(name) && count(tracks) && tracks > 0)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en'));
      if (formats.length) parts.push(formats.map(([name, tracks]) => `${name} ${number(tracks)} ${tracks === 1 ? 'track' : 'tracks'}`).join(' / '));
    }
  } else if (album.lossless === false) {
    if (quantity(album.bitrate_kbps) && album.bitrate_kbps > 0) parts.push(`${number(album.bitrate_kbps)} kbps`);
  } else {
    const quality = [];
    if (count(album.bitdepth) && album.bitdepth > 0) quality.push(`${number(album.bitdepth)}-bit`);
    if (quantity(album.samplerate_hz) && album.samplerate_hz > 0) quality.push(`${number(album.samplerate_hz / 1000, 2)} kHz`);
    if (quality.length) parts.push(quality.join(' / '));
    else if (album.lossless === true) parts.push('Lossless');
    else if (quantity(album.bitrate_kbps) && album.bitrate_kbps > 0) parts.push(`${number(album.bitrate_kbps)} kbps`);
  }
  return parts;
}

export function albumQuality(album) {
  const parts = albumQualityParts(album);
  return parts.length ? parts.join(' · ') : null;
}

const addedDate = value => {
  if (!text(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) : null;
};
const releaseInfo = album => album.release && typeof album.release === 'object' ? album.release : {};
const originalYear = (release, year) =>
  count(release.original_year) && release.original_year > 0 && release.original_year !== year ? String(release.original_year) : null;

export function releaseHref(album) {
  const id = releaseInfo(album ?? {}).mb_albumid;
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? `https://musicbrainz.org/release/${id}` : null;
}

export function albumMetadata(album) {
  const rows = [], quality = albumQuality(album);
  if (quality) rows.push({ label: 'Quality', value: quality });
  const added = addedDate(album.added);
  if (added) rows.push({ label: 'Added', value: added });
  const size = formatBytes(album.size_bytes);
  if (size) rows.push({ label: 'Size', value: size });
  const release = releaseInfo(album);
  for (const [key, label] of [['albumtype', 'Type'], ['label', 'Label'], ['country', 'Country']]) {
    if (text(release[key])) rows.push({ label, value: text(release[key]) });
  }
  const original = originalYear(release, album.year);
  if (original) rows.push({ label: 'Original year', value: original });
  const href = releaseHref(album);
  if (href) rows.push({ label: 'Release', value: 'MusicBrainz ↗', href });
  return rows;
}

export function renderLibraryStats(container, library) {
  const content = container.querySelector('.section-content');
  content.replaceChildren();
  const { primary, secondary } = librarySummary(library), doc = container.ownerDocument;
  container.hidden = !primary.length && !secondary.length;
  if (container.hidden) return;
  if (primary.length) {
    const line = doc.createElement('p'); line.className = 'library-primary'; line.textContent = primary.join(' · ');
    content.append(line);
  }
  for (const value of secondary) {
    const line = doc.createElement('p'); line.className = 'library-secondary'; line.textContent = value;
    if (value.startsWith('Estimated listened:')) {
      const explanation = doc.createElement('small'); explanation.textContent = ' (play count × track length)'; line.append(explanation);
    }
    content.append(line);
  }
}

// The link rides with the final title word in one span, glued by a word
// joiner so wrapping never separates them — even for CJK titles or trailing
// punctuation — while overflow-wrap on the heading breaks huge words safely.
const WORD_JOINER = '\u2060';
export function appendAlbumTitle(title, album) {
  const doc = title.ownerDocument;
  const text = typeof album.album === 'string' ? album.album.trimEnd() : '';
  const href = releaseHref(album);
  if (!href) { title.append(text); return; }
  const finalWord = text.match(/\S+$/)?.[0] ?? '';
  title.append(text.slice(0, text.length - finalWord.length));
  const tail = doc.createElement('span'); tail.className = 'title-tail';
  tail.append(finalWord + WORD_JOINER);
  const link = doc.createElement('a'); link.className = 'release-link'; link.href = href;
  link.target = '_blank'; link.rel = 'noopener noreferrer';
  link.setAttribute('aria-label', 'View release on MusicBrainz.');
  link.title = 'View release on MusicBrainz.';
  const icon = doc.createElement('span'); icon.setAttribute('aria-hidden', 'true'); icon.textContent = '↗';
  link.append(icon);
  tail.append(link);
  title.append(tail);
}

export function appendAlbumSubline(line, album) {
  const doc = line.ownerDocument, release = releaseInfo(album);
  const values = [text(album.albumartist), album.year || null, text(release.albumtype), text(album.genre)];
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const item = doc.createElement('span'); item.textContent = String(value); line.append(item);
  }
}

// Compact inline facts: playback and audio groups sit side by side when they
// fit, provenance pairs wrap below. Each fact is a flex item, so it wraps to
// the next line whole and only breaks internally when impossibly long.
// Missing fields leave no blank rows.
export function appendAlbumMetadata(container, album) {
  const doc = container.ownerDocument, release = releaseInfo(album);
  const playback = [], audio = [], facts = [];
  if (count(album.track_count)) playback.push(`${album.track_count} ${album.track_count === 1 ? 'track' : 'tracks'}`);
  if (quantity(album.summed_plays)) playback.push(`${album.summed_plays.toLocaleString()} ${album.summed_plays === 1 ? 'play' : 'plays'}`);
  audio.push(...albumQualityParts(album));
  const size = formatBytes(album.size_bytes);
  if (size) audio.push(size);
  if (text(release.label)) facts.push(['Label', text(release.label)]);
  if (text(release.country)) facts.push(['Country', text(release.country)]);
  const original = originalYear(release, album.year);
  if (original) facts.push(['Original year', original]);
  const added = addedDate(album.added);
  if (added) facts.push(['Added', added]);
  if (playback.length || audio.length) {
    const groups = doc.createElement('div'); groups.className = 'album-facts';
    for (const values of [playback, audio]) {
      if (!values.length) continue;
      const group = doc.createElement('p'); group.className = 'fact-group';
      for (const value of values) {
        const fact = doc.createElement('span'); fact.textContent = value;
        group.append(fact);
      }
      groups.append(group);
    }
    container.append(groups);
  }
  if (facts.length) {
    const footer = doc.createElement('p'); footer.className = 'album-footer';
    for (const [label, value] of facts) {
      const pair = doc.createElement('span'); pair.className = 'fact-pair';
      const key = doc.createElement('span'); key.className = 'fact-label'; key.textContent = label;
      const val = doc.createElement('span'); val.className = 'fact-value'; val.textContent = value;
      pair.append(key, ' ', val);
      footer.append(pair);
    }
    container.append(footer);
  }
}
