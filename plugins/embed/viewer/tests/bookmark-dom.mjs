// Minimal event/DOM harness; real CSS layout and native input are agent 2's browser checks.
class Surface {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, callback, options) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ callback, capture: options === true || options?.capture === true });
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, callback) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(listener => listener.callback !== callback));
  }
  emit(type, properties = {}) {
    const event = { type, target: this, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...properties };
    const path = [this];
    for (let parent = this.parentNode; parent; parent = parent.parentNode) path.push(parent);
    for (const capture of [true, false]) {
      for (const node of capture ? [...path].reverse() : path) {
        for (const listener of [...(node.listeners.get(type) ?? [])]) {
          if (listener.capture === capture) listener.callback(event);
        }
        if (event.stopped) return event;
      }
    }
    return event;
  }
}
class Element extends Surface {
  constructor(tagName, ownerDocument) {
    super(); this.tagName = tagName; this.ownerDocument = ownerDocument;
    this.children = []; this.attributes = new Map(); this.hidden = false; this.content = '';
    this.style = { setProperty(name, value) { this[name] = value; }, getPropertyValue(name) { return this[name]; } };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  set textContent(value) { this.replaceChildren(); this.content = String(value); }
  get textContent() { return this.content + this.children.map(child => child.textContent).join(''); }
  append(...children) {
    for (const child of children) { child.remove(); child.parentNode = this; this.children.push(child); }
  }
  insertBefore(child, reference) {
    child.remove(); child.parentNode = this;
    this.children.splice(this.children.indexOf(reference), 0, child);
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = []; this.content = ''; this.append(...children);
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  contains(target) { return this === target || this.children.some(child => child.contains(target)); }
  focus() {
    const document = this.ownerDocument, previous = document.activeElement;
    if (previous === this) return;
    document.activeElement = this;
    previous?.emit('blur', { relatedTarget: this });
    this.emit('focus', { relatedTarget: previous }); this.emit('focusin', { relatedTarget: previous });
  }
  scrollIntoView() { this.scrolled = true; }
  getBoundingClientRect() {
    if (this.rect) return this.rect;
    const fixed = this.className?.includes('ag-bookmark-tooltip') || this.className?.includes('ag-bookmark-list');
    const parent = fixed ? { left: 0, top: 0 } : this.parentNode?.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    const width = parseFloat(this.style.width) || (this.tagName === 'button' ? 44 : 320);
    const height = parseFloat(this.style.height) || (this.tagName === 'button' ? 44 :
      Math.ceil(this.textContent.length / Math.max(1, (width - 16) / 6)) * 16 + 16);
    const left = parent.left + (parseFloat(this.style.left) || 0), top = parent.top + (parseFloat(this.style.top) || 0);
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
}
export function bookmarkDocument() {
  const document = new Surface(), view = new Surface();
  view.innerWidth = 390; view.innerHeight = 800;
  document.defaultView = view;
  document.createElement = tag => new Element(tag, document);
  document.createElementNS = (namespace, tag) => new Element(tag, document);
  document.body = document.createElement('body'); document.body.parentNode = document;
  const container = document.createElement('div'), overlays = document.createElement('div');
  document.body.append(container, overlays);
  container.rect = { left: 0, top: 600, width: 390, height: 88, right: 390, bottom: 688 };
  return { document, view, container, overlays };
}
export function descendants(root, predicate) {
  return root.children.flatMap(child => [...(predicate(child) ? [child] : []), ...descendants(child, predicate)]);
}
export const withClass = (root, className) => descendants(root, node =>
  node.className?.split(' ').includes(className) || node.getAttribute('class')?.split(' ').includes(className));
