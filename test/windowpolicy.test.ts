import { beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
  const windows: Window[] = [];
  class Window {
    setIgnoreMouseEvents = vi.fn();
    setAlwaysOnTop = vi.fn();
    loadFile = vi.fn();
    once = vi.fn();
    show = vi.fn();
    showInactive = vi.fn();
    constructor(public options: Record<string, unknown>) { windows.push(this); }
  }
  return { Window, windows };
});
vi.mock('electron', () => ({
  app: { getAppPath: () => '/app' }, BrowserWindow: mock.Window,
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: { x: -360, y: 20, width: 360, height: 320 } }) },
}));
vi.mock('../src/main/icons', () => ({ appIcon: () => undefined }));
import { createPicker, createPill, createSettings, createSheet } from '../src/main/windows';

beforeEach(() => { mock.windows.length = 0; });

it('only passive pill ignores input; history and sheets remain normally focusable', () => {
  createPill(); createPicker(); createSheet();
  expect(mock.windows[0].setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true });
  for (const window of mock.windows.slice(1)) {
    expect(window.options.focusable).toBe(true);
    expect(window.options.transparent).toBe(false);
    expect(window.setIgnoreMouseEvents).not.toHaveBeenCalled();
  }
  expect(mock.windows[1].options.transparent).toBe(false);
});

it('keeps settings and its native close chrome inside a small work area', () => {
  createSettings();
  expect(mock.windows[0].options).toMatchObject({ width: 360, height: 320, minWidth: 360, minHeight: 320, x: -360, y: 20 });
});
