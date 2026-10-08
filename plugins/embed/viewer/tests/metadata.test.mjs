import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const metas = new Map([...html.matchAll(/<meta\b[^>]*>/g)].map(([tag]) => {
  const attrs = new Map([...tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)]
    .map(([, name, value]) => [name, value]));
  return [attrs.get('property') ?? attrs.get('name'), attrs.get('content')];
}).filter(([key]) => key));
const linkHrefs = new Map([...html.matchAll(/<link\b[^>]*>/g)].map(([tag]) => {
  const attrs = new Map([...tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)]
    .map(([, name, value]) => [name, value]));
  return [attrs.get('rel'), attrs.get('href')];
}));

test('document declares title, description, canonical and robots for the public deployment', () => {
  assert.match(html, /<title>Finn's Library<\/title>/);
  assert.match(html, /<h1>Finn's Library<\/h1>/);
  assert.ok(metas.get('description').length > 40);
  assert.equal(linkHrefs.get('canonical'), 'https://albums.finnrut.is/');
  assert.match(metas.get('robots'), /index, follow/);
  assert.ok(metas.get('author'));
  assert.equal(metas.get('theme-color'), '#1c1915');
  // Superseded public copy must not creep back into user-facing metadata.
  assert.ok(!html.includes('built from how albums sound'));
});

test('Open Graph metadata is complete with absolute public URLs', () => {
  assert.equal(metas.get('og:title'), "Finn's Library");
  assert.equal(metas.get('og:type'), 'website');
  assert.equal(metas.get('og:url'), 'https://albums.finnrut.is/');
  assert.ok(metas.get('og:description'));
  assert.equal(metas.get('og:site_name'), "Finn's Library");
  assert.equal(metas.get('og:locale'), 'en_US');
  assert.equal(metas.get('og:image'), 'https://albums.finnrut.is/social-card.png');
  assert.equal(metas.get('og:image:width'), '2400');
  assert.equal(metas.get('og:image:height'), '1260');
  assert.equal(metas.get('og:image:type'), 'image/png');
  assert.ok(metas.get('og:image:alt'));
});

test('Twitter card metadata mirrors Open Graph with a large image', () => {
  assert.equal(metas.get('twitter:card'), 'summary_large_image');
  assert.equal(metas.get('twitter:title'), "Finn's Library");
  assert.ok(metas.get('twitter:description'));
  assert.equal(metas.get('twitter:image'), metas.get('og:image'));
  assert.ok(metas.get('twitter:image:alt'));
  // Link previews must never fall back to relative URLs scrapers cannot fetch.
  for (const key of ['og:url', 'og:image', 'twitter:image']) {
    assert.match(metas.get(key), /^https:\/\//, `${key} must be an absolute public URL`);
  }
});

test('favicon is linked at the path the build publishes', () => {
  assert.equal(linkHrefs.get('icon'), '/favicon.ico');
});

test('footer pairs source and license links for public visitors', () => {
  assert.ok(html.includes('href="https://github.com/Multipixelone/beets-plugins/tree/main/plugins/embed/viewer"'));
  assert.ok(html.includes('View source code'));
  assert.ok(html.includes('Open-source licenses'));
});

test('branding assets exist with the formats and dimensions the metadata declares', () => {
  const favicon = readFileSync(new URL('../static/favicon.ico', import.meta.url));
  assert.deepEqual([...favicon.subarray(0, 4)], [0, 0, 1, 0], 'favicon.ico is not an ICO file');
  assert.ok(favicon.length < 512 * 1024);
  const card = readFileSync(new URL('../static/social-card.png', import.meta.url));
  assert.deepEqual([...card.subarray(1, 4)], [...Buffer.from('PNG')], 'social-card.png is not a PNG');
  // IHDR width/height are big-endian uint32 at byte offsets 16 and 20.
  assert.equal(card.readUInt32BE(16), 2400);
  assert.equal(card.readUInt32BE(20), 1260);
  assert.ok(card.length < 1024 * 1024, 'social card should stay under 1 MiB for scrapers');
});
