import { expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => {
  const windows: Window[] = [];
  class Window {
    setIgnoreMouseEvents = vi.fn();
    setAlwaysOnTop = vi.fn();
    loadFile = vi.fn();
    constructor(public options: Record<string, unknown>) { windows.push(this); }
  }
  return { windows, Window };
});
vi.mock('electron', () => ({ app: { getAppPath: () => '/app' }, BrowserWindow: mock.Window }));
vi.mock('../src/main/icons', () => ({ appIcon: () => undefined }));
import { createPill, createPicker, createSheet } from '../src/main/windows';

it('retains original transparent surfaces while enabling ordinary native input continuously', () => {
  createPill(); createPicker(); createSheet();
  for (const window of mock.windows) {
    expect(window.options).toMatchObject({ transparent: true, focusable: true, frame: false, show: false });
    expect(window.setIgnoreMouseEvents).not.toHaveBeenCalled();
  }
  expect(mock.windows[0].options).toMatchObject({ width: 600, height: 420 });
});
