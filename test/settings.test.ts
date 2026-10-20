import { describe, expect, it } from 'vitest';
import { gainSpec } from '../src/core/agc';
import { micKey } from '../src/core/mics';
import { ALT_MODELS_DIR, applyEnv, DEFAULT_MODELS_DIR, defaultSettings, LEGACY_MODELS_DIR, parseSettings, resolveModelsDir } from '../src/core/settings';

const d = defaultSettings([{ term: 'Pane' }]);

describe('automatic gain settings', () => {
  const amd = 'Microphone Array (AMD Audio Device)';

  it('turns automatic gain on for a file saved before it, keeping the saved +30 dB as the maximum boost', () => {
    const s = parseSettings({ version: 2, gainDb: { [micKey(amd)]: 30, [micKey('Headset (USB)')]: 6 } }, d);
    expect(s.autoGain).toBe(true);
    expect(gainSpec(s, amd)).toMatchObject({ auto: true, db: 30 });
    expect(gainSpec(s, 'Headset (USB)')).toMatchObject({ auto: true, db: 6 });
  });

  it('gives the quiet built-in array +30 dB of headroom and a head start, and other mics up to +20 dB', () => {
    expect(gainSpec(d, amd)).toEqual({ auto: true, db: 30, startDb: 17 });
    expect(gainSpec(d, 'Headset (USB)')).toEqual({ auto: true, db: 20, startDb: 0 });
  });

  it('starts each mic at the gain its last dictation reached', () => {
    const s = parseSettings({ agcGainDb: { [micKey(amd)]: 21.5, junk: 'x' } }, d);
    expect(s.agcGainDb).toEqual({ [micKey(amd)]: 21.5 });
    expect(gainSpec(s, amd).startDb).toBe(21.5);
  });

  it('keeps today’s fixed gain in manual mode', () => {
    const s = parseSettings({ autoGain: false, gainDb: { [micKey(amd)]: 30 } }, d);
    expect(gainSpec(s, amd)).toEqual({ auto: false, db: 30 });
    expect(gainSpec(s, 'Headset (USB)')).toEqual({ auto: false, db: 0 });
  });
});

describe('parseSettings', () => {
  it('round-trips the defaults', () => {
    expect(parseSettings(JSON.parse(JSON.stringify(d)), d)).toEqual(d);
  });

  it('defaults to Right Ctrl (hold or double-tap), no toggle combo, Right Ctrl+V picker, Gemma then Emberon, paste', () => {
    expect(d.hotkeys).toEqual([{ keys: [0xa3] }]);
    expect(d.toggle).toBeNull();
    expect(d.picker).toEqual({ keys: [0xa3, 0x56] });
    expect([d.tapMs, d.doubleTapMs]).toEqual([250, 350]);
    expect(d.cleanup).toBe('gemma-emberon');
    expect(d.output).toBe('paste');
    expect(d.sttThreads).toBe(4);
    expect(d.micWarm).toBe('off');
    expect(d.pillText).toBe(true);
    expect(d.pressEnter).toBe(false);
  });

  it('lets coding agents in by default, with alerts on, a chime, and history reading off', () => {
    expect([d.agentsEnabled, d.agentAlertsPaused, d.agentChime, d.agentHistory]).toEqual([true, false, true, false]);
    expect(d.vocabularyPending).toEqual([]);
  });

  it("leaves Pane's own alerts to Pane by default, also for a 0.1.0 profile, and keeps a choice to show them", () => {
    expect(d.agentPaneAlerts).toBe(false);
    expect(parseSettings({ version: 2, onboarded: true, agentsEnabled: true, agentChime: true }, d).agentPaneAlerts).toBe(false);
    expect(parseSettings({ agentPaneAlerts: true }, d).agentPaneAlerts).toBe(true);
  });

  it('loads a file from before agents, and keeps a valid review queue while dropping a bad item', () => {
    const s = parseSettings({ agentHistory: 'yes', vocabularyPending: [{ term: 'Supabase', aliases: ['super base'], reason: 'db', source: 'repo · Codex', at: '2026-10-19T20:00:00Z' }, { term: 'a => b', aliases: [] }] }, d);
    expect(s.agentHistory).toBe(false);
    expect(s.vocabularyPending.map((t) => t.term)).toEqual(['Supabase']);
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
    expect(s.hotkeys).toEqual([{ keys: [165] }]);
    expect(s.picker).toEqual({ keys: [165, 86] });
  });

  it('reads several dictation keys (B2), keeping up to 4 good ones; an old single "hotkey" becomes the list', () => {
    expect(parseSettings({ hotkey: { keys: [165] } }, d).hotkeys).toEqual([{ keys: [165] }]);
    expect(parseSettings({ hotkeys: [[165], { keys: [0x7c] }, { keys: ['hyper'] }] }, d).hotkeys).toEqual([{ keys: [165] }, { keys: [0x7c] }]);
    expect(parseSettings({ hotkeys: [[1], [2], [3], [4], [5]] }, d).hotkeys).toHaveLength(4);
    expect(parseSettings({ hotkeys: [] }, d).hotkeys).toEqual([]);
    expect(parseSettings({ hotkeys: 'x' }, d).hotkeys).toEqual(d.hotkeys);
    expect(parseSettings({ hotkey: null }, d).hotkeys).toEqual([]);
  });

  it('replaces malformed fields with defaults and keeps good ones', () => {
    const s = parseSettings({ cleanup: 'bogus', output: 'both', hotkey: { keys: ['hyper'] }, toggle: { keys: ['ctrl', 0x20] }, sttThreads: 99, gainDb: { a: 6, b: 'x' } }, d);
    expect(s.cleanup).toBe('gemma-emberon');
    expect(s.output).toBe('both');
    expect(s.hotkeys).toEqual(d.hotkeys);
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
    expect(resolveModelsDir(LEGACY_MODELS_DIR, (p) => p === ALT_MODELS_DIR)).toBe(ALT_MODELS_DIR);
    expect(resolveModelsDir(DEFAULT_MODELS_DIR, (p) => p === ALT_MODELS_DIR)).toBe(DEFAULT_MODELS_DIR);
    expect(resolveModelsDir(DEFAULT_MODELS_DIR, () => true)).toBe(DEFAULT_MODELS_DIR);
    expect(resolveModelsDir('E:\\mine', (p) => p === ALT_MODELS_DIR)).toBe('E:\\mine');
  });
});

describe('first-run walkthrough state', () => {
  it('starts a new profile at the welcome step, licences not yet shown, no hardware check', () => {
    expect([d.onboarded, d.onboardingStep, d.licencesSeen, d.hardware]).toEqual([false, 'welcome', false, null]);
  });

  it('keeps the saved step, the licences flag and the hardware result', () => {
    const hardware = { summary: 'No GPU found, 16 GB RAM. Emberon cleaned the sample in 0.62 s.', chain: 'emberon', emberonMs: 620, gemmaChainMs: null, offerGemma: true, measuredAt: '2026-10-18T22:00:00.000Z' };
    const s = parseSettings({ onboardingStep: 'hotkey', licencesSeen: true, hardware }, d);
    expect([s.onboardingStep, s.licencesSeen, s.hardware]).toEqual(['hotkey', true, hardware]);
  });

  it('drops an unknown step or a malformed hardware result', () => {
    const s = parseSettings({ onboardingStep: 'nowhere', hardware: { summary: 3 } }, d);
    expect([s.onboardingStep, s.hardware]).toEqual(['welcome', null]);
  });

  it('checks for updates by default, and keeps the choice to turn that off', () => {
    expect(d.autoUpdate).toBe(true);
    expect(parseSettings({ autoUpdate: false }, d).autoUpdate).toBe(false);
  });

  it('an existing profile that finished the old welcome page stays onboarded', () => {
    expect(parseSettings({ onboarded: true }, d).onboarded).toBe(true);
  });
});
