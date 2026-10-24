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

it('the pill never takes focus and starts click-through; picker and sheet take ordinary input', () => {
  const [pill, ...rest] = [createPill(), createPicker(), createSheet()].map((_, i) => mock.windows[i]);
  expect(pill.options).toMatchObject({ transparent: true, focusable: false, frame: false, show: false, width: 600, height: 420 });
  expect(pill.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true });
  for (const window of rest) {
    expect(window.options).toMatchObject({ transparent: true, focusable: true, frame: false, show: false });
    expect(window.setIgnoreMouseEvents).not.toHaveBeenCalled();
  }
});
