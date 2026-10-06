// Cosmos does not reheat on drag and has no persistent alpha-target API.
export const DRAG_ALPHA = 0.8;
export const RELEASE_ALPHA = 0.6;
export function dragAlpha(current, releasing = false) {
  return Math.max(Number.isFinite(current) ? current : 0, releasing ? RELEASE_ALPHA : DRAG_ALPHA);
}
