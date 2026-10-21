/** Native window regions use integer DIPs and must stay within the pill. */
export function pillRegion(value: unknown): { x: number; y: number; width: number; height: number }[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).flatMap((r) => {
    if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0) return [];
    const x = Math.max(0, Math.floor(r.x));
    const y = Math.max(0, Math.floor(r.y));
    const right = Math.min(600, Math.ceil(r.x + r.width));
    const bottom = Math.min(420, Math.ceil(r.y + r.height));
    return right > x && bottom > y ? [{ x, y, width: right - x, height: bottom - y }] : [];
  });
}
