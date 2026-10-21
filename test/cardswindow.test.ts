import { beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const windows: Window[] = [];
  class Window {
    events = new Map<string, (...args: unknown[]) => void>();
    visible = false;
    webContents = { send: vi.fn(), on: vi.fn() };
    setAlwaysOnTop = vi.fn();
    setBounds = vi.fn();
    getBounds = () => ({ x: 750, y: 804, width: 420, height: 200 });
    loadFile = vi.fn();
    reload = vi.fn();
    destroy = vi.fn();
    isDestroyed = () => false;
    isVisible = () => this.visible;
    showInactive = () => { this.visible = true; };
    hide = () => { this.visible = false; };
    on = (event: string, handler: (...args: unknown[]) => void) => this.events.set(event, handler);
    constructor(public options: Record<string, unknown>) { windows.push(this); }
  }
  return { handlers, windows, Window };
});
vi.mock('electron', () => ({
  app: { getAppPath: () => '/app' },
  ipcMain: { on: (channel: string, handler: (...args: unknown[]) => void) => mock.handlers.set(channel, handler) },
  screen: { getCursorScreenPoint: () => ({ x: 10, y: 10 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  BrowserWindow: mock.Window,
}));
import { CardsWindow } from '../src/main/cardswindow';

beforeEach(() => { mock.handlers.clear(); mock.windows.length = 0; });

it('keeps normal native input through card, snoozed inbox, and hidden transitions', () => {
  const surface = new CardsWindow(vi.fn(), vi.fn());
  const win = mock.windows[0];
  expect(win.options).toMatchObject({ transparent: false, focusable: true });
  // This mock deliberately offers no setShape, ignore-mouse, or input-forwarding API.
  const e = { sender: win.webContents };
  surface.send('dictate:cards', { top: { id: 'k1' } });
  expect(win.webContents.send).not.toHaveBeenCalled();
  mock.handlers.get('dictate:cards-ready')!(e);
  expect(win.webContents.send).toHaveBeenCalledWith('dictate:cards', { top: { id: 'k1' } });
  const size = mock.handlers.get('dictate:cards-size')!;
  size(e, 200, true);
  expect(win.visible).toBe(true);
  size(e, 90, true);
  expect(win.visible).toBe(true);
  size(e, 0, false);
  expect(win.visible).toBe(false);
  size(e, 200, true);
  expect(win.visible).toBe(true);
  expect(win.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ width: 420, height: 200 }));
});

it('routes native close and renderer Close/Escape through dismissal and rejects other senders', () => {
  const dismiss = vi.fn();
  new CardsWindow(vi.fn(), dismiss);
  const win = mock.windows[0];
  const preventDefault = vi.fn();
  win.events.get('close')!({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(dismiss).toHaveBeenCalledOnce();
  mock.handlers.get('dictate:cards-close')!({ sender: {} });
  expect(dismiss).toHaveBeenCalledOnce();
  mock.handlers.get('dictate:cards-close')!({ sender: win.webContents });
  expect(dismiss).toHaveBeenCalledTimes(2);
});

it('keeps a closed inbox hidden until a new card arrives', () => {
  const surface = new CardsWindow(vi.fn(), vi.fn());
  const win = mock.windows[0];
  const event = { sender: win.webContents };
  const size = mock.handlers.get('dictate:cards-size')!;
  size(event, 100, true);
  mock.handlers.get('dictate:cards-close')!(event);
  size(event, 110, true);
  expect(win.visible).toBe(false);
  surface.send('dictate:cards', { top: null });
  size(event, 100, true);
  expect(win.visible).toBe(false);
  surface.send('dictate:cards', { top: { id: 'next' } });
  size(event, 100, true);
  expect(win.visible).toBe(true);
});
