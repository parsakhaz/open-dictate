import { describe, expect, it } from 'vitest';
import { IDLE_BEFORE_INSTALL_MS, installWaitMs, isNewer, nextCheckMs, updateMode, versionFromTag } from '../src/core/updates';

const idle = { recording: false, cleaning: false, downloading: false };
const min = 60_000;

describe('auto-update', () => {
  it('installs itself on Windows and from an AppImage; only tells people elsewhere; never in development', () => {
    expect(updateMode({ platform: 'win32', packaged: true })).toBe('install');
    expect(updateMode({ platform: 'linux', packaged: true, appImage: '/home/a/Dictate.AppImage' })).toBe('install');
    // An unsigned Mac app cannot replace itself, and a .deb is upgraded by its package manager.
    expect(updateMode({ platform: 'darwin', packaged: true })).toBe('notify');
    expect(updateMode({ platform: 'linux', packaged: true })).toBe('notify');
    expect(updateMode({ platform: 'win32', packaged: false })).toBe('off');
  });

  it('reads the version from a release tag', () => {
    expect(versionFromTag('dictate-v0.2.1')).toBe('0.2.1');
    expect(versionFromTag('v1.10.0')).toBe('1.10.0');
    expect(versionFromTag('nightly')).toBeNull();
  });

  it('compares versions numerically, and a pre-release is older than its release', () => {
    expect(isNewer('0.2.1', '0.2.0')).toBe(true);
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('0.2.0', '0.2.0')).toBe(false);
    expect(isNewer('0.1.9', '0.2.0')).toBe(false);
    expect(isNewer('0.3.0-beta.1', '0.3.0')).toBe(false);
    expect(isNewer('0.3.0', '0.3.0-beta.1')).toBe(true);
  });

  it('checks a minute after start, then once a day', () => {
    expect(nextCheckMs(null, 0)).toBe(min);
    expect(nextCheckMs(1000, 1000)).toBe(24 * 60 * min);
    expect(nextCheckMs(0, 25 * 60 * min)).toBe(min);
  });

  it('installs a downloaded update after 10 idle minutes, never during a recording, cleanup or download', () => {
    const last = 0;
    expect(IDLE_BEFORE_INSTALL_MS).toBe(10 * min);
    expect(installWaitMs(idle, last, 10 * min)).toBe(0);
    expect(installWaitMs(idle, last, 4 * min)).toBe(6 * min);
    for (const busy of ['recording', 'cleaning', 'downloading'] as const) expect(installWaitMs({ ...idle, [busy]: true }, last, 60 * min)).toBeNull();
  });
});
