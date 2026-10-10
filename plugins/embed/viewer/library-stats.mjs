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

export function albumQuality(album) {
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
  return parts.length ? parts.join(' · ') : null;
}

export function albumMetadata(album) {
  const rows = [], quality = albumQuality(album);
  if (quality) rows.push({ label: 'Quality', value: quality });
  if (text(album.added)) {
    const date = new Date(album.added);
    if (Number.isFinite(date.getTime())) rows.push({ label: 'Added', value: date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) });
  }
  const size = formatBytes(album.size_bytes);
  if (size) rows.push({ label: 'Size', value: size });
  const release = album.release;
  if (release && typeof release === 'object') {
    for (const [key, label] of [['albumtype', 'Type'], ['label', 'Label'], ['country', 'Country']]) {
      if (text(release[key])) rows.push({ label, value: text(release[key]) });
    }
    if (count(release.original_year) && release.original_year > 0 && release.original_year !== album.year) rows.push({ label: 'Original year', value: String(release.original_year) });
    if (typeof release.mb_albumid === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(release.mb_albumid)) {
      rows.push({ label: 'Release', value: 'MusicBrainz ↗', href: `https://musicbrainz.org/release/${release.mb_albumid}` });
    }
  }
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

export function appendAlbumMetadata(container, album) {
  const rows = albumMetadata(album), doc = container.ownerDocument;
  if (!rows.length) return;
  const list = doc.createElement('dl'); list.className = 'album-library-meta';
  for (const row of rows) {
    const term = doc.createElement('dt'); term.textContent = row.label;
    const description = doc.createElement('dd');
    if (row.href) {
      const link = doc.createElement('a'); link.href = row.href; link.textContent = row.value;
      link.target = '_blank'; link.rel = 'noopener noreferrer'; description.append(link);
    } else description.textContent = row.value;
    list.append(term, description);
  }
  container.append(list);
}
