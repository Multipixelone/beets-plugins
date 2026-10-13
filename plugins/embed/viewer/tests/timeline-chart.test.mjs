import test from 'node:test';
import assert from 'node:assert/strict';
import { init, use } from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { TimelineChart } from '../timeline-chart.mjs';
import { TimelineView } from '../timeline-view.mjs';
import { buildTimeline } from '../timeline.mjs';

use([SVGRenderer]);
const DAY = 86400000, start = Date.UTC(2024, 0, 1);
function fixture() {
  const bins = Array.from({ length: 24 }, (_, index) => ({ start: start + index * DAY, end: start + (index + 1) * DAY }));
  const domain = { startMs: start, endMs: bins.at(-1).end };
  const chart = init(null, null, { renderer: 'svg', ssr: true, width: 1000, height: 220 });
  const adapter = Object.assign(Object.create(TimelineChart.prototype), { chart, theme: {}, element: { clientWidth: 1000, clientHeight: 220 } });
  let renders = 0;
  adapter.bars = function () {
    const series = TimelineChart.prototype.bars.call(this), render = series.renderItem;
    series.renderItem = (...args) => { renders++; return render(...args); }; return series;
  };
  const input = { model: { bins }, aggregation: { stacks: bins.map(() => [{ name: 'a', count: 1 }]) },
    colors: new Map([['a', 'red']]), names: new Map(), domain, range: domain };
  adapter.update(input);
  return { adapter, input, renders: () => renders };
}

test('hover and snapshot guides update retained shapes without rerunning interval renderers', () => {
  const { adapter, input, renders } = fixture();
  try {
    const initial = renders();
    for (let index = 0; index < 10; index++) adapter.update({ ...input, inspectedIndex: index,
      cutoff: start + (index + 1) * DAY, guideTime: start + index * DAY });
    assert.equal(renders(), initial);
    assert.equal(adapter.inspectionShape.ignore, false);
    assert.equal(adapter.cutoffShape.shape.x1, adapter.chart.convertToPixel({ xAxisIndex: 0 }, start + 10 * DAY));
    assert.equal(adapter.guideShape.shape.x1, adapter.chart.convertToPixel({ xAxisIndex: 0 }, start + 9 * DAY));
    adapter.update(input);
    assert.equal(adapter.inspectionShape.ignore, true);
    assert.equal(adapter.cutoffShape.ignore, true);
    assert.equal(renders(), initial);
  } finally { adapter.dispose(); }
});

test('identical dimensions skip ECharts resize; a real resize rerenders and repositions guides once', () => {
  const { adapter, input, renders } = fixture();
  try {
    adapter.update({ ...input, cutoff: start + 12 * DAY });
    const initial = renders(), before = adapter.cutoffShape.shape.x1;
    for (let index = 0; index < 5; index++) adapter.resize();
    assert.equal(renders(), initial);
    adapter.element.clientWidth = 800; adapter.resize();
    assert.equal(renders(), initial + input.model.bins.length);
    assert.notEqual(adapter.cutoffShape.shape.x1, before);
    assert.equal(adapter.cutoffShape.shape.x1, adapter.chart.convertToPixel({ xAxisIndex: 0 }, start + 12 * DAY));
    adapter.resize(); assert.equal(renders(), initial + input.model.bins.length);
  } finally { adapter.dispose(); }
});

test('taste highlights emphasize a group without changing counts or percentage denominators', () => {
  const { adapter, input } = fixture();
  try {
    input.aggregation.stacks = input.model.bins.map(() => [{ name: 'a', count: 1 }, { name: 'b', count: 3 }]);
    const taste = { name: 'b', start: start + DAY * 3, end: start + DAY * 4 };
    adapter.update({ ...input, mode: 'percent', focusedGroup: 'b', tasteRange: taste, tasteHighlights: [taste] });
    assert.equal(adapter.prepared.rows[0].total, 4);
    assert.equal(adapter.prepared.rows[0].segments[0].name, 'b');
    assert.equal(adapter.prepared.rows[0].segments[0].bottom, 0);
    assert.equal(adapter.prepared.rows[0].segments[0].top, 75);
    assert.equal(input.aggregation.stacks[0][0].name, 'a', 'source stack order is preserved');
    assert.equal(adapter.tasteShape.ignore, false); assert.equal(adapter.tasteMarkers[0].ignore, false);
    assert.equal(adapter.tasteMarkers[1].ignore, true);
    const series = adapter.bars(), row = adapter.prepared.rows[0];
    const rendered = series.renderItem({ coordSys: { x: 0, y: 0, width: 100, height: 100 } }, {
      value: dimension => series.data[0][dimension],
      coord: ([time, count]) => [(time - row.start) / DAY * 100, 100 - count] });
    assert.deepEqual(rendered.children.slice(1).map(rect => rect.style.opacity), [1, .16]);
    adapter.update(input);
    assert.equal(adapter.prepared.rows[0].segments[0].name, 'a', 'clearing restores the normal stack order');
    assert.equal(adapter.tasteShape.ignore, true); assert.equal(adapter.tasteMarkers[0].ignore, true);
  } finally { adapter.dispose(); }
});

test('zoom moves retained guides even when the same calendar bins and counts are reused', () => {
  const { adapter, input } = fixture();
  try {
    adapter.update({ ...input, cutoff: start + 12 * DAY });
    const before = adapter.cutoffShape.shape.x1;
    adapter.setRange({ startMs: start + 6 * DAY, endMs: start + 24 * DAY });
    assert.notEqual(adapter.cutoffShape.shape.x1, before);
    assert.equal(adapter.cutoffShape.shape.x1, adapter.chart.convertToPixel({ xAxisIndex: 0 }, start + 12 * DAY));
  } finally { adapter.dispose(); }
});

test('panning within calendar boundaries reuses aggregation while retaining the exact live range', () => {
  const baseModel = buildTimeline(['2024-01-02', '2024-02-02', '2024-03-02'].map(first_played => ({ first_played })));
  const controls = { 'timeline-interval': { value: 'month' }, 'timeline-group': { value: 'cluster' },
    'timeline-mode': { value: 'count' }, 'timeline-measure': {}, 'timeline-peak': {} };
  const view = Object.assign(Object.create(TimelineView.prototype), { baseModel,
    groupings: new Map([['cluster', { values: ['a', 'b', 'a'], order: ['a', 'b'], colors: new Map(), names: new Map() }]]),
    range: { startMs: Date.UTC(2024, 0, 5), endMs: Date.UTC(2024, 2, 10) },
    $: id => controls[id], canvas: { setAttribute() {} },
    renderTasteShifts() {}, renderLegend() {}, measure() {}, renderPlayhead() {}, renderInspection() {}, renderRange() {} });
  view.rebuild(); const model = view.model, aggregation = view.aggregation;
  view.range = { startMs: Date.UTC(2024, 0, 6), endMs: Date.UTC(2024, 2, 11) };
  view.rebuild();
  assert.equal(view.model, model); assert.equal(view.aggregation, aggregation);
  assert.deepEqual(view.range, { startMs: Date.UTC(2024, 0, 6), endMs: Date.UTC(2024, 2, 11) });
  view.range = { startMs: Date.UTC(2024, 1, 6), endMs: Date.UTC(2024, 2, 11) }; view.rebuild();
  assert.notEqual(view.model, model); assert.notEqual(view.aggregation, aggregation);
});

test('closed breakdowns defer row creation until opened, then reuse unchanged rows', () => {
  let created = 0;
  const breakdown = { open: false }, table = { replaceChildren() {}, append() {} };
  const view = Object.assign(Object.create(TimelineView.prototype), { inspectionGroups: [{ name: 'a', count: 1 }],
    inspectionTotal: 1, hiddenGroups: new Set(), names: new Map(), groupButton: () => ({}),
    $: id => id === 'timeline-breakdown' ? breakdown : table,
    document: { createElement() { created++; return { append() {} }; } } });
  view.renderBreakdown(); assert.equal(created, 0);
  breakdown.open = true; view.renderBreakdown(); assert.equal(created, 4);
  view.renderBreakdown(); assert.equal(created, 4);
  view.hiddenGroups = new Set(['a']); view.renderBreakdown(); assert.equal(created, 8);
});
