// Tray icons drawn at runtime: a microphone glyph whose colour and badge show the state. No asset files.
import { nativeImage } from 'electron';

export type TrayState = 'idle' | 'recording' | 'processing' | 'error' | 'loading';

const COLORS: Record<TrayState, [number, number, number]> = {
  idle: [235, 235, 235],
  loading: [150, 150, 150],
  recording: [255, 92, 92],
  processing: [96, 205, 255],
  error: [255, 170, 60],
};

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Coverage of the mic glyph at (x, y) in a unit square, with a 1-pixel antialiasing ramp of width `aa`. */
function micCoverage(x: number, y: number, aa: number, state: TrayState): number {
  // capsule head
  const head = segDist(x, y, 0.5, 0.28, 0.5, 0.5) - 0.15;
  // U-shaped holder: ring of radius 0.27 around (0.5, 0.5), lower half only
  const r = Math.hypot(x - 0.5, y - 0.5);
  const ring = y >= 0.5 ? Math.abs(r - 0.26) - 0.045 : Math.min(segDist(x, y, 0.24, 0.42, 0.24, 0.5), segDist(x, y, 0.76, 0.42, 0.76, 0.5)) - 0.045;
  const stem = segDist(x, y, 0.5, 0.76, 0.5, 0.88) - 0.045;
  const base = segDist(x, y, 0.36, 0.9, 0.64, 0.9) - 0.045;
  let d = Math.min(head, ring, stem, base);
  if (state === 'recording') d = Math.min(d, Math.hypot(x - 0.84, y - 0.16) - 0.14);
  return Math.max(0, Math.min(1, 0.5 - d / aa));
}

function render(size: number, state: TrayState): Buffer {
  const buf = Buffer.alloc(size * size * 4);
  const [r, g, b] = COLORS[state];
  const aa = 1.2 / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // 2x2 supersampling
      let c = 0;
      for (const [ox, oy] of [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.25, 0.75],
        [0.75, 0.75],
      ]) {
        c += micCoverage((px + ox) / size, (py + oy) / size, aa, state);
      }
      c /= 4;
      const i = (py * size + px) * 4;
      // BGRA, premultiplied
      buf[i] = Math.round(b * c);
      buf[i + 1] = Math.round(g * c);
      buf[i + 2] = Math.round(r * c);
      buf[i + 3] = Math.round(255 * c);
    }
  }
  return buf;
}

const cache = new Map<TrayState, Electron.NativeImage>();

export function trayIcon(state: TrayState): Electron.NativeImage {
  const hit = cache.get(state);
  if (hit) return hit;
  const img = nativeImage.createEmpty();
  for (const [scale, size] of [
    [1, 16],
    [1.25, 20],
    [1.5, 24],
    [2, 32],
  ] as const) {
    img.addRepresentation({ scaleFactor: scale, width: size, height: size, buffer: render(size, state) });
  }
  cache.set(state, img);
  return img;
}

/** A larger icon for windows and the taskbar. */
export function appIcon(): Electron.NativeImage {
  const img = nativeImage.createEmpty();
  img.addRepresentation({ scaleFactor: 1, width: 64, height: 64, buffer: render(64, 'processing') });
  return img;
}
