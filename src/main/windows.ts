// The four windows. The pill and the picker never take focus, so the app being dictated into keeps it; the sheet
// takes it only when a surface asks (a round, the wide decision sheet) and gives it back when it closes.
import path from 'node:path';
import { app, BrowserWindow, screen } from 'electron';
import { appIcon } from './icons';

const renderer = (file: string) => path.join(app.getAppPath(), 'out', 'renderer', file);
const preload = () => path.join(app.getAppPath(), 'out', 'main', 'preload.js');

export const PILL_W = 600;
/** Tall enough for an expanded agent card above the pill; everything but the cards lets clicks through. */
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
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    title: 'dictate',
    webPreferences: { preload: preload(), backgroundThrottling: false, contextIsolation: true, sandbox: false },
  });
  w.setAlwaysOnTop(true, 'screen-saver');
  // Clicks pass through; pointer moves still reach the page so a card can take them while the pointer is on it.
  w.setIgnoreMouseEvents(true, { forward: true });
  void w.loadFile(renderer('pill.html'));
  return w;
}

/** Bottom-centre of the display the mouse is on, above the taskbar. */
export function placePill(w: BrowserWindow): void {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const a = d.workArea;
  // QA screenshots of the pill are taken off-screen, out of the person's way.
  const away = process.env.DICTATE_PILL_SHOTS ? -10_000 : 0;
  w.setBounds({ x: Math.round(a.x + (a.width - PILL_W) / 2) + away, y: Math.round(a.y + a.height - PILL_H + 12), width: PILL_W, height: PILL_H });
}

export function showPill(w: BrowserWindow): void {
  if (!w.isVisible()) {
    placePill(w);
    w.showInactive();
  }
  w.setAlwaysOnTop(true, 'screen-saver');
}

/** The pill itself and its hint line, at the bottom of the pill window: the sheet sits right above them. */
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

/** Centred on the display the pointer is on, its bottom right above the pill. `size` is the surface's own size. */
export function placeSheet(w: BrowserWindow, size: { width: number; height: number }): void {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const a = d.workArea;
  // QA screenshots are taken off-screen, out of the person's way, as the pill's are.
  const away = process.env.DICTATE_PILL_SHOTS ? -10_000 : 0;
  const width = size.width + 2 * SHEET_MARGIN;
  const height = size.height + 2 * SHEET_MARGIN;
  const pillBottom = a.y + a.height + 12;
  w.setBounds({ x: Math.round(a.x + (a.width - width) / 2) + away, y: Math.round(pillBottom - PILL_STATUS_H - height + SHEET_MARGIN), width, height });
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
    focusable: process.platform !== 'win32',
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
