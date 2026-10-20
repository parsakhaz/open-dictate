// Settings defaults and loading: whatever the file holds is checked field by field, and anything missing or
// malformed falls back to its default, so an old or hand-edited file never stops the app. Pure.
import { DEFAULT_HISTORY_LIMIT } from './history';
import { DEFAULT_TIMING, VK } from './hotkeys';
import { parseMicPrefs } from './mics';
import { isStep } from './onboarding';
import type { Binding, CleanupChain, HardwareResult, KeySpec, OutputMode, Settings, VocabTerm } from './types';
import { normalizeVocabulary } from './vocabulary';
import { parsePending } from './vocabproposals';

/** Relative defaults for non-app callers; main resolves these under Electron's userData directory. */
export const DEFAULT_MODELS_DIR = 'models';
export const DEFAULT_LLAMA_SERVER = 'llama-server';
/** Old developer defaults are recognized only for backwards-compatible migration. */
export const LEGACY_MODELS_DIR = 'C:\\repos\\experiments\\worktrees\\voice-lab\\voice-lab\\models';
export const ALT_MODELS_DIR = 'C:\\repos\\voice-lab-app\\models';
export const LEGACY_LLAMA_SERVER = 'C:\\repos\\experiments\\worktrees\\voice-lab\\voice-lab\\bin\\llama-b11700-vulkan\\llama-server.exe';

export const STT_MODEL = 'sherpa-onnx-nemotron-speech-streaming-en-0.6b-1120ms-int8-2026-04-25';
export const GEMMA_GGUF = 'gemma-4-E2B-it-Q4_K_M.gguf';
export const EMBERON_GGUF = 'Emberon-2-Q4_K_M.gguf';

export function defaultSettings(vocabulary: VocabTerm[] = []): Settings {
  return {
    version: 2,
    hotkeys: [{ keys: [VK.RCtrl] }],
    toggle: null,
    picker: { keys: [VK.RCtrl, VK.V] },
    portableShortcut: 'CommandOrControl+Shift+Space',
    portableShortcutEnabled: false,
    tapMs: DEFAULT_TIMING.tapMs,
    doubleTapMs: DEFAULT_TIMING.doubleTapMs,
    micOrder: [],
    autoGain: true,
    gainDb: {},
    agcGainDb: {},
    cleanup: 'gemma-emberon',
    output: 'paste',
    sounds: true,
    pressEnter: false,
    pillText: true,
    micWarm: 'off',
    liveCleanup: true,
    liveCleanupSet: false,
    livePauseMs: 700,
    historyLimit: DEFAULT_HISTORY_LIMIT,
    modelsDir: DEFAULT_MODELS_DIR,
    llamaServer: DEFAULT_LLAMA_SERVER,
    sttThreads: 4,
    startAtLogin: false,
    startWithWindows: false,
    batteryUnloadMinutes: 60,
    batteryEmberonOnly: false,
    onboarded: false,
    onboardingStep: 'welcome',
    licencesSeen: false,
    hardware: null,
    autoUpdate: true,
    vocabulary,
    vocabularyPending: [],
    agentsEnabled: true,
    agentAlertsPaused: false,
    agentChime: true,
    agentPaneAlerts: false,
    agentHistory: false,
  };
}

const CHAINS: CleanupChain[] = ['off', 'emberon', 'gemma', 'gemma-emberon'];
const OUTPUTS: OutputMode[] = ['paste', 'clipboard', 'both'];
const GENERIC = ['ctrl', 'shift', 'alt', 'meta'];

function isKeySpec(x: unknown): x is KeySpec {
  return (typeof x === 'number' && Number.isInteger(x) && x > 0) || (typeof x === 'string' && GENERIC.includes(x));
}

/** `{ "keys": [165] }`, or the shorthand `[165]` people write by hand. */
function binding(x: unknown, fallback: Binding | null): Binding | null {
  if (x === null) return null;
  const keys = Array.isArray(x) ? x : (x as { keys?: unknown })?.keys;
  return Array.isArray(keys) && keys.length > 0 && keys.every(isKeySpec) ? { keys } : fallback;
}

export const MAX_HOTKEYS = 4;

/** `hotkeys`, or a file from before several keys (a single `hotkey`, possibly null). */
function hotkeys(d: Record<string, unknown>, fallback: Binding[]): Binding[] {
  if (Array.isArray(d.hotkeys)) {
    const good = d.hotkeys.map((x) => binding(x, null)).filter((b): b is Binding => !!b);
    return d.hotkeys.length && !good.length ? fallback : good.slice(0, MAX_HOTKEYS);
  }
  if (!('hotkey' in d)) return fallback;
  const one = binding(d.hotkey, fallback[0] ?? null);
  return one ? [one] : [];
}

const str = (x: unknown, d: string) => (typeof x === 'string' && x.trim() ? x : d);
const bool = (x: unknown, d: boolean) => (typeof x === 'boolean' ? x : d);
const num = (x: unknown, d: number, lo: number, hi: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d);

/** Version 1 saved every field, so a 15 there is the old default rather than a choice: it becomes 60. */
function unloadMinutes(d: Record<string, unknown>, defaults: Settings): number {
  const v = num(d.batteryUnloadMinutes, defaults.batteryUnloadMinutes, 0, 24 * 60);
  return (d.version ?? 1) === 1 && v === 15 ? 60 : v;
}

/** Gains per mic, each kept within -20…+40 dB. */
function dbMap(x: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof x === 'object' && x !== null) {
    for (const [k, v] of Object.entries(x)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.min(40, Math.max(-20, v));
  }
  return out;
}

const msOrNull = (x: unknown) => (x === null || (typeof x === 'number' && Number.isFinite(x) && x >= 0));

function hardwareResult(x: unknown): HardwareResult | null {
  const r = x as Partial<HardwareResult> | null;
  if (!r || typeof r !== 'object' || typeof r.summary !== 'string' || !CHAINS.includes(r.chain as CleanupChain)) return null;
  if (!msOrNull(r.emberonMs) || !msOrNull(r.gemmaChainMs) || typeof r.offerGemma !== 'boolean' || typeof r.measuredAt !== 'string') return null;
  return { summary: r.summary, chain: r.chain as CleanupChain, emberonMs: r.emberonMs ?? null, gemmaChainMs: r.gemmaChainMs ?? null, offerGemma: r.offerGemma, measuredAt: r.measuredAt };
}

export function parseSettings(data: unknown, defaults: Settings): Settings {
  if (typeof data !== 'object' || data === null) return defaults;
  const d = data as Record<string, unknown>;
  const vocab = Array.isArray(d.vocabulary) ? d.vocabulary.filter((t) => typeof t?.term === 'string') : null;
  const micOrder = Array.isArray(d.micOrder) ? parseMicPrefs(d.micOrder) : defaults.micOrder;
  return {
    version: 2,
    hotkeys: hotkeys(d, defaults.hotkeys),
    toggle: binding(d.toggle, defaults.toggle),
    picker: binding(d.picker, defaults.picker),
    portableShortcut: typeof d.portableShortcut === 'string' && d.portableShortcut.length < 120 ? d.portableShortcut : defaults.portableShortcut,
    portableShortcutEnabled: bool(d.portableShortcutEnabled, defaults.portableShortcutEnabled),
    tapMs: Math.round(num(d.tapMs, defaults.tapMs, 100, 800)),
    doubleTapMs: Math.round(num(d.doubleTapMs, defaults.doubleTapMs, 150, 1000)),
    micOrder,
    // Saved before automatic gain: the gain the person chose becomes its maximum boost.
    autoGain: bool(d.autoGain, defaults.autoGain),
    gainDb: dbMap(d.gainDb),
    agcGainDb: dbMap(d.agcGainDb),
    cleanup: CHAINS.includes(d.cleanup as CleanupChain) ? (d.cleanup as CleanupChain) : defaults.cleanup,
    output: OUTPUTS.includes(d.output as OutputMode) ? (d.output as OutputMode) : defaults.output,
    sounds: bool(d.sounds, defaults.sounds),
    pressEnter: bool(d.pressEnter, defaults.pressEnter),
    pillText: bool(d.pillText, defaults.pillText),
    micWarm: (['off', '30s', 'always'] as const).find((w) => w === d.micWarm) ?? defaults.micWarm,
    // A saved value the person never chose was just the default of its day: it follows today's default.
    liveCleanup: d.liveCleanupSet === true ? bool(d.liveCleanup, defaults.liveCleanup) : defaults.liveCleanup,
    liveCleanupSet: d.liveCleanupSet === true,
    livePauseMs: Math.round(num(d.livePauseMs, defaults.livePauseMs, 300, 3000)),
    historyLimit: Math.round(num(d.historyLimit, defaults.historyLimit, 1, 10_000)),
    modelsDir: str(d.modelsDir, defaults.modelsDir),
    llamaServer: str(d.llamaServer, defaults.llamaServer),
    sttThreads: Math.round(num(d.sttThreads, defaults.sttThreads, 1, 16)),
    startAtLogin: bool(d.startAtLogin, bool(d.startWithWindows, defaults.startAtLogin)),
    startWithWindows: bool(d.startAtLogin, bool(d.startWithWindows, defaults.startAtLogin)),
    batteryUnloadMinutes: unloadMinutes(d, defaults),
    batteryEmberonOnly: bool(d.batteryEmberonOnly, defaults.batteryEmberonOnly),
    onboarded: bool(d.onboarded, defaults.onboarded),
    onboardingStep: isStep(d.onboardingStep) ? d.onboardingStep : defaults.onboardingStep,
    licencesSeen: bool(d.licencesSeen, defaults.licencesSeen),
    hardware: hardwareResult(d.hardware),
    autoUpdate: bool(d.autoUpdate, defaults.autoUpdate),
    vocabulary: vocab ? normalizeVocabulary(vocab as VocabTerm[]) : defaults.vocabulary,
    vocabularyPending: Array.isArray(d.vocabularyPending) ? parsePending(d.vocabularyPending) : defaults.vocabularyPending,
    agentsEnabled: bool(d.agentsEnabled, defaults.agentsEnabled),
    agentAlertsPaused: bool(d.agentAlertsPaused, defaults.agentAlertsPaused),
    agentChime: bool(d.agentChime, defaults.agentChime),
    // Before 0.1.2 there was no such setting and Dictate always followed Pane; those profiles start off too.
    agentPaneAlerts: bool(d.agentPaneAlerts, defaults.agentPaneAlerts),
    agentHistory: bool(d.agentHistory, defaults.agentHistory),
  };
}

/** DICTATE_MODELS_DIR and DICTATE_LLAMA_SERVER win over the settings file, so tests and scripts can point elsewhere. */
export function applyEnv(s: Settings, env: Record<string, string | undefined>): Settings {
  return {
    ...s,
    modelsDir: env.DICTATE_MODELS_DIR || s.modelsDir,
    llamaServer: env.DICTATE_LLAMA_SERVER || s.llamaServer,
  };
}

/** Preserve the old Windows fallback, without probing a personal folder on a fresh install. */
export function resolveModelsDir(configured: string, exists: (p: string) => boolean): string {
  if (exists(configured)) return configured;
  if (configured === LEGACY_MODELS_DIR && exists(ALT_MODELS_DIR)) return ALT_MODELS_DIR;
  return configured;
}
