// Shared types and defaults. Pure; browser-safe.
import type { MicPref } from './mics';

export const SAMPLE_RATE = 16000;

export interface VocabTerm {
  term: string;
  /** What the recognizer may write instead ("sounds-like" pairs). */
  aliases?: string[];
}

export interface VocabularyFile {
  version: 1;
  seed?: number;
  terms: VocabTerm[];
}

export interface GuardThresholds {
  maxLengthRatio: number;
  minLengthRatio: number;
  minWordOverlap: number;
}

/** voice-lab's measured defaults. */
export const DEFAULT_GUARD: GuardThresholds = { maxLengthRatio: 1.5, minLengthRatio: 0.6, minWordOverlap: 0.6 };

export interface GuardResult {
  ok: boolean;
  lengthRatio: number;
  wordOverlap: number;
  reason?: string;
}

/** Either side of a modifier ('ctrl') or one exact Windows virtual-key code (0xA3 = Right Ctrl). */
export type KeySpec = number | 'ctrl' | 'shift' | 'alt' | 'meta';

export interface Binding {
  keys: KeySpec[];
}

export type CleanupChain = 'off' | 'emberon' | 'gemma' | 'gemma-emberon';
export type OutputMode = 'paste' | 'clipboard' | 'both';

export interface Settings {
  /** 2: batteryUnloadMinutes defaults to 60 (a version-1 file's 15 was the old default and is migrated). */
  version: 2;
  /** Hold for push-to-talk, double-tap to toggle. */
  hotkey: Binding | null;
  /** Optional extra combo that toggles recording; off by default. */
  toggle: Binding | null;
  /** Opens the history picker. */
  picker: Binding | null;
  tapMs: number;
  doubleTapMs: number;
  /** Preferred microphones, most preferred first; empty = the system default. */
  micOrder: MicPref[];
  /** Input gain per micKey(label); a mic missing here gets defaultGainDb(label). */
  gainDb: Record<string, number>;
  cleanup: CleanupChain;
  output: OutputMode;
  sounds: boolean;
  /** How long the mic stays open after a dictation, so a follow-up starts instantly. */
  micWarm: 'off' | '30s' | 'always';
  /** Clean finished sentences while the person is still speaking. */
  liveCleanup: boolean;
  /** Live cleanup's fallback sentence split: a pause at least this long. */
  livePauseMs: number;
  historyLimit: number;
  modelsDir: string;
  llamaServer: string;
  sttThreads: number;
  startWithWindows: boolean;
  /** On battery: unload the LLMs after this many idle minutes; 0 = never. */
  batteryUnloadMinutes: number;
  /** On battery: use Emberon only, whatever `cleanup` says. */
  batteryEmberonOnly: boolean;
  /** The welcome screen has been seen. */
  onboarded: boolean;
  vocabulary: VocabTerm[];
}

export interface StepResult {
  model: string;
  status: 'ok' | 'rejected' | 'error' | 'timeout' | 'skipped';
  ms: number;
  reason?: string;
}
