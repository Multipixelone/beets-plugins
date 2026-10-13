const TAP_DISTANCE = 6;
const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// All coordinates are CSS pixels, in the same frame as the camera transform.
export function pinchTransform(transform, before, after, limits) {
  const startDistance = distance(...before), endDistance = distance(...after);
  if (!(startDistance > 0 && endDistance > 0 && transform.k > 0) ||
      ![startDistance, endDistance, transform.x, transform.y, transform.k].every(Number.isFinite)) return { ...transform };
  const start = midpoint(...before), end = midpoint(...after);
  const k = Math.max(limits[0], Math.min(limits[1], transform.k * endDistance / startDistance));
  return { k, x: end[0] - (start[0] - transform.x) * k / transform.k,
    y: end[1] - (start[1] - transform.y) * k / transform.k };
}

// Cosmos 3.4.2 adapter. Keep its GPU picking, point dragging and camera callback
// paths, but give touch input one owner instead of competing D3 touch handlers.
export function graphTouchCamera(graph, onInteract) {
  const selection = graph.canvasD3Selection, zoom = graph.zoomInstance;
  graph.dragInstance.behavior.touchable(() => false);
  zoom.behavior.touchable(() => false);
  selection.on('touchstart.drag touchmove.drag touchend.drag touchcancel.drag ' +
    'touchstart.zoom touchmove.zoom touchend.zoom touchcancel.zoom', null);
  const local = point => {
    const rect = graph.canvas.getBoundingClientRect();
    return [point[0] - rect.left, point[1] - rect.top];
  };
  const position = point => {
    const [offsetX, offsetY] = local(point);
    graph.updateMousePosition({ offsetX, offsetY });
  };
  return {
    local, limits: () => zoom.behavior.scaleExtent(),
    transform: () => ({ x: zoom.eventTransform.x, y: zoom.eventTransform.y, k: zoom.eventTransform.k }),
    interrupt() { selection.interrupt(); graph.cancelLongPress(); onInteract(); },
    apply({ x, y, k }, event) {
      const current = zoom.eventTransform;
      const next = current.translate((x - current.x) / current.k, (y - current.y) / current.k).scale(k / current.k);
      selection.call(zoom.behavior.transform, next, undefined, event);
    },
    pick(point) { position(point); graph.findHoveredItem(true); return graph.store.hoveredPoint; },
    tap(point, event) {
      const node = this.pick(point);
      if (node) graph.config.onPointClick?.(node.index, node.position, event);
    },
    startDrag(node, point, event) {
      position(point); graph.store.hoveredPoint = node;
      graph.store.draggingPointIndex = node.index; graph.dragInstance.isActive = true;
      graph.config.onDragStart?.({ sourceEvent: event }); graph.requestRender();
    },
    drag(node, point, event) {
      position(point); graph.store.hoveredPoint = node;
      const [x, y] = local(point);
      graph.config.onDrag?.({ x, y, sourceEvent: event }); graph.requestRender();
    },
    endDrag(event) {
      // Commit the last pointer movement before the drag callback reads positions.
      graph.renderFrame(); graph.dragInstance.isActive = false;
      graph.store.draggingPointIndex = undefined;
      graph.config.onDragEnd?.({ sourceEvent: event }); graph.requestRender();
    }
  };
}

export class TouchNavigation {
  constructor(root, { camera, isGraph, isIndependent = () => false, onTakeover = () => {} }) {
    this.root = root; this.camera = camera; this.isGraph = isGraph; this.isIndependent = isIndependent; this.onTakeover = onTakeover;
    this.pointers = new Map(); this.independentPointers = new Set(); this.suppressedClicks = new Map(); this.listeners = [];
    const listen = (target, type, handler, options = { capture: true, passive: false }) => {
      target.addEventListener(type, handler, options);
      this.listeners.push(() => target.removeEventListener(type, handler, options));
    };
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
      listen(root, type, event => this.pointer(event));
    }
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) listen(root, type, event => {
      const independent = touch => this.isIndependent(touch.target ?? event.target);
      const touches = [...event.touches], changed = [...(event.changedTouches ?? [])];
      if ([...touches, ...changed].every(independent) &&
          (touches.length || changed.length || this.isIndependent(event.target))) return;
      // A chart finger must not turn an otherwise single graph finger into a
      // graph pinch, or keep graph suppression alive after its fingers lift.
      const graphTouches = touches.filter(touch => !independent(touch));
      if (graphTouches.length > 1) {
        if (!this.touchBlocked && !this.claimed) this.onTakeover();
        this.touchBlocked = true;
      }
      if (this.touchBlocked || this.isGraph(event.target)) this.consume(event);
      if (!graphTouches.length) this.touchBlocked = false;
    });
    // Safari's gesture events can target chrome rather than the canvas. Only
    // cancel the browser gesture here; Pointer Events drive the camera once.
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) listen(root, type, event => {
      if (!this.isIndependent(event.target)) this.consume(event);
    });
    listen(root, 'click', event => {
      if (this.isIndependent(event.target)) return;
      const now = Date.now();
      for (const [id, record] of this.suppressedClicks) if (record.until < now) this.suppressedClicks.delete(id);
      if ((event.pointerType === 'touch' && this.suppressedClicks.has(event.pointerId)) ||
          (event.sourceCapabilities?.firesTouchEvents && [...this.suppressedClicks.values()].some(record =>
            record.target.contains(event.target)))) this.consume(event);
    });
    listen(root.ownerDocument, 'visibilitychange', () => {
      if (root.ownerDocument.hidden) this.reset();
    });
    listen(root.ownerDocument.defaultView, 'resize', () => this.reset());
  }
  consume(event) { if (event.cancelable) event.preventDefault(); event.stopImmediatePropagation(); }
  suppress(id, pointer) {
    const now = Date.now();
    // Drags may never emit a click: expire records even in a long pan session.
    for (const [pointerId, record] of this.suppressedClicks) if (record.until < now) this.suppressedClicks.delete(pointerId);
    this.suppressedClicks.set(id, { target: pointer.target, until: now + 700 });
  }
  capture(id) {
    // Pointer cancellation during native scrolling can precede capture.
    try { this.root.setPointerCapture(id); } catch (error) { if (error.name !== 'NotFoundError') throw error; }
  }
  rebase() {
    this.pair = [...this.pointers.keys()].slice(0, 2);
    this.before = this.pair.map(id => this.activeCamera.local(this.pointers.get(id).point));
    this.base = this.activeCamera.transform();
  }
  pointer(event) {
    if (event.pointerType !== 'touch') return;
    const id = event.pointerId;
    if (event.type === 'pointerdown') {
      this.suppressedClicks.delete(id);
      this.independentPointers.delete(id);
      if (this.isIndependent(event.target)) { this.independentPointers.add(id); return; }
      const point = [event.clientX, event.clientY], pointer = { point, target: event.target };
      if (!this.pointers.size) {
        this.activeCamera = this.camera(); this.originGraph = this.isGraph(event.target);
        this.mode = this.touchBlocked ? 'swallow' : 'pending';
        this.claimed = this.originGraph || this.touchBlocked; this.start = point;
        this.node = this.originGraph ? this.activeCamera?.pick(point) : undefined;
        if (this.originGraph) this.activeCamera?.interrupt();
      }
      this.pointers.set(id, pointer);
      if (this.pointers.size === 2) {
        const canForward = this.activeCamera && (this.claimed || !this.touchBlocked);
        if (this.mode === 'drag') this.activeCamera.endDrag(event);
        this.onTakeover(); this.claimed = true; this.node = undefined;
        // Take captures away from scrubbers/range controls without changing
        // their completed single-finger updates.
        for (const [pointerId, entry] of this.pointers) {
          if (entry.target !== this.root && entry.target.hasPointerCapture(pointerId)) entry.target.releasePointerCapture(pointerId);
          this.capture(pointerId); this.suppress(pointerId, entry);
        }
        this.mode = canForward ? 'pinch' : 'swallow';
        this.activeCamera?.interrupt();
        if (this.mode === 'pinch') this.rebase();
      }
      if (this.claimed) { this.capture(id); this.consume(event); }
      return;
    }
    if (this.independentPointers.has(id)) {
      if (event.type === 'pointerup' || event.type === 'pointercancel') this.independentPointers.delete(id);
      return;
    }
    const pointer = this.pointers.get(id);
    if (!pointer) return;
    if (event.type === 'lostpointercapture' && event.target !== this.root) return;
    if (this.claimed) this.consume(event);
    if (event.type === 'pointercancel' || event.type === 'lostpointercapture') { this.reset(event); return; }
    if (event.type === 'pointermove') {
      const previous = pointer.point; pointer.point = [event.clientX, event.clientY];
      if (!this.claimed || !this.activeCamera) return;
      if (this.mode === 'pending' && distance(this.start, pointer.point) >= TAP_DISTANCE) {
        this.mode = this.node ? 'drag' : 'pan';
        if (this.node) this.activeCamera.startDrag(this.node, pointer.point, event);
      }
      if (this.mode === 'pinch') {
        const after = this.pair.map(pointerId => this.activeCamera.local(this.pointers.get(pointerId).point));
        this.activeCamera.apply(pinchTransform(this.base, this.before, after, this.activeCamera.limits()), event);
      } else if (this.mode === 'drag') this.activeCamera.drag(this.node, pointer.point, event);
      else if (this.mode === 'pan') {
        const transform = this.activeCamera.transform();
        // Include threshold movement on the first pan frame.
        const from = this.start ?? previous; this.start = undefined;
        this.activeCamera.apply({ ...transform, x: transform.x + pointer.point[0] - from[0],
          y: transform.y + pointer.point[1] - from[1] }, event);
      }
      return;
    }
    if (event.type !== 'pointerup') return;
    if (this.claimed) this.suppress(id, pointer);
    if (this.mode === 'pending' && this.originGraph) this.activeCamera?.tap(pointer.point, event);
    if (this.mode === 'drag') { this.activeCamera.endDrag(event); this.mode = 'swallow'; }
    this.pointers.delete(id);
    if (this.root.hasPointerCapture(id)) this.root.releasePointerCapture(id);
    if (!this.pointers.size) this.reset();
    else if (this.mode === 'pinch') {
      if (this.pointers.size >= 2) this.rebase();
      else { this.mode = this.originGraph ? 'pan' : 'swallow'; this.start = [...this.pointers.values()][0].point; }
    }
  }
  reset(event) {
    if (this.mode === 'drag') this.activeCamera?.endDrag(event);
    const pointers = [...this.pointers]; this.pointers.clear();
    for (const [id, pointer] of pointers) {
      if (this.claimed) this.suppress(id, pointer);
      if (this.root.hasPointerCapture(id)) this.root.releasePointerCapture(id);
    }
    this.mode = undefined; this.claimed = false; this.node = undefined; this.activeCamera = undefined;
  }
  destroy() { this.reset(); this.independentPointers.clear(); for (const remove of this.listeners) remove(); this.listeners = []; }
}
