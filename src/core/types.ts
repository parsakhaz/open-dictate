// Shared types and defaults. Pure; browser-safe.
import type { MicPref } from './mics';
import type { DecideSettings } from './sections/decide';
import type { InboxSettings } from './sections/inbox';
import type { PeekSettings } from './sections/peek';
import type { PointSettings } from './sections/point';
import type { SnoozeSettings } from './sections/snooze';
import type { VoiceSettings } from './sections/voice';
import type { PendingTerm } from './vocabproposals';

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
export const PILL_POSITIONS = ['bottom-center', 'bottom-left', 'bottom-right', 'top-left', 'top-center', 'top-right'] as const;
/** Where on the screen the pill sits; its cards, the "N waiting" count, toasts and the sheet open from it. */
export type PillPosition = (typeof PILL_POSITIONS)[number];

export interface HardwareResult {
  /** One plain sentence: the PC, and how fast cleanup ran on it. */
  summary: string;
  /** The chain the measurement chose (D10). */
  chain: CleanupChain;
  emberonMs: number | null;
  gemmaChainMs: number | null;
  /** Worth offering the optional Gemma download on this PC. */
  offerGemma: boolean;
  measuredAt: string;
}

export interface Settings {
  /** 2: batteryUnloadMinutes defaults to 60 (a version-1 file's 15 was the old default and is migrated). */
  version: 2;
  /** Dictation keys, up to 4 (Right Alt on the keyboard, F13 on a mouse): hold for push-to-talk, double-tap to toggle. */
  hotkeys: Binding[];
  /** Optional extra combo that toggles recording; off by default. */
  toggle: Binding | null;
  /** Opens the history picker. */
  picker: Binding | null;
  /** Toggle accelerator offered by the desktop portal on Wayland. */
  portableShortcut: string;
  portableShortcutEnabled: boolean;
  tapMs: number;
  doubleTapMs: number;
  /** Preferred microphones, most preferred first; empty = the system default. */
  micOrder: MicPref[];
  /** Automatic gain: speech is brought towards a normal level, up to gainDb ("Maximum boost"). Off: gainDb is a fixed gain. */
  autoGain: boolean;
  /** Input gain per micKey(label), the maximum boost with autoGain; a mic missing here gets defaultGainDb(label, autoGain). */
  gainDb: Record<string, number>;
  /** The gain automatic gain had reached at the end of the last dictation on each mic, so the next one starts there. */
  agcGainDb: Record<string, number>;
  cleanup: CleanupChain;
  output: OutputMode;
  sounds: boolean;
  /** "press enter" as the last words of a dictation presses Enter after the text; off by default. */
  pressEnter: boolean;
  /** Show the live words in the pill; off leaves just the waveform. */
  pillText: boolean;
  pillPosition: PillPosition;
  /** How long the mic stays open after a dictation, so a follow-up starts instantly. */
  micWarm: 'off' | '30s' | 'always';
  /** The person chose micWarm themselves; otherwise it follows the default (Always while plugged in since 2026-10-23; it was Off). */
  micWarmSet: boolean;
  /** Clean finished sentences while the person is still speaking. */
  liveCleanup: boolean;
  /** The person chose liveCleanup themselves; otherwise it follows the default (On since 2026-10-18; it was Off). */
  liveCleanupSet: boolean;
  /** Live cleanup's fallback sentence split: a pause at least this long. */
  livePauseMs: number;
  historyLimit: number;
  modelsDir: string;
  llamaServer: string;
  sttThreads: number;
  /** Start when the person signs in on the current OS. */
  startAtLogin: boolean;
  /** Legacy field retained for settings saved by the Windows-only app. */
  startWithWindows: boolean;
  /** On battery: unload the LLMs after this many idle minutes; 0 = never. */
  batteryUnloadMinutes: number;
  /** On battery: use Emberon only, whatever `cleanup` says. */
  batteryEmberonOnly: boolean;
  /** The first-run walkthrough was finished (or the old welcome page was). */
  onboarded: boolean;
  /** Where the walkthrough resumes after a quit; also where "Getting started" reopens it. */
  onboardingStep: string;
  /** The models and licences step was shown. */
  licencesSeen: boolean;
  /** Check GitHub Releases for updates (C6); installs on quit or when idle where the build can. */
  autoUpdate: boolean;
  /** The last hardware check, shown in the walkthrough and Settings → Cleanup. */
  hardware: HardwareResult | null;
  vocabulary: VocabTerm[];
  /** Terms coding agents suggested, waiting for the person's review; none reach the prompt until approved. */
  vocabularyPending: PendingTerm[];
  /** Claude Code, Codex and Cursor get Dictate's tools on launch ("Let coding agents use Dictate"). */
  agentsEnabled: boolean;
  /** "Pause agent alerts": cards are held and counted in the tray. */
  agentAlertsPaused: boolean;
  /** One soft chime when a card that needs the person appears. */
  agentChime: boolean;
  /** "Show Pane's agent alerts on the pill": Dictate follows Pane's blocked and finished tabs. Off by default, so Pane keeps its own notifications. */
  agentPaneAlerts: boolean;
  /** Agents may ask to read dictation history, with consent on the pill each time. Off by default. */
  agentHistory: boolean;
  /** The surfaces' own sections of Settings → Agents, each defined and checked in src/core/sections/. */
  inbox: InboxSettings;
  snooze: SnoozeSettings;
  voice: VoiceSettings;
  peek: PeekSettings;
  point: PointSettings;
  decide: DecideSettings;
}

export interface StepResult {
  model: string;
  status: 'ok' | 'rejected' | 'error' | 'timeout' | 'skipped';
  ms: number;
  reason?: string;
}
