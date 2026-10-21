interface Rect { x: number; y: number; width: number; height: number }

/** Fit the whole native sheet inside the work area, including its shadow margin. */
export function sheetBounds(area: Rect, size: { width: number; height: number }, margin: number, statusHeight: number): Rect {
  const width = Math.max(1, Math.min(Math.ceil(size.width + 2 * margin), area.width));
  const height = Math.max(1, Math.min(Math.ceil(size.height + 2 * margin), area.height));
  const x = Math.round(area.x + (area.width - width) / 2);
  const preferredY = Math.round(area.y + area.height + 12 - statusHeight - height + margin);
  const y = Math.max(area.y, Math.min(preferredY, area.y + area.height - height));
  return { x, y, width, height };
}
