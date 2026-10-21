/** Include painted shadow/antialias pixels, because native shape clips drawing too. */
export function pillPaintRect(r: { x: number; y: number; width: number; height: number }, shadow: string) {
  let left = 2,
    top = 2,
    right = 2,
    bottom = 2;
  for (const part of shadow.replace(/rgba?\([^)]*\)/g, '').split(',')) {
    if (part.includes('inset')) continue;
    const lengths = [...part.matchAll(/(-?[\d.]+)px/g)].map((m) => Number(m[1]));
    if (lengths.length < 2) continue;
    const [x, y, blur = 0, spread = 0] = lengths;
    // Chromium's blur support extends to three standard deviations (blur / 2).
    const reach = Math.max(0, blur * 1.5 + spread) + 2;
    left = Math.max(left, reach - x);
    right = Math.max(right, reach + x);
    top = Math.max(top, reach - y);
    bottom = Math.max(bottom, reach + y);
  }
  return { x: r.x - left, y: r.y - top, width: r.width + left + right, height: r.height + top + bottom };
}

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
