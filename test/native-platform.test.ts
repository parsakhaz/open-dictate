import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopSession } from '../src/native/session';

const board = vi.hoisted(() => ({ text: '' }));
vi.mock('electron', () => ({
  clipboard: { writeText: async (text: string) => { board.text = text; } },
  systemPreferences: { isTrustedAccessibilityClient: () => false },
  ClipboardItem: class {},
}));
afterEach(() => vi.unstubAllEnvs());

describe('desktop capabilities', () => {
  it('treats XWayland as Wayland, where external app input is unavailable', () => {
    expect(desktopSession('linux', { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' })).toBe('wayland');
    expect(desktopSession('linux', { DISPLAY: ':0', XDG_SESSION_TYPE: 'wayland' })).toBe('wayland');
    expect(desktopSession('linux', { DISPLAY: ':99', XDG_SESSION_TYPE: 'x11' })).toBe('x11');
    expect(desktopSession('linux', {})).toBe('headless');
    expect(desktopSession('darwin', {})).toBe('macos');
    expect(desktopSession('win32', {})).toBe('win32');
    expect(desktopSession('freebsd', {})).toBe('unsupported');
  });
});

describe.skipIf(process.platform !== 'linux')('restricted desktop output', () => {
  it('keeps dictation usable on Wayland without loading Windows APIs or claiming a paste', async () => {
    vi.stubEnv('WAYLAND_DISPLAY', 'wayland-0');
    vi.stubEnv('DISPLAY', ':0');
    const native = await import('../src/native/platform');
    expect(native.platformCapabilities()).toMatchObject({ displayServer: 'wayland', automaticPaste: false, globalHotkeys: false, canSwallowKeys: false, targetTracking: false });
    expect(native.platformCapabilities().reason).toContain('Start/Stop');
    expect(native.foregroundWindow()).toBe(0);
    expect(native.sendCtrlV()).toBe(0);
    expect(native.typeText('hello')).toBe(false);
    await native.writeClipboardText('hello');
    expect(board.text).toBe('hello');
  });
});
