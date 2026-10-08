import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { communityColor } from '../logic.mjs';

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const properties = new Map([...css.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
const value = name => properties.get(name).replace(/var\((--[\w-]+)\)/g, (_, alias) => value(alias));
const rgb = name => value(name).slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255);
const palette = ['orange', 'blue', 'purple', 'green', 'red', 'aqua', 'yellow'].map(name => rgb(`--community-${name}`));
const luminance = color => color.slice(0, 3).reduce((sum, channel, i) =>
  sum + (channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][i], 0);
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);

test('chrome text, states and focus remain accessible on opaque Homepage surfaces', () => {
  for (const surface of ['--paper', '--panel', '--selection-bg']) {
    for (const text of ['--ink', '--muted', '--accent', '--accent-hover', '--error']) {
      // Pressed/hover rows promote secondary text to ink; errors stay on paper.
      if (['--error', '--muted'].includes(text) && surface === '--selection-bg') continue;
      assert.ok(contrast(rgb(text), rgb(surface)) >= 4.5, `${text} on ${surface} fails AA`);
    }
  }
  for (const surface of ['--paper', '--panel']) {
    assert.ok(contrast(rgb('--control-border'), rgb(surface)) >= 3);
    assert.ok(contrast(rgb('--accent'), rgb(surface)) >= 3);
  }
  // Primary buttons use paper-colored text against the accent fill.
  assert.ok(contrast(rgb('--paper'), rgb('--accent')) >= 4.5);
  assert.ok(contrast(rgb('--paper'), rgb('--accent-hover')) >= 4.5);
});

test('community colors preserve the exact seven Gruvbox anchors and palette inputs', () => {
  const before = structuredClone(palette), ink = rgb('--ink');
  for (let i = 0; i < palette.length; i++) assert.deepEqual(communityColor(i, palette, ink), [...palette[i], 1]);
  assert.deepEqual(communityColor(42, palette, ink), communityColor(42, palette, ink));
  assert.deepEqual(palette, before);
});

test('larger community scales are distinct and contrast against canvas and legend', () => {
  const colors = Array.from({ length: 96 }, (_, index) => communityColor(index, palette, rgb('--ink')));
  assert.equal(new Set(colors.map(color => color.join(','))).size, colors.length);
  for (const color of colors) {
    assert.equal(color[3], 1);
    assert.ok(color.every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 1));
    for (const surface of ['--paper', '--panel']) {
      assert.ok(contrast(color, rgb(surface)) >= 3, `community color ${color} disappears on ${surface}`);
    }
  }
});
