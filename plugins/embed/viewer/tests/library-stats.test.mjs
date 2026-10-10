import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateExport } from '../logic.mjs';
import { formatBytes, formatHours, listeningScale, librarySummary, albumQuality, albumMetadata, renderLibraryStats, appendAlbumMetadata, appendAlbumTitle, appendAlbumSubline, releaseHref } from '../library-stats.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/library-stats.json', import.meta.url)));
const year = 365.25 * 86400;

test('fixture validates without changing graph metadata or requiring the additions', () => {
  assert.equal(validateExport(structuredClone(fixture)).albums.length, 6);
  const old = structuredClone(fixture);
  delete old.library;
  old.albums = [old.albums.at(-1)];
  for (const schema_version of [1, 2, 3]) {
    assert.equal(validateExport({ ...old, schema_version }).albums.length, 1);
  }
});

test('storage and hours use decimal units, separators and honest small quantities', () => {
  for (const [bytes, value] of [[0, '0 B'], [800, '800 B'], [1000, '1 KB'], [1234567, '1.2 MB'], [1234567890, '1.2 GB'], [1500000000000, '1.5 TB']]) {
    assert.equal(formatBytes(bytes), value);
  }
  assert.equal(formatHours(11160000), '3,100 hours');
  assert.equal(formatHours(1800), '0.5 hours');
  assert.equal(formatHours(3600), '1 hour');
  assert.equal(formatHours(1), '<0.1 hours');
  assert.equal(formatHours(0), '0 hours');
  for (const value of [undefined, null, NaN, Infinity, -1, '123']) {
    assert.equal(formatBytes(value), null);
    assert.equal(formatHours(value), null);
  }
});

test('listening comparisons select units from real durations, never premature lifetimes', () => {
  assert.equal(listeningScale(3600), "That's 1 hour of nonstop listening");
  assert.equal(listeningScale(86400), "That's 1 day of nonstop listening");
  assert.equal(listeningScale(year), "That's 1 year of nonstop listening");
  assert.match(listeningScale(year - 1), /days of nonstop listening$/);
  assert.match(listeningScale(80 * year - 1), /years of nonstop listening$/);
  assert.equal(listeningScale(80 * year), "That's 1 80-year lifetime of nonstop listening");
  assert.equal(listeningScale(160 * year), "That's 2 80-year lifetimes of nonstop listening");
  assert.equal(listeningScale(80.1 * year), "That's 1 80-year lifetime of nonstop listening");
  assert.match(listeningScale(fixture.library.duration_seconds), /129\.2 days/);
  for (const value of [0, null, undefined, -1, Infinity]) assert.equal(listeningScale(value), null);
});

test('whole-library summary uses library totals, not graph or format album counts', () => {
  const summary = librarySummary(fixture.library);
  assert.deepEqual(summary.primary, ['4,012 albums', '1.5 TB', '3,100 hours of music']);
  assert.ok(summary.secondary.includes('82% lossless'));
  assert.ok(summary.secondary.includes('Estimated listened: 5,760 hours'));
  assert.ok(summary.secondary.includes('Formats (tracks): FLAC 36,000 · MP3 3,600 · +2 formats'));
  const overlapping = { albums: 10, lossless_albums: 8, formats: { FLAC: { albums: 10, tracks: 100 }, MP3: { albums: 10, tracks: 20 } } };
  assert.ok(librarySummary(overlapping).secondary.includes('80% lossless'));
  assert.match(librarySummary(overlapping).secondary.at(-1), /FLAC 100 · MP3 20/);
  // Map filtering cannot affect this presentation: it accepts only library totals.
  assert.deepEqual(librarySummary({ ...fixture.library }), summary);
});

test('partial totals omit missing values and preserve meaningful zeroes', () => {
  for (const value of [undefined, null, {}, { albums: null, size_bytes: -1, duration_seconds: '0', formats: [] }]) {
    assert.deepEqual(librarySummary(value), { primary: [], secondary: [] });
  }
  assert.deepEqual(librarySummary({ albums: 0, lossless_albums: 0, size_bytes: 0, duration_seconds: 0, listened_seconds_estimate: 0 }), {
    primary: ['0 albums', '0 B', '0 hours of music'], secondary: ['Estimated listened: 0 hours']
  });
  assert.deepEqual(librarySummary({ albums: 4, lossless_albums: 5 }).secondary, []);
  assert.ok(librarySummary({ albums: 10000, lossless_albums: 1 }).secondary.includes('<1% lossless'));
  assert.ok(librarySummary({ albums: 10000, lossless_albums: 9999 }).secondary.includes('>99% lossless'));
});

test('quality distinguishes lossless, lossy, mixed and partially available metadata', () => {
  assert.equal(albumQuality(fixture.albums[0]), 'FLAC · 24-bit / 96 kHz');
  assert.equal(albumQuality(fixture.albums[1]), 'MP3 · 320 kbps');
  assert.equal(albumQuality(fixture.albums[2]), 'Mixed · FLAC 8 tracks / MP3 2 tracks');
  assert.equal(albumQuality(fixture.albums[3]), '44.1 kHz');
  assert.equal(albumQuality({ lossless: true }), 'Lossless');
  assert.equal(albumQuality({ format: 'FLAC', bitdepth: 16 }), 'FLAC · 16-bit');
  assert.equal(albumQuality({ bitrate_kbps: 256 }), '256 kbps');
  assert.equal(albumQuality({ format: 'Mixed', bitdepth: 24, samplerate_hz: 96000, bitrate_kbps: 320 }), 'Mixed');
  assert.equal(albumQuality(fixture.albums[4]), null);
  assert.equal(albumQuality(fixture.albums[5]), null);
});

test('album rows format dates in UTC, suppress repeated years and link safe releases', () => {
  const rows = albumMetadata(fixture.albums[0]);
  assert.deepEqual(rows.slice(0, 3), [
    { label: 'Quality', value: 'FLAC · 24-bit / 96 kHz' },
    { label: 'Added', value: 'Oct 9, 2026' },
    { label: 'Size', value: '1.3 GB' }
  ]);
  assert.ok(rows.some(row => row.label === 'Original year' && row.value === '1998'));
  assert.equal(rows.at(-1).href, 'https://musicbrainz.org/release/12345678-abcd-1234-abcd-123456789abc');
  assert.ok(!albumMetadata(fixture.albums[1]).some(row => row.label === 'Original year'));
  assert.deepEqual(albumMetadata(fixture.albums[4]), []);
  assert.deepEqual(albumMetadata(fixture.albums[5]), []);
  assert.deepEqual(albumMetadata({ added: 'invalid', release: { mb_albumid: 'javascript:alert(1)' } }), []);
  assert.deepEqual(albumMetadata({ release: { mb_albumid: '../private' } }), []);
  const boundary = albumMetadata({ added: '2026-10-09T00:01:00Z', size_bytes: 0 });
  assert.equal(boundary[0].value, 'Oct 9, 2026');
  assert.equal(boundary[1].value, '0 B');
});

// A minimal DOM surface checks rendering and stale-state cleanup without adding
// a runtime dependency. Real layout is checked separately in the browser.
class Element {
  constructor(tagName, ownerDocument) { this.tagName = tagName; this.ownerDocument = ownerDocument; this.children = []; this.content = ''; }
  set textContent(value) { this.content = value; this.children = []; }
  get textContent() { return this.content + this.children.map(child => child.textContent ?? child).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.content = ''; this.children = children; }
  setAttribute(name, value) { (this.attributes ??= new Map()).set(name, String(value)); }
  getAttribute(name) { return this.attributes?.get(name); }
  querySelector(selector) { return this.children.find(child => `.${child.className}` === selector); }
}
const doc = { createElement: tagName => new Element(tagName, doc) };

test('statistics rendering preserves its heading and expanded state while clearing legacy totals', () => {
  const container = doc.createElement('details'), summary = doc.createElement('summary'), content = doc.createElement('div');
  summary.textContent = 'Library Statistics'; content.className = 'section-content';
  container.append(summary, content); container.open = false;
  renderLibraryStats(container, fixture.library);
  assert.equal(container.hidden, false);
  assert.equal(container.open, false);
  assert.equal(container.children[0], summary);
  assert.equal(content.children[0].textContent, '4,012 albums · 1.5 TB · 3,100 hours of music');
  assert.match(container.textContent, /Estimated listened: 5,760 hours \(play count × track length\)/);
  assert.ok(!container.textContent.includes('missing_files'));
  assert.ok(!container.textContent.includes(fixture.library.computed_at));
  container.open = true;
  for (const library of [undefined, null, {}, { lossless_albums: 0 }]) {
    renderLibraryStats(container, library);
    assert.equal(container.hidden, true);
    assert.equal(content.textContent, '');
    assert.equal(container.textContent, 'Library Statistics');
    assert.equal(container.children[0], summary);
    assert.equal(container.open, true);
  }
  renderLibraryStats(container, { albums: 3 });
  assert.equal(container.hidden, false);
  assert.equal(content.textContent, '3 albums');
  assert.equal(container.open, true);
});

test('album metadata keeps inline fact groups and footer pairs complete without blank rows', () => {
  const sparse = doc.createElement('div');
  appendAlbumMetadata(sparse, fixture.albums[4]);
  assert.equal(sparse.children.length, 1);
  assert.equal(sparse.children[0].className, 'album-facts');
  const group = sparse.children[0].children[0];
  assert.equal(group.className, 'fact-group');
  assert.equal(group.tagName, 'p');
  assert.deepEqual(group.children.map(child => child.textContent), ['10 tracks', '120 plays']);
  const fractional = doc.createElement('div');
  appendAlbumMetadata(fractional, { ...fixture.albums[4], track_count: 1, embedded_tracks: 1, summed_plays: 1.5 });
  assert.deepEqual(fractional.children[0].children[0].children.map(child => child.textContent), ['1 track', '1.5 plays']);
  const container = doc.createElement('div');
  appendAlbumMetadata(container, { ...fixture.albums[0], release: { ...fixture.albums[0].release, label: '<img src=x onerror=alert(1)>' } });
  const [facts, footer] = container.children;
  assert.equal(facts.className, 'album-facts');
  assert.equal(footer.className, 'album-footer');
  assert.deepEqual(facts.children.map(child => child.className), ['fact-group', 'fact-group']);
  assert.deepEqual(facts.children[1].children.map(child => child.textContent), ['FLAC', '24-bit / 96 kHz', '1.3 GB']);
  assert.ok(footer.textContent.includes('<img src=x onerror=alert(1)>'));
  assert.deepEqual(footer.children.map(pair => pair.querySelector('.fact-label').textContent), ['Label', 'Country', 'Original year', 'Added']);
  assert.deepEqual(footer.children.map(pair => pair.querySelector('.fact-value').textContent), ['<img src=x onerror=alert(1)>', 'GB', '1998', 'Oct 9, 2026']);
  const flat = element => [element, ...element.children.filter(child => child instanceof Element).flatMap(flat)];
  assert.ok(!container.children.flatMap(flat).some(child => child.tagName === 'img'));
});

test('album title glues the MusicBrainz link to the final word with a fixed destination', () => {
  const plain = doc.createElement('h2');
  appendAlbumTitle(plain, fixture.albums[1]);
  assert.equal(plain.textContent, 'Signals at Dawn');
  assert.ok(!plain.querySelector('.release-link'));
  const heading = doc.createElement('h2');
  appendAlbumTitle(heading, fixture.albums[0]);
  const tail = heading.querySelector('.title-tail');
  const link = tail.querySelector('.release-link');
  assert.ok(heading.textContent.startsWith('Night Orchard'));
  assert.equal(heading.children[0], 'Night ');
  assert.equal(heading.children.at(-1), tail);
  assert.equal(tail.children.at(-1), link);
  assert.equal(tail.children[0], 'Orchard' + '\u2060');
  assert.equal(link.href, 'https://musicbrainz.org/release/12345678-abcd-1234-abcd-123456789abc');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(link.target, '_blank');
  assert.equal(link.getAttribute('aria-label'), 'View release on MusicBrainz.');
  assert.equal(link.title, 'View release on MusicBrainz.');
  for (const mb_albumid of ['javascript:alert(1)', '../private', null, 42]) {
    const evil = doc.createElement('h2');
    appendAlbumTitle(evil, { album: 'Traps', release: { mb_albumid } });
    assert.equal(evil.textContent, 'Traps');
    assert.ok(!evil.querySelector('.release-link'));
  }
  assert.equal(releaseHref(fixture.albums[0]), 'https://musicbrainz.org/release/12345678-abcd-1234-abcd-123456789abc');
  assert.equal(releaseHref({}), null);
});

test('album subline lists artist, year, genre and type while omitting missing values', () => {
  const full = doc.createElement('p');
  appendAlbumSubline(full, fixture.albums[0]);
  assert.deepEqual(full.children.map(child => child.textContent), ['The Lantern Rooms', '2011', 'Electronic', 'album']);
  const untyped = doc.createElement('p');
  appendAlbumSubline(untyped, fixture.albums[3]);
  assert.deepEqual(untyped.children.map(child => child.textContent), ['Tessa Vale', '2011', 'Electronic']);
  const older = doc.createElement('p');
  appendAlbumSubline(older, fixture.albums[5]);
  assert.deepEqual(older.children.map(child => child.textContent), ['Yesterday Club', '2011', 'Electronic']);
  const empty = doc.createElement('p');
  appendAlbumSubline(empty, {});
  assert.equal(empty.children.length, 0);
  for (const [genre, albumtype, expected] of [
    ['Indie Pop', 'album', ['Indie Pop', 'album']],
    ['Indie Rock', 'EP', ['Indie Rock', 'EP']],
    ['Jazz', 'single', ['Jazz', 'single']],
    ['  Jazz  ', ' single ', ['Jazz', 'single']],
    [null, 'EP', ['EP']],
    ['Jazz', null, ['Jazz']],
    ['  ', '  ', []],
  ]) {
    const line = doc.createElement('p');
    appendAlbumSubline(line, { albumartist: 'Mitski', year: 2018, genre, release: { albumtype } });
    assert.deepEqual(line.children.map(child => child.textContent), ['Mitski', '2018', ...expected]);
  }
});
