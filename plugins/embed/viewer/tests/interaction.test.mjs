import test from 'node:test';
import assert from 'node:assert/strict';
import { pinchTransform, TouchNavigation } from '../interaction.mjs';

const limits = [.001, Infinity];
test('pinch scales around its midpoint in a translated, zoomed camera', () => {
  const transform = { x: 20, y: -10, k: 2 };
  const next = pinchTransform(transform, [[60, 90], [140, 90]], [[20, 90], [180, 90]], limits);
  assert.deepEqual(next, { x: -60, y: -110, k: 4 });
  assert.equal((100 - next.x) / next.k, (100 - transform.x) / transform.k);
  assert.equal((90 - next.y) / next.k, (90 - transform.y) / transform.k);
});
test('moving the midpoint pans while retaining the world anchor', () => {
  assert.deepEqual(pinchTransform({ x: 10, y: 20, k: 1 }, [[50, 100], [150, 100]],
    [[70, 130], [270, 130]], limits), { x: -10, y: -30, k: 2 });
  assert.deepEqual(pinchTransform({ x: 10, y: 20, k: 1 }, [[50, 100], [150, 100]],
    [[70, 130], [170, 130]], limits), { x: 30, y: 50, k: 1 });
});
test('clamping uses the actual scale to preserve midpoint anchoring', () => {
  const before = [[-50, 40], [50, 40]], transform = { x: -20, y: 10, k: 1 };
  assert.deepEqual(pinchTransform(transform, before, [[-500, 50], [500, 50]], [.5, 3]),
    { x: -60, y: -40, k: 3 });
  assert.deepEqual(pinchTransform(transform, before, [[-1, 50], [1, 50]], [.5, 3]),
    { x: -10, y: 35, k: .5 });
  assert.equal(pinchTransform(transform, before, [[-.001, 40], [.001, 40]], limits).k, .001);
  assert.equal(pinchTransform(transform, before, [[-50000, 40], [50000, 40]], limits).k, 1000);
});
test('coincident or invalid fingers and cameras cannot produce NaN transforms', () => {
  const transform = { x: 2, y: 3, k: 4 }, pair = [[0, 0], [100, 0]];
  for (const bad of [[[0, 0], [0, 0]], [[NaN, 0], [100, 0]]]) {
    assert.deepEqual(pinchTransform(transform, bad, pair, limits), transform);
    assert.deepEqual(pinchTransform(transform, pair, bad, limits), transform);
  }
  assert.deepEqual(pinchTransform({ x: 2, y: 3, k: 0 }, pair, pair, limits), { x: 2, y: 3, k: 0 });
});

class Surface extends EventTarget {
  constructor(graph = false) { super(); this.graph = graph; this.captures = new Set(); }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
  contains(target) { return target === this; }
}
function fixture() {
  const root = new Surface(), graph = new Surface(true), overlay = new Surface(), chart = new Surface();
  chart.independent = true;
  root.ownerDocument = new EventTarget(); root.ownerDocument.defaultView = new EventTarget();
  const calls = [], camera = {
    local: point => point, limits: () => limits, transform: () => camera.value,
    value: { x: 0, y: 0, k: 1 }, node: undefined,
    interrupt: () => calls.push('interrupt'), pick: () => camera.node,
    tap: () => calls.push('tap'), startDrag: () => calls.push('dragStart'),
    drag: () => calls.push('drag'), endDrag: () => calls.push('dragEnd'),
    apply(value) { camera.value = value; calls.push('apply'); }
  };
  const navigation = new TouchNavigation(root, { camera: () => camera,
    isGraph: target => target.graph, isIndependent: target => target.independent, onTakeover: () => calls.push('takeover') });
  const emit = (type, props = {}) => {
    const event = new Event(type, { cancelable: true });
    for (const [key, value] of Object.entries({ pointerType: 'touch', pointerId: 1,
      clientX: 100, clientY: 100, target: graph, ...props })) Object.defineProperty(event, key, { value });
    root.dispatchEvent(event); return event;
  };
  return { root, graph, overlay, chart, camera, navigation, calls, emit };
}
test('graph taps select once and suppress the native compatibility click', () => {
  const f = fixture();
  assert.equal(f.emit('pointerdown').defaultPrevented, true);
  f.emit('pointerup'); assert.equal(f.calls.filter(call => call === 'tap').length, 1);
  assert.equal(f.emit('click').defaultPrevented, true);
  assert.equal(f.emit('click', { pointerType: 'mouse' }).defaultPrevented, false);
  assert.equal(f.root.captures.size, 0); f.navigation.destroy();
});
test('album dragging hands off immediately to pinch then remaining-finger pan', () => {
  const f = fixture(); f.camera.node = { index: 7 };
  f.emit('pointerdown'); f.emit('pointermove', { clientX: 110 });
  f.emit('pointerdown', { pointerId: 2, clientX: 210 });
  assert.equal(f.calls.filter(call => call === 'dragEnd').length, 1);
  f.emit('pointermove', { pointerId: 2, clientX: 310 }); assert.equal(f.camera.value.k, 2);
  f.emit('pointerup', { pointerId: 2 });
  const before = { ...f.camera.value };
  f.emit('pointermove', { clientX: 130 });
  assert.equal(f.camera.value.x, before.x + 20); assert.equal(f.camera.value.k, before.k);
  f.emit('pointerup'); assert.ok(!f.calls.includes('tap')); f.navigation.destroy();
});
test('normal drag release calls its completion exactly once', () => {
  const f = fixture(); f.camera.node = { index: 1 };
  f.emit('pointerdown'); f.emit('pointermove', { clientX: 120 }); f.emit('pointerup');
  assert.equal(f.calls.filter(call => call === 'dragEnd').length, 1); f.navigation.destroy();
});
test('overlay single touches pass through; multitouch forwards, then swallows leftovers', () => {
  const f = fixture();
  assert.equal(f.emit('pointerdown', { target: f.overlay }).defaultPrevented, false);
  f.overlay.setPointerCapture(1);
  f.emit('pointerdown', { pointerId: 2, clientX: 200, target: f.overlay });
  assert.equal(f.overlay.captures.size, 0);
  f.emit('pointermove', { pointerId: 2, clientX: 300, target: f.overlay });
  assert.equal(f.camera.value.k, 2);
  f.emit('pointerup', { pointerId: 2 });
  const before = { ...f.camera.value };
  assert.equal(f.emit('pointermove', { clientX: 150 }).defaultPrevented, true);
  assert.deepEqual(f.camera.value, before); f.emit('pointerup');
  assert.ok(!f.calls.includes('tap')); f.navigation.destroy();
});
test('pointer replacement rebases and cancellation clears all captures without a tap', () => {
  const f = fixture(); f.emit('pointerdown');
  f.emit('pointerdown', { pointerId: 2, clientX: 200 });
  f.emit('pointerdown', { pointerId: 3, clientX: 300 });
  f.emit('pointermove', { pointerId: 2, clientX: 250 });
  const before = { ...f.camera.value };
  f.emit('pointerup', { pointerId: 1 });
  f.emit('pointermove', { pointerId: 3, clientX: 300 }); assert.deepEqual(f.camera.value, before);
  f.emit('pointercancel', { pointerId: 2 });
  assert.equal(f.root.captures.size, 0); assert.equal(f.navigation.pointers.size, 0);
  assert.ok(!f.calls.includes('tap')); f.navigation.destroy();
});
test('Safari gestures and multitouch after native scroll cancellation are swallowed', () => {
  const f = fixture();
  assert.equal(f.emit('gesturestart', { target: f.overlay }).defaultPrevented, true);
  f.emit('pointerdown', { target: f.overlay }); f.emit('pointercancel', { target: f.overlay });
  assert.equal(f.emit('touchmove', { target: f.overlay, touches: [{}, {}] }).defaultPrevented, true);
  assert.equal(f.emit('touchend', { target: f.overlay, touches: [{}] }).defaultPrevented, true);
  f.emit('touchend', { target: f.overlay, touches: [] });
  assert.equal(f.emit('touchstart', { target: f.overlay, touches: [{}] }).defaultPrevented, false);
  assert.ok(!f.calls.includes('apply')); f.navigation.destroy();
});
test('mixed graph and overlay fingers share one camera gesture in either order', () => {
  for (const graphFirst of [true, false]) {
    const f = fixture();
    f.emit('pointerdown', { target: graphFirst ? f.graph : f.overlay });
    f.emit('pointerdown', { pointerId: 2, clientX: 200, target: graphFirst ? f.overlay : f.graph });
    f.emit('pointermove', { pointerId: 2, clientX: 300 });
    assert.equal(f.camera.value.k, 2); f.emit('pointerup', { pointerId: 2 }); f.emit('pointerup');
    assert.ok(!f.calls.includes('tap')); f.navigation.destroy();
  }
});
test('independent chart pinches pass through without graph takeover, including captured pointers and native gestures', () => {
  const f = fixture(), received = [];
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'touchstart', 'touchmove', 'touchend',
    'gesturestart', 'gesturechange', 'gestureend']) f.root.addEventListener(type, event => received.push(event.type));
  const pass = (type, props = {}) => {
    const before = received.length;
    assert.equal(f.emit(type, { target: f.chart, ...props }).defaultPrevented, false);
    assert.equal(received.length, before + 1, `${type} reaches the chart's gesture owner`);
  };
  pass('pointerdown'); pass('pointerdown', { pointerId: 2, clientX: 200 });
  const touches = [{ target: f.chart }, { target: f.chart }];
  pass('touchstart', { touches, changedTouches: touches });
  pass('pointermove', { pointerId: 2, clientX: 300, target: f.root });
  pass('touchmove', { touches, changedTouches: touches });
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) pass(type);
  f.emit('lostpointercapture', { pointerId: 2, target: f.root });
  assert.equal(f.navigation.independentPointers.has(2), true);
  pass('pointerup', { target: f.root }); pass('pointercancel', { pointerId: 2, target: f.graph });
  pass('touchend', { touches: [], changedTouches: touches });
  assert.equal(f.navigation.pointers.size, 0); assert.equal(f.navigation.independentPointers.size, 0);
  assert.equal(f.root.captures.size, 0); assert.deepEqual(f.calls, []); assert.ok(!f.navigation.touchBlocked);
  f.emit('pointerdown'); f.emit('pointerdown', { pointerId: 2, clientX: 200 });
  f.emit('pointermove', { pointerId: 2, clientX: 300 });
  assert.equal(f.camera.value.k, 2, 'the following graph pinch still owns the camera');
  f.emit('pointerup', { pointerId: 2 }); f.emit('pointerup'); f.navigation.destroy();
});
test('independent native touches do not prolong suppression after graph fingers end', () => {
  const f = fixture(), chartTouch = { target: f.chart }, graphTouch = { target: f.graph };
  f.emit('touchstart', { touches: [graphTouch, graphTouch], changedTouches: [graphTouch] });
  assert.equal(f.navigation.touchBlocked, true);
  f.emit('touchend', { touches: [chartTouch], changedTouches: [graphTouch] });
  assert.equal(f.navigation.touchBlocked, false);
  assert.equal(f.emit('touchend', { target: f.chart, touches: [], changedTouches: [chartTouch] }).defaultPrevented, false);
  assert.equal(f.emit('touchstart', { target: f.overlay, touches: [{ target: f.overlay }] }).defaultPrevented, false);
  f.navigation.destroy();
});
test('unexpected capture loss, resize, hiding and disposal finish dragging once', () => {
  for (const reason of ['lostpointercapture', 'resize', 'hidden', 'destroy']) {
    const f = fixture(); f.camera.node = { index: 1 };
    f.emit('pointerdown'); f.emit('pointermove', { clientX: 120 });
    if (reason === 'lostpointercapture') f.emit(reason, { target: f.root });
    else if (reason === 'resize') f.root.ownerDocument.defaultView.dispatchEvent(new Event('resize'));
    else if (reason === 'hidden') {
      f.root.ownerDocument.hidden = true; f.root.ownerDocument.dispatchEvent(new Event('visibilitychange'));
    } else f.navigation.destroy();
    assert.equal(f.calls.filter(call => call === 'dragEnd').length, 1);
    assert.equal(f.root.captures.size, 0); assert.equal(f.navigation.pointers.size, 0);
    f.navigation.destroy(); assert.ok(!f.calls.includes('tap'));
  }
});
