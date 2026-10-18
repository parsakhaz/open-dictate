// The three windows. The pill and the picker never take focus, so the app being dictated into keeps it.
import path from 'node:path';
import { app, BrowserWindow, screen } from 'electron';
import { appIcon } from './icons';

const renderer = (file: string) => path.join(app.getAppPath(), 'out', 'renderer', file);
const preload = () => path.join(app.getAppPath(), 'out', 'main', 'preload.js');

export const PILL_W = 600;
export const PILL_H = 120;

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
  w.setIgnoreMouseEvents(true);
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
    focusable: false,
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
    backgroundColor: '#00000000',
    backgroundMaterial: 'mica',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#ffffff', height: 40 },
    autoHideMenuBar: true,
    webPreferences: { preload: preload(), contextIsolation: true, sandbox: false },
  });
  void w.loadFile(renderer('settings.html'));
  w.once('ready-to-show', () => w.show());
  return w;
}
