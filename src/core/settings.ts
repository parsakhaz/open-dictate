// Settings defaults and loading: whatever the file holds is checked field by field, and anything missing or
// malformed falls back to its default, so an old or hand-edited file never stops the app. Pure.
import { DEFAULT_HISTORY_LIMIT } from './history';
import { DEFAULT_TIMING, VK } from './hotkeys';
import { parseMicPrefs } from './mics';
import type { Binding, CleanupChain, KeySpec, OutputMode, Settings, VocabTerm } from './types';
import { normalizeVocabulary } from './vocabulary';

export const DEFAULT_MODELS_DIR = 'C:\\repos\\experiments\\worktrees\\voice-lab\\voice-lab\\models';
/** A junction to the same files; used when the default folder is missing. */
export const ALT_MODELS_DIR = 'C:\\repos\\voice-lab-app\\models';
export const DEFAULT_LLAMA_SERVER = 'C:\\repos\\experiments\\worktrees\\voice-lab\\voice-lab\\bin\\llama-b11700-vulkan\\llama-server.exe';

export const STT_MODEL = 'sherpa-onnx-nemotron-speech-streaming-en-0.6b-1120ms-int8-2026-04-25';
export const GEMMA_GGUF = 'gemma-4-E2B-it-Q4_K_M.gguf';
export const EMBERON_GGUF = 'Emberon-2-Q4_K_M.gguf';

export function defaultSettings(vocabulary: VocabTerm[] = []): Settings {
  return {
    version: 2,
    hotkey: { keys: [VK.RCtrl] },
    toggle: null,
    picker: { keys: [VK.RCtrl, VK.V] },
    tapMs: DEFAULT_TIMING.tapMs,
    doubleTapMs: DEFAULT_TIMING.doubleTapMs,
    micOrder: [],
    gainDb: {},
    cleanup: 'gemma-emberon',
    output: 'paste',
    sounds: true,
    pillText: true,
    micWarm: 'off',
    liveCleanup: true,
    liveCleanupSet: false,
    livePauseMs: 700,
    historyLimit: DEFAULT_HISTORY_LIMIT,
    modelsDir: DEFAULT_MODELS_DIR,
    llamaServer: DEFAULT_LLAMA_SERVER,
    sttThreads: 4,
    startWithWindows: false,
    batteryUnloadMinutes: 60,
    batteryEmberonOnly: false,
    onboarded: false,
    vocabulary,
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

const str = (x: unknown, d: string) => (typeof x === 'string' && x.trim() ? x : d);
const bool = (x: unknown, d: boolean) => (typeof x === 'boolean' ? x : d);
const num = (x: unknown, d: number, lo: number, hi: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d);

/** Version 1 saved every field, so a 15 there is the old default rather than a choice: it becomes 60. */
function unloadMinutes(d: Record<string, unknown>, defaults: Settings): number {
  const v = num(d.batteryUnloadMinutes, defaults.batteryUnloadMinutes, 0, 24 * 60);
  return (d.version ?? 1) === 1 && v === 15 ? 60 : v;
}

export function parseSettings(data: unknown, defaults: Settings): Settings {
  if (typeof data !== 'object' || data === null) return defaults;
  const d = data as Record<string, unknown>;
  const gainDb: Record<string, number> = {};
  if (typeof d.gainDb === 'object' && d.gainDb !== null) {
    for (const [k, v] of Object.entries(d.gainDb)) if (typeof v === 'number' && Number.isFinite(v)) gainDb[k] = Math.min(40, Math.max(-20, v));
  }
  const vocab = Array.isArray(d.vocabulary) ? d.vocabulary.filter((t) => typeof t?.term === 'string') : null;
  const micOrder = Array.isArray(d.micOrder) ? parseMicPrefs(d.micOrder) : defaults.micOrder;
  return {
    version: 2,
    hotkey: binding(d.hotkey, defaults.hotkey),
    toggle: binding(d.toggle, defaults.toggle),
    picker: binding(d.picker, defaults.picker),
    tapMs: Math.round(num(d.tapMs, defaults.tapMs, 100, 800)),
    doubleTapMs: Math.round(num(d.doubleTapMs, defaults.doubleTapMs, 150, 1000)),
    micOrder,
    gainDb,
    cleanup: CHAINS.includes(d.cleanup as CleanupChain) ? (d.cleanup as CleanupChain) : defaults.cleanup,
    output: OUTPUTS.includes(d.output as OutputMode) ? (d.output as OutputMode) : defaults.output,
    sounds: bool(d.sounds, defaults.sounds),
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
    startWithWindows: bool(d.startWithWindows, defaults.startWithWindows),
    batteryUnloadMinutes: unloadMinutes(d, defaults),
    batteryEmberonOnly: bool(d.batteryEmberonOnly, defaults.batteryEmberonOnly),
    onboarded: bool(d.onboarded, defaults.onboarded),
    vocabulary: vocab ? normalizeVocabulary(vocab as VocabTerm[]) : defaults.vocabulary,
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

/** The models folder to use: the configured one if it exists, else the voice-lab-app junction. */
export function resolveModelsDir(configured: string, exists: (p: string) => boolean): string {
  if (exists(configured)) return configured;
  if (configured === DEFAULT_MODELS_DIR && exists(ALT_MODELS_DIR)) return ALT_MODELS_DIR;
  return configured;
}
