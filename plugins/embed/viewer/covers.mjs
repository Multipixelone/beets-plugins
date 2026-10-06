// Demand-driven, bounded CPU image cache. Cosmos owns the synchronized GPU sprites.
const MIB = 1024 * 1024;
export const SPRITE_SIZES = [32, 64, 96, 128, 192, 256];

// Match cosmos 3.4.2's pointSizePx shader, including its near-constant zoom mode.
export function drawnCoverPixels(size, { dpr = 1, zoom = 1, scale = 1,
  scaleOnZoom = false, maxPointPixels = 256 } = {}) {
  const zoomScale = scaleOnZoom ? zoom : Math.min(5, Math.max(1, zoom * 0.01));
  return Math.min(size * scale * dpr * zoomScale, maxPointPixels);
}

export function coverPolicy(pixels, { constrained = false, maxTextureSize = 4096 } = {}) {
  const spriteSize = SPRITE_SIZES.find(size => size >= pixels) ?? 256;
  const poolBytes = (constrained ? 8 : 16) * MIB;
  // Cosmos uses ceil(sqrt(count)) square cells, each as large as the largest image.
  const grid = Math.max(0, Math.min(Math.floor(Math.sqrt(poolBytes / (4 * spriteSize ** 2))),
    Math.floor(maxTextureSize / spriteSize)));
  const capacity = Math.min(constrained ? 128 : 256, grid ** 2);
  return { spriteSize, capacity, concurrency: constrained ? 2 : 4, poolBytes };
}

export function constrainedCovers({ width, coarsePointer = false, deviceMemory } = {}) {
  return width <= 700 || coarsePointer || (deviceMemory !== undefined && deviceMemory <= 4);
}

export class CoverLoader {
  constructor(loadImage, onChange, { capacity = 256, concurrency = 4, spriteSize = 128 } = {}) {
    this.loadImage = loadImage; this.onChange = onChange;
    this.capacity = capacity; this.concurrency = concurrency; this.spriteSize = spriteSize;
    this.images = new Map(); this.failed = new Set(); this.loading = new Map();
    this.wanted = []; this.destroyed = false;
  }
  setWanted(urls) {
    if (this.destroyed) return;
    this.wanted = [...new Set(urls)].slice(0, this.capacity);
    const wanted = new Set(this.wanted);
    for (const [url, controller] of this.loading) if (!wanted.has(url)) controller.abort();
    // Most recently requested entries go to the end of the Map (LRU).
    for (const url of this.wanted) {
      if (this.images.has(url)) {
        const image = this.images.get(url); this.images.delete(url); this.images.set(url, image);
      }
    }
    this.pump();
  }
  pump() {
    if (this.destroyed) return;
    for (const url of this.wanted) {
      if (this.loading.size >= this.concurrency) break;
      if (this.images.has(url) || this.failed.has(url) || this.loading.has(url)) continue;
      const controller = new AbortController(); this.loading.set(url, controller);
      Promise.resolve().then(() => this.loadImage(url, controller.signal, this.spriteSize)).then(image => {
        if (controller.signal.aborted || this.destroyed || !this.wanted.includes(url)) return;
        while (this.images.size >= this.capacity) {
          const evict = [...this.images.keys()].find(key => !this.wanted.includes(key)) ?? this.images.keys().next().value;
          this.images.delete(evict);
        }
        this.images.set(url, image); this.onChange();
      }).catch(() => {
        if (!controller.signal.aborted && !this.destroyed) { this.failed.add(url); this.onChange(); }
      }).finally(() => { this.loading.delete(url); this.pump(); });
    }
  }
  destroy() {
    this.destroyed = true;
    for (const controller of this.loading.values()) controller.abort();
    this.images.clear(); this.failed.clear(); this.wanted = [];
  }
}

export async function decodeCover(url, signal, size = 128) {
  if (!SPRITE_SIZES.includes(size)) throw new Error('Invalid sprite size');
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Cover HTTP ${response.status}`);
  const blob = await response.blob();
  if (blob.size > 1024 * 1024) throw new Error('Oversized thumbnail');
  if (signal.aborted) throw new Error('Cover cancelled');
  const image = await createImageBitmap(blob, { resizeWidth: size, resizeHeight: size, resizeQuality: 'high' });
  let canvas;
  try {
    if (signal.aborted) throw new Error('Cover cancelled');
    canvas = typeof OffscreenCanvas === 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(size, size);
    canvas.width = canvas.height = size;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, size, size);
    return context.getImageData(0, 0, size, size);
  } finally {
    image.close();
    if (canvas) canvas.width = canvas.height = 0;
  }
}
