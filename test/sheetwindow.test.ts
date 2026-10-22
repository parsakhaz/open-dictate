import { expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  events: new Map<string, (...args: unknown[]) => void>(),
  win: {
    webContents: { on: vi.fn(), send: vi.fn() },
    on: (event: string, handler: (...args: unknown[]) => void) => mock.events.set(event, handler),
    isDestroyed: () => false,
    showInactive: vi.fn(), hide: vi.fn(), setAlwaysOnTop: vi.fn(), moveTop: vi.fn(), destroy: vi.fn(),
  },
}));
vi.mock('electron', () => ({ ipcMain: { on: vi.fn() } }));
vi.mock('../src/main/windows', () => ({ createSheet: () => mock.win, placeSheet: vi.fn() }));
import { Sheet } from '../src/main/sheet';

it('native close clears the feature and notifies its cleanup exactly once', () => {
  const sheet = new Sheet(vi.fn());
  const cleanup = vi.fn();
  sheet.onClosed(cleanup);
  sheet.open('round', {});
  const preventDefault = vi.fn();
  mock.events.get('close')!({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(sheet.isOpen).toBe(false);
  expect(cleanup).toHaveBeenCalledExactlyOnceWith('round', 'closed');
  expect(mock.win.hide).toHaveBeenCalled();
  sheet.destroy();
  expect(cleanup).toHaveBeenCalledTimes(1);
});
