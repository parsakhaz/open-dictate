// Runtime defaults use the current person's data directory; core/settings stays browser-safe.
import path from 'node:path';
import { ALT_MODELS_DIR, defaultSettings, LEGACY_LLAMA_SERVER, LEGACY_MODELS_DIR } from '../core/settings';
import type { Settings, VocabTerm } from '../core/types';

export function runtimeDefaults(vocabulary: VocabTerm[], runtime: { platform: NodeJS.Platform; userData: string }): Settings {
  const join = runtime.platform === 'win32' ? path.win32.join : path.posix.join;
  return {
    ...defaultSettings(vocabulary),
    modelsDir: join(runtime.userData, 'models'),
    llamaServer: join(runtime.userData, 'bin', runtime.platform === 'win32' ? 'llama-server.exe' : 'llama-server'),
    // Raw transcription works after the speech download; cleanup is an optional, explicit download.
    cleanup: 'off',
    ...(runtime.platform === 'darwin' ? { hotkeys: [{ keys: [0xa5] }] } : {}),
    // Outside Windows the global hook cannot swallow V; keep the app's native paste shortcut untouched.
    ...(runtime.platform !== 'win32' ? { picker: null } : {}),
  };
}

export function migratePlatformSettings(data: unknown, defaults: Settings, exists: (file: string) => boolean): Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const s = { ...data } as Record<string, unknown>;
  if ((s.modelsDir === LEGACY_MODELS_DIR || s.modelsDir === ALT_MODELS_DIR) && !exists(s.modelsDir)) s.modelsDir = defaults.modelsDir;
  if (s.llamaServer === LEGACY_LLAMA_SERVER && !exists(s.llamaServer)) s.llamaServer = defaults.llamaServer;
  return s;
}
