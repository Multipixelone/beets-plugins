import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimelineGeometry } from '../timeline-geometry.mjs';

const at = date => Date.parse(`${date}T00:00:00Z`);
const boundaries = ['2024-01-01', '2024-02-01', '2024-03-01', '2024-04-01'].map(at);
const bins = boundaries.slice(0, -1).map((startMs, index) => ({ startMs, endMs: boundaries[index + 1] }));
const geometry = width => createTimelineGeometry({ domainStartMs: boundaries[0], domainEndMs: boundaries.at(-1),
  bins, viewportWidth: width, plotPadding: { left: 14, right: 20 }, thumbInset: 8 });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < .001, `${actual} ≠ ${expected}`);

test('real UTC boundaries, padding and native thumb travel use one linear scale', () => {
  const g = geometry(390);
  assert.ok(Object.isFrozen(g) && Object.isFrozen(g.plot) && Object.isFrozen(g.domain));
  assert.equal(g.plot.left, 22); assert.equal(g.plot.right, 362);
  assert.equal(g.xForTime(boundaries[0]), g.plot.left);
  assert.equal(g.xForTime(boundaries.at(-1)), g.plot.right);
  const january = g.xForTime(boundaries[1]) - g.xForTime(boundaries[0]);
  const february = g.xForTime(boundaries[2]) - g.xForTime(boundaries[1]);
  near(january / february, 31 / 29);
  for (const date of [...boundaries, at('2024-02-29')]) {
    near(g.timeForX(g.xForTime(date)), date);
    const inputLeft = g.plot.left - g.thumbInset, inputWidth = g.plot.width + 2 * g.thumbInset;
    near(inputLeft + g.thumbInset + (date - g.domain.startMs) /
      (g.domain.endMs - g.domain.startMs) * (inputWidth - 2 * g.thumbInset), g.xForTime(date));
  }
});
test('shortest interval stays at least twelve pixels, independently of viewport', () => {
  for (const width of [0, 50, 390, 1440]) {
    const g = geometry(width);
    assert.ok(g.contentWidth >= width);
    for (const bin of bins) assert.ok(g.xForTime(bin.endMs) - g.xForTime(bin.startMs) >= 12 - 1e-10);
  }
  near(geometry(0).contentWidth, 50 + 12 * 91 / 29);
});
test('inverse hit testing assigns exact interior boundaries to the following bin', () => {
  const g = geometry(390);
  for (const [index, bin] of bins.entries()) {
    assert.equal(g.binIndexForX(g.xForTime(bin.startMs)), index);
    assert.equal(g.binIndexForX(g.xForTime(bin.endMs) - .001), index);
  }
  assert.equal(g.binIndexForX(g.plot.left - 100), 0);
  assert.equal(g.binIndexForX(g.plot.right + 100), 2);
  assert.equal(g.timeForX(-100), boundaries[0]);
  assert.equal(g.timeForX(10000), boundaries.at(-1));
});
test('client conversion survives scrolling, resize and a nonzero stage offset', () => {
  for (const width of [390, 1440]) for (const scrollLeft of [0, 40, 300]) {
    const g = geometry(width), stage = { left: 73.5 };
    for (const date of boundaries) {
      const x = g.xForTime(date), client = g.contentToClientX(x, stage, scrollLeft);
      near(g.clientToContentX(client, stage, scrollLeft), x);
    }
  }
});
test('copied intervals cannot change hit testing, and invalid geometry fails explicitly', () => {
  const copy = bins.map(bin => ({ ...bin }));
  const options = { domainStartMs: boundaries[0], domainEndMs: boundaries.at(-1), bins: copy, viewportWidth: 300 };
  const g = createTimelineGeometry(options); copy[0].endMs = boundaries.at(-1);
  assert.equal(g.binIndexForX(g.xForTime(boundaries[1])), 1);
  assert.throws(() => createTimelineGeometry({ ...options, domainEndMs: boundaries[0] }), RangeError);
  assert.throws(() => createTimelineGeometry({ ...options, thumbInset: -1 }), RangeError);
  assert.throws(() => createTimelineGeometry({ ...options, bins: [{ startMs: 0, endMs: 1 }] }), RangeError);
  const empty = createTimelineGeometry({ ...options, bins: [] });
  assert.equal(empty.binIndexForX(20), -1);
});
