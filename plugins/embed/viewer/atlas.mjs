// Cosmos 3.4.2 adapter: variable-size cells, bounded pixels and extruded gutters.
export const ATLAS_BYTES = 16 * 1024 * 1024;
export const GUTTER = 1;

export function atlasLayout(images, maxTextureSize = 16384, poolBytes = ATLAS_BYTES) {
  if (!images.length) return null;
  const cells = images.map((image, index) => ({ index,
    width: image.width + 2 * GUTTER, height: image.height + 2 * GUTTER }));
  if (cells.some(cell => !Number.isInteger(cell.width) || !Number.isInteger(cell.height) ||
      cell.width <= 2 || cell.height <= 2)) return null;
  cells.sort((a, b) => b.height - a.height || b.width - a.width || a.index - b.index);
  const limit = Math.min(maxTextureSize, Math.floor(Math.sqrt(poolBytes / 4)));
  const area = cells.reduce((sum, cell) => sum + cell.width * cell.height, 0);
  const minimum = Math.max(cells[0].height, ...cells.map(cell => cell.width), Math.ceil(Math.sqrt(area)));
  for (let side = minimum; side <= limit; side = Math.min(limit + 1, side + 8)) {
    let x = 0, y = 0, row = 0;
    const positions = new Array(images.length);
    for (const cell of cells) {
      if (x + cell.width > side) { y += row; x = 0; row = 0; }
      positions[cell.index] = [x + GUTTER, y + GUTTER];
      x += cell.width; row = Math.max(row, cell.height);
    }
    if (y + row <= side) return { side, positions, bytes: side * side * 4 };
    // Always try the exact device/budget boundary, even if the step misses it.
    if (side < limit && side + 8 > limit) side = limit - 8;
  }
  return null;
}

export function createAtlasDataFromImageData(images, maxTextureSize = 16384) {
  const layout = atlasLayout(images, maxTextureSize);
  if (!layout) return null;
  const atlasData = new Uint8Array(layout.bytes);
  const atlasCoordsSize = Math.ceil(Math.sqrt(images.length));
  const atlasCoords = new Float32Array(atlasCoordsSize ** 2 * 4).fill(-1);
  images.forEach((image, index) => {
    const [x, y] = layout.positions[index];
    atlasCoords.set([x / layout.side, y / layout.side,
      (x + image.width) / layout.side, (y + image.height) / layout.side], index * 4);
    for (let dy = -GUTTER; dy < image.height + GUTTER; dy++) {
      const sourceY = Math.max(0, Math.min(image.height - 1, dy));
      for (let dx = -GUTTER; dx < image.width + GUTTER; dx++) {
        const sourceX = Math.max(0, Math.min(image.width - 1, dx));
        const source = (sourceY * image.width + sourceX) * 4;
        atlasData.set(image.data.subarray(source, source + 4), ((y + dy) * layout.side + x + dx) * 4);
      }
    }
  });
  return { atlasData, atlasSize: layout.side, atlasCoords, atlasCoordsSize };
}
