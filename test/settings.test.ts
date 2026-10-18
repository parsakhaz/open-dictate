import { describe, expect, it } from 'vitest';
import { ALT_MODELS_DIR, applyEnv, DEFAULT_MODELS_DIR, defaultSettings, parseSettings, resolveModelsDir } from '../src/core/settings';

const d = defaultSettings([{ term: 'Pane' }]);

describe('parseSettings', () => {
  it('round-trips the defaults', () => {
    expect(parseSettings(JSON.parse(JSON.stringify(d)), d)).toEqual(d);
  });

  it('defaults to Right Ctrl (hold or double-tap), no toggle combo, Right Ctrl+V picker, Gemma then Emberon, paste', () => {
    expect(d.hotkey).toEqual({ keys: [0xa3] });
    expect(d.toggle).toBeNull();
    expect(d.picker).toEqual({ keys: [0xa3, 0x56] });
    expect([d.tapMs, d.doubleTapMs]).toEqual([250, 350]);
    expect(d.cleanup).toBe('gemma-emberon');
    expect(d.output).toBe('paste');
    expect(d.sttThreads).toBe(4);
  });

  it('replaces malformed fields with defaults and keeps good ones', () => {
    const s = parseSettings({ cleanup: 'bogus', output: 'both', hotkey: { keys: ['hyper'] }, toggle: { keys: ['ctrl', 0x20] }, sttThreads: 99, gainDb: { a: 6, b: 'x' } }, d);
    expect(s.cleanup).toBe('gemma-emberon');
    expect(s.output).toBe('both');
    expect(s.hotkey).toEqual(d.hotkey);
    expect(s.toggle).toEqual({ keys: ['ctrl', 0x20] });
    expect(s.sttThreads).toBe(16);
    expect(s.gainDb).toEqual({ a: 6 });
    expect(s.vocabulary).toEqual(d.vocabulary);
  });

  it('survives garbage', () => {
    expect(parseSettings('nope', d)).toEqual(d);
    expect(parseSettings(null, d)).toEqual(d);
  });
});

describe('paths', () => {
  it('lets env vars override the configured paths', () => {
    const s = applyEnv(d, { DICTATE_MODELS_DIR: 'D:\\m', DICTATE_LLAMA_SERVER: '' });
    expect(s.modelsDir).toBe('D:\\m');
    expect(s.llamaServer).toBe(d.llamaServer);
  });

  it('falls back to the voice-lab-app junction only when the default folder is missing', () => {
    expect(resolveModelsDir(DEFAULT_MODELS_DIR, (p) => p === ALT_MODELS_DIR)).toBe(ALT_MODELS_DIR);
    expect(resolveModelsDir(DEFAULT_MODELS_DIR, () => true)).toBe(DEFAULT_MODELS_DIR);
    expect(resolveModelsDir('E:\\mine', (p) => p === ALT_MODELS_DIR)).toBe('E:\\mine');
  });
});
