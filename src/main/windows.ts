// Transparent native surfaces accept ordinary input. The pill and Windows picker
// appear without activation; clicking their controls may focus them. Sheets focus on request.
import path from 'node:path';
import { app, BrowserWindow, screen } from 'electron';
import type { PillPosition } from '../core/types';
import { appIcon } from './icons';

const renderer = (file: string) => path.join(app.getAppPath(), 'out', 'renderer', file);
const preload = () => path.join(app.getAppPath(), 'out', 'main', 'preload.js');

export const PILL_W = 600;
/** Original transparent bounds, tall enough for an expanded card above the pill. */
export const PILL_H = 420;

export function createPill(): BrowserWindow {
  const w = new BrowserWindow({
    width: PILL_W,
    height: PILL_H,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: true,
    hasShadow: false,
    alwaysOnTop: true,
    title: 'dictate',
    webPreferences: { preload: preload(), backgroundThrottling: false, contextIsolation: true, sandbox: false },
  });
  w.setAlwaysOnTop(true, 'screen-saver');
  // The real transparent surface owns native input continuously. Alpha-zero desktop
  // margins stay visually empty; input ownership never depends on hover or a relay.
  void w.loadFile(renderer('pill.html'));
  return w;
}

/** The cards' and pill's distance from the window's side edges (pill.css #root padding). */
const PILL_SIDE = 24;
/** The window overhangs the work area's edge by this much, so the pill sits 20 px in from it. */
const PILL_OVERHANG = 12;

let position: PillPosition = 'bottom-center';
/** Where the pill, and the sheet that opens from it, are placed from now on. */
export function setPillPosition(p: PillPosition): void {
  position = p;
}

/** The left edge of a window `width` wide, at the chosen side of the work area: its content in line with the pill's. */
function sideX(a: Electron.Rectangle, width: number, inset: number): number {
  if (position.endsWith('left')) return a.x + inset;
  if (position.endsWith('right')) return a.x + a.width - width - inset;
  return Math.round(a.x + (a.width - width) / 2);
}

/** At the chosen spot of the display the mouse is on, inside its work area (clear of the taskbar or dock). */
export function placePill(w: BrowserWindow): void {
  const a = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  // QA screenshots of the pill are taken off-screen, out of the person's way.
  const away = process.env.DICTATE_PILL_SHOTS ? -10_000 : 0;
  const y = position.startsWith('top') ? a.y - PILL_OVERHANG : a.y + a.height - PILL_H + PILL_OVERHANG;
  w.setBounds({ x: sideX(a, PILL_W, 0) + away, y, width: PILL_W, height: PILL_H });
}

export function showPill(w: BrowserWindow): void {
  if (!w.isVisible()) {
    placePill(w);
    w.showInactive();
  }
  w.setAlwaysOnTop(true, 'screen-saver');
}

/** The pill itself and its hint line, at the pill window's screen edge: the sheet opens right beside them. */
export const PILL_STATUS_H = 76;

/**
 * The sheet: the big surfaces' one window (wide decision sheet, round, lineup, docked peek), frameless like the
 * pill but focusable and taking clicks everywhere, so keys and normal clicks work. Hidden until a surface opens it.
 */
export function createSheet(): BrowserWindow {
  const w = new BrowserWindow({
    width: 480,
    height: 240,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: true,
    hasShadow: false,
    alwaysOnTop: true,
    title: 'dictate sheet',
    webPreferences: { preload: preload(), backgroundThrottling: false, contextIsolation: true, sandbox: false },
  });
  w.setAlwaysOnTop(true, 'screen-saver');
  void w.loadFile(renderer('sheet.html'));
  return w;
}

/** The sheet's transparent margin, for its shadow: the surface inside is the size asked for. */
export const SHEET_MARGIN = 12;

/** On the display the pointer is on, in line with the pill and opening from it: up from the bottom, down from the top. */
export function placeSheet(w: BrowserWindow, size: { width: number; height: number }): void {
  const a = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  // QA screenshots are taken off-screen, out of the person's way, as the pill's are.
  const away = process.env.DICTATE_PILL_SHOTS ? -10_000 : 0;
  const width = size.width + 2 * SHEET_MARGIN;
  const height = size.height + 2 * SHEET_MARGIN;
  const y = position.startsWith('top')
    ? a.y - PILL_OVERHANG + PILL_STATUS_H - SHEET_MARGIN
    : a.y + a.height + PILL_OVERHANG - PILL_STATUS_H - height + SHEET_MARGIN;
  w.setBounds({ x: sideX(a, width, PILL_SIDE - SHEET_MARGIN) + away, y: Math.round(y), width, height });
}

export const PICKER_W = 380;
export const PICKER_H = 480;

export function createPicker(): BrowserWindow {
  const w = new BrowserWindow({
    width: PICKER_W,
    height: PICKER_H,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: true,
    hasShadow: false,
    alwaysOnTop: true,
    title: 'dictate history',
    webPreferences: { preload: preload(), backgroundThrottling: false, contextIsolation: true, sandbox: false },
  });
  w.setAlwaysOnTop(true, 'pop-up-menu');
  void w.loadFile(renderer('picker.html'));
  return w;
}

/**
 * Below the caret when the app reports one (physical pixels in), else at the mouse; flipped above when there is
 * no room below, and kept inside the work area.
 */
export function placePicker(w: BrowserWindow, caretPhysical: { x: number; y: number; width: number; height: number } | null): void {
  let anchor: { x: number; top: number; bottom: number };
  if (caretPhysical) {
    const top = screen.screenToDipPoint({ x: caretPhysical.x, y: caretPhysical.y });
    const bottom = screen.screenToDipPoint({ x: caretPhysical.x, y: caretPhysical.y + caretPhysical.height });
    anchor = { x: top.x, top: top.y, bottom: bottom.y };
  } else {
    const p = screen.getCursorScreenPoint();
    anchor = { x: p.x, top: p.y, bottom: p.y };
  }
  const a = screen.getDisplayNearestPoint({ x: Math.round(anchor.x), y: Math.round(anchor.bottom) }).workArea;
  // The window has a 12 px transparent margin for the shadow.
  let x = Math.round(anchor.x - 24);
  let y = Math.round(anchor.bottom + 2);
  if (y + PICKER_H > a.y + a.height) y = Math.round(anchor.top - PICKER_H - 2);
  x = Math.max(a.x, Math.min(x, a.x + a.width - PICKER_W));
  y = Math.max(a.y, Math.min(y, a.y + a.height - PICKER_H));
  w.setBounds({ x, y, width: PICKER_W, height: PICKER_H });
}

export function createSettings(): BrowserWindow {
  const w = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    show: false,
    title: 'dictate settings',
    icon: appIcon(),
    backgroundColor: '#202020',
    ...(process.platform === 'win32' ? {
      backgroundMaterial: 'mica' as const,
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: { color: '#00000000', symbolColor: '#ffffff', height: 40 },
    } : {}),
    autoHideMenuBar: true,
    webPreferences: { preload: preload(), contextIsolation: true, sandbox: false },
  });
  void w.loadFile(renderer('settings.html'));
  w.once('ready-to-show', () => w.show());
  return w;
}
