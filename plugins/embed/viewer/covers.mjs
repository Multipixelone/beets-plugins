import { ATLAS_BYTES, GUTTER, atlasLayout } from './atlas.mjs';
const MIB = 1024 * 1024;
export const SPRITE_SIZES = [32, 64, 96, 128, 192, 256, 512];
export const MIP_SIZES = [32, 64, 128, 256, 512];
const BASE_SIZES = [32, 24, 16, 12, 8, 4, 2, 1];

// Match the patched quad renderer's device-pixel geometry. Resolution is
// bounded by mipTier/the atlas budget; it must not cap the visible geometry.
export function drawnCoverPixels(size, { dpr = 1, zoom = 1, scale = 1,
  scaleOnZoom = false } = {}) {
  const zoomScale = scaleOnZoom ? zoom : Math.min(5, Math.max(1, zoom * 0.01));
  return size * scale * dpr * zoomScale;
}
export function coverPolicy(pixels, { constrained = false, maxTextureSize = 4096,
  poolBytes = ATLAS_BYTES, count = 0 } = {}) {
  const spriteSize = MIP_SIZES.find(size => size >= pixels) ?? MIP_SIZES.at(-1);
  const side = Math.min(maxTextureSize, Math.floor(Math.sqrt(poolBytes / 4)));
  const capacity = Math.floor(side / (spriteSize + 2 * GUTTER)) ** 2;
  const baseSize = BASE_SIZES.find(size =>
    (Math.ceil(Math.sqrt(count)) * (size + 2 * GUTTER)) ** 2 * 4 <= poolBytes / 2 &&
    Math.ceil(Math.sqrt(count)) * (size + 2 * GUTTER) <= maxTextureSize);
  if (baseSize === undefined) throw new Error('Too many covers for this device texture budget');
  return { spriteSize, baseSize, capacity, concurrency: constrained ? 2 : 4,
    poolBytes, maxTextureSize };
}
export function mipTier(pixels, previous = 32) {
  if (pixels > previous * 1.2) return MIP_SIZES.find(size => size >= pixels) ?? MIP_SIZES.at(-1);
  const lower = [...MIP_SIZES].reverse().find(size => size < previous);
  if (lower && pixels < lower * 0.8) return MIP_SIZES.find(size => size >= pixels) ?? MIP_SIZES.at(-1);
  return previous;
}
export function constrainedCovers({ width, coarsePointer = false, deviceMemory } = {}) {
  return width <= 700 || coarsePointer || (deviceMemory !== undefined && deviceMemory <= 4);
}
export function coverPriority(albums, visible, positions, sizes, center, priority = []) {
  const preferred = new Map(priority.filter(Number.isInteger).map((index, order) => [index, order]));
  const maxSize = Math.max(1, ...visible.map(i => sizes[i]));
  const maxPlays = Math.max(1, ...visible.map(i => Math.log1p(albums[i].summed_plays)));
  const radius = Math.max(1, ...visible.map(i => Math.hypot(positions[i * 2] - center[0], positions[i * 2 + 1] - center[1])));
  const score = i => .6 * (1 - Math.hypot(positions[i * 2] - center[0], positions[i * 2 + 1] - center[1]) / radius) +
    .3 * sizes[i] / maxSize + .1 * Math.log1p(albums[i].summed_plays) / maxPlays;
  return [...visible].sort((a, b) => (preferred.get(a) ?? Infinity) - (preferred.get(b) ?? Infinity) ||
    score(b) - score(a) || albums[a].id - albums[b].id);
}

// Base icons stay resident. Detailed tiers have a separate byte-bounded LRU.
export class CoverLoader {
  constructor(loadImage, onChange, { baseSize = 16, poolBytes = ATLAS_BYTES, concurrency = 4,
    baseRequests = [], deferredBase = [] } = {}) {
    Object.assign(this, { loadImage, onChange, baseSize, poolBytes, concurrency, baseRequests });
    this.base = new Map(); this.details = new Map(); this.failed = new Set(); this.loading = new Map();
    this.deferredBase = new Set(deferredBase); this.wanted = []; this.baseBytes = this.detailBytes = 0;
    this.destroyed = false;
  }
  setBase(key, image) {
    if (this.destroyed || this.base.has(key) || (this.allowedKeys && !this.allowedKeys.has(key))) return;
    if (image.width !== this.baseSize || image.height !== this.baseSize ||
        this.baseBytes + image.data.byteLength > this.poolBytes / 2) throw new Error('Base cover budget exceeded');
    this.base.set(key, image); this.baseBytes += image.data.byteLength; this.onChange();
  }
  releaseDeferred(keys) {
    for (const key of keys) this.deferredBase.delete(key);
    this.pump();
  }
  setWanted(requests) {
    if (this.destroyed) return;
    const seen = new Set();
    this.wanted = requests.filter(request => !seen.has(request.key) && seen.add(request.key));
    const wanted = new Set(this.wanted.map(request => `${request.key}\n${request.tier}`));
    for (const [id, controller] of this.loading) if (controller.detail && !wanted.has(id)) controller.abort();
    for (const request of requests) {
      const id = `${request.key}\n${request.tier}`, cached = this.details.get(id);
      if (cached) { this.details.delete(id); this.details.set(id, cached); }
    }
    this.pump();
  }
  pump() {
    if (this.destroyed) return;
    const bases = [...this.wanted, ...this.baseRequests].filter(request => !this.base.has(request.key) &&
      !this.deferredBase.has(request.key) && (!this.allowedKeys || this.allowedKeys.has(request.key)))
      .map(request => ({ ...request, tier: this.baseSize, url: request.baseURL }));
    // Visible base icons first, then visible detail, then background base files.
    const queue = [...bases.slice(0, this.wanted.length), ...this.wanted, ...bases];
    const requested = new Set(this.wanted.map(request => `${request.key}\n${request.tier}`));
    let detailDemand = 0;
    const affordable = new Set();
    for (const request of this.wanted) {
      if (request.tier <= this.baseSize) continue;
      const bytes = request.tier ** 2 * 4;
      if (detailDemand + bytes <= this.poolBytes / 2) {
        affordable.add(`${request.key}\n${request.tier}`); detailDemand += bytes;
      }
    }
    for (const request of queue) {
      if (this.loading.size >= this.concurrency) break;
      const detail = request.tier > this.baseSize, id = `${request.key}\n${request.tier}`;
      if (!detail && this.deferredBase.has(request.key)) continue;
      if (detail ? !affordable.has(id) || (this.best(request.key)?.width ?? 0) >= request.tier : this.base.has(request.key)) continue;
      if (this.failed.has(id) || this.loading.has(id)) continue;
      const controller = new AbortController(); controller.detail = detail; controller.key = request.key;
      this.loading.set(id, controller);
      Promise.resolve().then(async () => {
        try { return await this.loadImage(request.url, controller.signal, request.tier); }
        catch (error) {
          if (detail || controller.signal.aborted || request.url === request.key) throw error;
          return this.loadImage(request.key, controller.signal, request.tier);
        }
      }).then(image => {
        if (this.destroyed || controller.signal.aborted || (detail && !requested.has(id))) return;
        if (!detail) this.setBase(request.key, image);
        else {
          const bytes = image.data.byteLength;
          while (this.detailBytes + bytes > this.poolBytes / 2 && this.details.size) {
            const evict = [...this.details.keys()].find(key => !affordable.has(key)) ?? this.details.keys().next().value;
            this.detailBytes -= this.details.get(evict).image.data.byteLength; this.details.delete(evict);
          }
          if (bytes <= this.poolBytes / 2) {
            this.details.set(id, { key: request.key, tier: request.tier, image }); this.detailBytes += bytes;
            this.onChange();
          }
        }
      }).catch(() => {
        if (!this.destroyed && !controller.signal.aborted) { this.failed.add(id); this.onChange(); }
      }).finally(() => { this.loading.delete(id); this.pump(); });
    }
  }
  best(key, tier = MIP_SIZES.at(-1)) {
    let image = this.base.get(key), bestTier = image ? this.baseSize : 0;
    for (const entry of this.details.values()) if (entry.key === key && entry.tier <= tier && entry.tier > bestTier) {
      image = entry.image; bestTier = entry.tier;
    }
    // A loaded larger mip also satisfies demand; never re-decode a lower tier.
    for (const entry of this.details.values()) if (entry.key === key && entry.tier > bestTier) {
      image = entry.image; bestTier = entry.tier;
    }
    return image;
  }
  dropHidden(visibleKeys) {
    this.allowedKeys = visibleKeys;
    this.wanted = this.wanted.filter(request => visibleKeys.has(request.key));
    for (const controller of this.loading.values()) if (!visibleKeys.has(controller.key)) controller.abort();
    for (const [id, entry] of this.details) if (!visibleKeys.has(entry.key)) {
      this.detailBytes -= entry.image.data.byteLength; this.details.delete(id);
    }
  }
  atlasEntries(keys, requests, maxTextureSize = 4096) {
    const chosen = new Map(keys.filter(key => this.base.has(key)).map(key => [key, this.base.get(key)]));
    for (const request of requests) {
      const image = this.best(request.key, request.tier);
      if (image) chosen.set(request.key, image);
    }
    const entries = () => [...chosen].sort(([a], [b]) => a.localeCompare(b));
    let result = entries();
    // The controller and renderer use the same packer; low-priority detail gives way to base.
    for (const request of [...requests].reverse()) {
      if (atlasLayout(result.map(([, image]) => image), maxTextureSize, this.poolBytes)) break;
      const base = this.base.get(request.key);
      if (base) chosen.set(request.key, base); else chosen.delete(request.key);
      result = entries();
    }
    return result;
  }
  destroy() {
    this.destroyed = true;
    for (const controller of this.loading.values()) controller.abort();
    this.base.clear(); this.details.clear(); this.failed.clear(); this.wanted = [];
  }
}

export async function decodeCover(url, signal, size = 128) {
  if (![...SPRITE_SIZES, ...BASE_SIZES].includes(size)) throw new Error('Invalid sprite size');
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Cover HTTP ${response.status}`);
  const blob = await response.blob();
  if (blob.size > MIB) throw new Error('Oversized thumbnail');
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
    image.close(); if (canvas) canvas.width = canvas.height = 0;
  }
}

export async function decodeOverview(url, sheet, signal, size, onTile) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Cover sheet HTTP ${response.status}`);
  const blob = await response.blob();
  if (blob.size > 8 * MIB) throw new Error('Oversized cover sheet');
  const image = await createImageBitmap(blob);
  let canvas;
  try {
    const rows = Math.ceil(sheet.album_ids.length / sheet.columns);
    if (signal.aborted || image.width !== sheet.columns * 32 || image.height !== rows * 32) {
      throw new Error('Invalid cover sheet dimensions or cancelled');
    }
    canvas = typeof OffscreenCanvas === 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(1, 1);
    canvas.width = sheet.columns * size; canvas.height = rows * size;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    sheet.album_ids.forEach((id, index) => onTile(id,
      context.getImageData(index % sheet.columns * size, Math.floor(index / sheet.columns) * size, size, size)));
  } finally {
    image.close(); if (canvas) canvas.width = canvas.height = 0;
  }
}
