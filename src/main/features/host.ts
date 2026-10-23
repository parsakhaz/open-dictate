// The contract between main.ts and each surface feature (one per lane, in this folder). A feature gets everything it
// needs through FeatureHost and registers what it adds: tool handlers and card kinds with the hub, a route for its
// key's words, its shortcuts, its IPC, its QA commands and its part of the Settings state. Nothing a lane builds
// should need a line in main.ts, agenthub.ts or another shared file; if it does, that is a seams defect to report.
import type { BrowserWindow } from 'electron';
import type { AgentHub } from '../../core/agenthub';
import type { ShortcutName } from '../../core/hotkeys';
import type { Settings } from '../../core/types';
import type { Agents } from '../agents';
import type { Logger } from '../log';
import type { Orchestrator } from '../orchestrator';
import type { Sheet } from '../sheet';

export type FeatureName = 'decide' | 'inbox' | 'voice' | 'lineup' | 'peek' | 'point';

/**
 * Where a finished recording goes when its key (the agent key, the point key, the dictation key it takes) named
 * this route, instead of being pasted. Registered under the route's name; the agent and point keys are bound only
 * once their route is registered.
 */
export interface Route {
  /** What the pill says while recording, e.g. "To Voice orchestrator". */
  label: string;
  /** How this recording ends, for the pill's first-use hint ("Release to finish" otherwise). */
  finish?: string;
  /** The recording started (point and say looks under the pointer here). */
  began?(id: number): void;
  /** Cancelled before anything was said or sent: a tap, Esc, another key. */
  cancelled?(id: number): void;
  /**
   * The cleaned words (and the raw transcript). The route previews, reviews or sends them itself (host.preview is
   * the usual 2 s look); what it returns is what the pill says afterwards.
   */
  deliver(text: string, raw: string, id: number): Promise<{ ok: boolean; message: string }>;
  /** While true, the dictation key records for this route instead of pasting (the round's, while it is open). */
  takesDictation?(): boolean;
}

/** The card a dictation answers, and how the pill names it ("Replying to <to>…"). */
export interface ReplyTarget {
  cardId: string;
  to: string;
}

export interface Shortcut {
  /** The key is taken from other apps right now (a card is up). Asked whenever bindings are applied. */
  claimed(): boolean;
  pressed(): void;
}

export interface FeatureHost {
  log: Logger;
  /** The data folder (captures go under <userData>/agents/captures). */
  userData: string;
  settings(): Settings;
  /** Saves and applies a settings change, as the Settings window does. */
  update(patch: Partial<Settings>): void;
  /** The agents' hub: handle(tool), cardKind(kind), raise, wait, settle, extendStatus, the queue. */
  hub: AgentHub;
  /** The rest of the agents wiring: Pane (agents.pane), rendering the cards (agents.render). */
  agents: Agents;
  /** The shared sheet window. */
  sheet: Sheet;
  pill: {
    send(channel: string, ...args: unknown[]): void;
    show(): void;
    /** The pointer is over the top card right now. */
    pointerOverCard(): boolean;
  };
  /** Dictate's own windows (point and say keeps them out of its crops). */
  windows(): BrowserWindow[];
  /** The usual 2 s look at words before they go to an agent; false when the person pressed Esc. */
  preview(to: string, text: string): Promise<boolean>;
  /**
   * Asked at each dictation key's key-down, before the usual rule (the pointer over the top card, or Reply): which
   * card this dictation answers, e.g. the round's current card or the card whose sheet is under the pointer. Null
   * when it isn't this feature's; the first answer wins. The words then reach the card's kind handler (`reply`).
   */
  replyTarget(fn: () => ReplyTarget | null): void;
  route(name: string, route: Route): void;
  /** Records for a route without its key (QA's voice down/up, point and say's own cancel). cancel() is quiet (the pill just hides); the person's Esc says "Cancelled". */
  recording: { start(route: string): void; stop(): void; cancel(): void; active(): boolean };
  shortcut(name: ShortcutName, s: Shortcut): void;
  /** A shortcut's claim may have changed: bindings go to the key hook again. */
  bindingsChanged(): void;
  /** Every key-down's time (performance.now()), never which key: the flow guard's typing signal. */
  onKeyDown(cb: (t: number) => void): void;
  /** Send to the Voice orchestrator: L3 provides it, L6 uses it. */
  orchestrator(): Orchestrator;
  provideOrchestrator(o: Orchestrator): void;
  /** IPC for this feature's pages, on `dictate:<feature>:<name>`. */
  ipc: {
    handle(name: string, fn: (...args: unknown[]) => unknown): void;
    on(name: string, fn: (...args: unknown[]) => void): void;
  };
  /** QA control file lines `<feature> <rest>` go to `fn(rest)`. */
  qa(fn: (line: string) => void): void;
  /** This feature's part of the Settings window's state, as `state.surfaces[<feature>]`. */
  state(fn: () => unknown): void;
  /** Something that state shows changed. */
  stateChanged(): void;
}

export interface Feature {
  name: FeatureName;
  /** Before the app is ready, for what Electron allows only then (peek's privileged protocol scheme). */
  beforeReady?(): void;
  /** Called once at start-up, after the agents' hub and the windows exist. */
  setup(host: FeatureHost): void;
  /** Dictate is quitting. */
  stop?(): void;
}
