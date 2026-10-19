// libuiohook scan codes are platform-independent, but are NOT Windows virtual-key codes. Keep this
// translation at the hook seam so settings and the shared hotkey state machine stay portable.
const CODES: Record<number, number> = {
  29: 0xa2, 3613: 0xa3, 56: 0xa4, 3640: 0xa5,
  42: 0xa0, 54: 0xa1, 3675: 0x5b, 3676: 0x5c,
  1: 0x1b, 14: 0x08, 15: 0x09, 28: 0x0d, 57: 0x20, 58: 0x14,
  3657: 0x21, 3665: 0x22, 3663: 0x23, 3655: 0x24,
  57419: 0x25, 57416: 0x26, 57421: 0x27, 57424: 0x28,
  3666: 0x2d, 3667: 0x2e, 3639: 0x2c, 69: 0x90, 70: 0x91,
  39: 0xba, 13: 0xbb, 51: 0xbc, 12: 0xbd, 52: 0xbe, 53: 0xbf,
  41: 0xc0, 26: 0xdb, 43: 0xdc, 27: 0xdd, 40: 0xde,
  55: 0x6a, 78: 0x6b, 74: 0x6d, 83: 0x6e, 3637: 0x6f,
};

for (const [scans, first] of [
  [[11, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0x30],
  [[30, 48, 46, 32, 18, 33, 34, 35, 23, 36, 37, 38, 50, 49, 24, 25, 16, 19, 31, 20, 22, 47, 17, 45, 21, 44], 0x41],
  [[82, 79, 80, 81, 75, 76, 77, 71, 72, 73], 0x60],
  [[59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 87, 88, 91, 92, 93, 99, 100, 101, 102, 103, 104, 105, 106, 107], 0x70],
] as const) scans.forEach((scan, i) => { CODES[scan] = first + i; });

export function canonicalKeyCode(scan: number): number | null {
  return CODES[scan] ?? null;
}
