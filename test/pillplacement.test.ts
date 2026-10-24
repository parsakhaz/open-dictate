import { beforeEach, expect, it, vi } from 'vitest';

const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
vi.mock('electron', () => ({
  app: { getAppPath: () => '' },
  BrowserWindow: vi.fn(),
  screen: { getCursorScreenPoint: () => ({ x: 10, y: 10 }), getDisplayNearestPoint: () => ({ workArea }) },
}));
vi.mock('../src/main/icons', () => ({ appIcon: vi.fn() }));
import type { BrowserWindow } from 'electron';
import { placePill, placeSheet, setPillPosition } from '../src/main/windows';

const setBounds = vi.fn();
const win = { setBounds } as unknown as BrowserWindow;
beforeEach(() => setBounds.mockClear());

it('keeps the 600 x 420 pill window at the bottom centre of the work area by default', () => {
  setPillPosition('bottom-center');
  placePill(win);
  expect(setBounds).toHaveBeenCalledWith({ x: 660, y: 632, width: 600, height: 420 });
});

it('puts the pill window in the top right corner of the work area', () => {
  setPillPosition('top-right');
  placePill(win);
  expect(setBounds).toHaveBeenCalledWith({ x: 1320, y: -12, width: 600, height: 420 });
});

it('opens the sheet below the pill at the top, centred', () => {
  setPillPosition('top-center');
  placeSheet(win, { width: 480, height: 240 });
  // The pill and its hint end 64 px below the work area's top; the 12 px shadow margin overlaps that.
  expect(setBounds).toHaveBeenCalledWith({ x: 708, y: 52, width: 504, height: 264 });
});

it('opens the sheet above the pill at the bottom right, its right edge in line with the cards', () => {
  setPillPosition('bottom-right');
  placeSheet(win, { width: 480, height: 240 });
  // The cards end 24 px from the work area's right edge, at 1896; the window adds its 12 px margin.
  expect(setBounds).toHaveBeenCalledWith({ x: 1404, y: 724, width: 504, height: 264 });
});
