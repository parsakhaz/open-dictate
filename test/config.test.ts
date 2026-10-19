import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultSettings, parseSettings } from '../src/core/settings';
import { runtimeDefaults, migratePlatformSettings } from '../src/main/config';

const vocab = [{ term: 'Dictate' }];

describe('portable first-run configuration', () => {
  it('puts models and tools in the user data folder on each native platform', () => {
    const cases = [
      { platform: 'win32' as const, userData: 'C:\\Users\\A User\\AppData\\Roaming\\dictate', model: 'C:\\Users\\A User\\AppData\\Roaming\\dictate\\models', exe: 'C:\\Users\\A User\\AppData\\Roaming\\dictate\\bin\\llama-server.exe' },
      { platform: 'darwin' as const, userData: '/Users/a/Library/Application Support/dictate', model: '/Users/a/Library/Application Support/dictate/models', exe: '/Users/a/Library/Application Support/dictate/bin/llama-server' },
      { platform: 'linux' as const, userData: '/home/a/.config/dictate', model: '/home/a/.config/dictate/models', exe: '/home/a/.config/dictate/bin/llama-server' },
    ];
    for (const c of cases) {
      const s = runtimeDefaults(vocab, c);
      expect(s.modelsDir).toBe(c.model);
      expect(s.llamaServer).toBe(c.exe);
      expect(s.cleanup).toBe('off');
    }
  });

  it('uses a Mac keyboard key and disables an unswallowable paste shortcut outside Windows', () => {
    expect(runtimeDefaults(vocab, { platform: 'darwin', userData: '/tmp/dictate' }).hotkeys).toEqual([{ keys: [0xa5] }]);
    expect(runtimeDefaults(vocab, { platform: 'linux', userData: '/tmp/dictate' }).picker).toBeNull();
    expect(runtimeDefaults(vocab, { platform: 'win32', userData: 'C:\\dictate' }).picker).toEqual({ keys: [0xa3, 0x56] });
  });

  it('migrates the Windows login preference without losing a saved choice', () => {
    const defaults = defaultSettings(vocab);
    expect(parseSettings({ startWithWindows: true }, defaults).startAtLogin).toBe(true);
    expect(parseSettings({ startAtLogin: false, startWithWindows: true }, defaults).startAtLogin).toBe(false);
  });

  it('keeps an existing Windows setup but replaces missing developer-only paths on another computer', () => {
    const defaults = runtimeDefaults(vocab, { platform: 'linux', userData: '/home/a/dictate' });
    const legacy = { modelsDir: 'C:\\repos\\experiments\\worktrees\\voice-lab\\voice-lab\\models', llamaServer: 'C:\\repos\\experiments\\worktrees\\voice-lab\\voice-lab\\bin\\llama-b11700-vulkan\\llama-server.exe', cleanup: 'gemma' };
    const migrated = migratePlatformSettings(legacy, defaults, () => false);
    expect(migrated.modelsDir).toBe(path.posix.join('/home/a/dictate', 'models'));
    expect(migrated.llamaServer).toBe(path.posix.join('/home/a/dictate', 'bin', 'llama-server'));
    expect(migrated.cleanup).toBe('gemma');
    expect(migratePlatformSettings(legacy, defaults, () => true)).toEqual(legacy);
    expect(migratePlatformSettings({ modelsDir: '/my/custom/models' }, defaults, () => false).modelsDir).toBe('/my/custom/models');
  });
});
