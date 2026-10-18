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
    expect(d.micWarm).toBe('off');
    expect(d.pillText).toBe(true);
  });

  it('unloads the models after 60 idle minutes on battery by default', () => {
    expect(d.batteryUnloadMinutes).toBe(60);
    expect(d.version).toBe(2);
  });

  it('moves a saved 15 (the old default, in a version-1 file) to 60', () => {
    const s = parseSettings({ version: 1, batteryUnloadMinutes: 15 }, d);
    expect(s.batteryUnloadMinutes).toBe(60);
    expect(s.version).toBe(2);
    // a file from before versions too
    expect(parseSettings({ batteryUnloadMinutes: 15 }, d).batteryUnloadMinutes).toBe(60);
  });

  it('keeps any other saved value: the person chose it', () => {
    for (const v of [0, 5, 30, 60, 120]) expect(parseSettings({ version: 1, batteryUnloadMinutes: v }, d).batteryUnloadMinutes).toBe(v);
  });

  it('keeps 15 once migrated: a person who picks 15 now means it', () => {
    const once = parseSettings({ version: 1, batteryUnloadMinutes: 15 }, d);
    const chosen = parseSettings({ ...once, batteryUnloadMinutes: 15 }, d);
    expect(chosen.batteryUnloadMinutes).toBe(15);
    expect(parseSettings(JSON.parse(JSON.stringify(chosen)), d).batteryUnloadMinutes).toBe(15);
  });

  it('cleans up as you speak by default (the user\'s decision), with Gemma then Emberon', () => {
    expect(d.liveCleanup).toBe(true);
    expect(d.liveCleanupSet).toBe(false);
    expect(d.cleanup).toBe('gemma-emberon');
  });

  it('turns a saved Off on when it was only the old default, not a choice', () => {
    expect(parseSettings({ version: 2, liveCleanup: false }, d).liveCleanup).toBe(true);
    expect(parseSettings({ version: 1, liveCleanup: false }, d).liveCleanup).toBe(true);
  });

  it('keeps an Off (or On) the person set themselves', () => {
    const off = parseSettings({ version: 2, liveCleanup: false, liveCleanupSet: true }, d);
    expect(off.liveCleanup).toBe(false);
    expect(parseSettings(JSON.parse(JSON.stringify(off)), d).liveCleanup).toBe(false);
    expect(parseSettings({ liveCleanup: true, liveCleanupSet: true }, d).liveCleanup).toBe(true);
  });

  it('accepts a binding written as a plain key list, as people write it by hand', () => {
    const s = parseSettings({ hotkey: [165], picker: [165, 86] }, d);
    expect(s.hotkey).toEqual({ keys: [165] });
    expect(s.picker).toEqual({ keys: [165, 86] });
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
