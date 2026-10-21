import { expect, it } from 'vitest';
import { sheetBounds } from '../src/core/sheetbounds';

it('keeps complete sheets reachable on small, scaled, and offset work areas', () => {
  for (const area of [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 0, y: 0, width: 800, height: 600 },
    { x: -600, y: 20, width: 600, height: 560 },
    { x: 1200, y: -400, width: 360, height: 320 },
  ]) {
    const bounds = sheetBounds(area, { width: 760, height: 520 }, 12, 76);
    expect(bounds.x).toBeGreaterThanOrEqual(area.x);
    expect(bounds.y).toBeGreaterThanOrEqual(area.y);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(area.x + area.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(area.y + area.height);
  }
});

it('retains the usual position above the passive pill when space is available', () => {
  expect(sheetBounds({ x: 0, y: 0, width: 1920, height: 1080 }, { width: 480, height: 240 }, 12, 76)).toEqual({ x: 708, y: 764, width: 504, height: 264 });
});
