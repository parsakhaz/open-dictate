// After the recognizer's final: cleanup chain, then the output sink, then history. No Electron imports, so the
// integration test drives it with a fake sink.
import { type ChainDeps, type ChainStep, runChain } from '../core/chain';
import { splitPressEnter } from '../core/commands';
import type { HistoryEntry, HistoryStore } from '../core/history';
import type { OutputMode, StepResult } from '../core/types';

export interface Delivery {
  /** Ctrl+V reached the target app. */
  pasted: boolean;
  /** The text is on the clipboard now (clipboard mode, or the fallback when pasting was impossible). */
  copied: boolean;
  /** The paste went to a control known to take text (it shows a caret), or the text was typed. */
  confirmed?: boolean;
  /** Why it was not pasted, for the log. */
  reason?: string;
  /** Enter was pressed after the text ("press enter"). */
  entered?: boolean;
}

export interface DeliverOptions {
  /** Press Enter once the text has landed, to send a chat message ("press enter"). */
  enter?: boolean;
}

export interface OutputSink {
  deliver(text: string, mode: OutputMode, opts?: DeliverOptions): Promise<Delivery>;
}

export type Phase = 'cleaning' | 'delivering';

export interface PipelineDeps {
  chain: ChainDeps;
  sink: OutputSink;
  history: HistoryStore;
  /** Writes history to disk now (synchronously); throws if it cannot. */
  saveHistory: () => void;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Per-step timeout; 3 s by default. */
  stepTimeoutMs?: number;
  /** Replaces the whole-dictation chain: live cleanup, which cleaned most sentences while the person spoke. */
  clean?: (heard: string) => Promise<{ text: string; steps: StepResult[] }>;
  /** "press enter" as the last words presses Enter after the text (the setting, off by default). */
  pressEnter?: boolean;
  /** Esc after release: the cleanup stops and nothing is delivered or saved. */
  signal?: AbortSignal;
}

export interface DictationResult {
  entry?: HistoryEntry;
  delivery?: Delivery;
  steps: StepResult[];
  /** Esc was pressed before the text was delivered. */
  cancelled?: boolean;
}

function persist(deps: PipelineDeps): void {
  try {
    deps.saveHistory();
  } catch (err) {
    deps.log('error', `could not save history: ${(err as Error).message}`);
  }
}

let seq = 0;
export function newId(now = Date.now()): string {
  return `${now.toString(36)}-${(++seq).toString(36)}`;
}

/**
 * Every dictation ends with a space, so the next one does not run into it ("logs.Deploy"). Not when the text
 * already ends in whitespace, or in an opening bracket or curly quote that the next words belong to (a straight
 * quote could be closing one, as in "the users'", so it gets the space). The character
 * after the cursor in the target app cannot be read, so a space before typed punctuation is the trade-off.
 */
export function withTrailingSpace(text: string): string {
  return !text || /[\s([{“‘]$/.test(text) ? text : `${text} `;
}

/** Cleans `raw` and delivers it. `releasedAt` (performance.now() at key release) times the whole trip. */
export async function finishDictation(raw: string, steps: ChainStep[], mode: OutputMode, releasedAt: number, deps: PipelineDeps, onPhase: (p: Phase) => void = () => undefined): Promise<DictationResult> {
  const said = raw.trim();
  if (!said) return { steps: [] };
  const { text: heard, enter } = deps.pressEnter ? splitPressEnter(said) : { text: said, enter: false };
  if (steps.length) onPhase('cleaning');
  const cleaned = deps.clean ? await deps.clean(heard) : await runChain(heard, steps, deps.chain, { timeoutMs: deps.stepTimeoutMs ?? 3000, signal: deps.signal });
  if (deps.signal?.aborted) return { steps: cleaned.steps, cancelled: true };
  for (const s of cleaned.steps) if (s.status !== 'ok') deps.log('warn', `cleanup ${s.model} ${s.status}${s.reason ? `: ${s.reason}` : ''}`);
  // The cleanup may have kept the command as words ("Press Enter."): it never reaches the app as text.
  const text = enter ? splitPressEnter(cleaned.text).text : cleaned.text;
  onPhase('delivering');
  // Into history, on disk, before delivery: if delivery hangs or the app quits mid-paste, the words are kept.
  const entry: HistoryEntry = { id: newId(), at: new Date().toISOString(), raw: heard, text };
  deps.history.add(entry);
  persist(deps);
  let delivery: Delivery;
  try {
    // Before Enter, no trailing space: it would be sent with the message.
    delivery = enter ? await deps.sink.deliver(text, mode, { enter }) : await deps.sink.deliver(withTrailingSpace(text), mode);
  } catch (err) {
    delivery = { pasted: false, copied: false, reason: (err as Error).message };
    deps.log('error', `delivery failed: ${(err as Error).message}`);
  }
  entry.ms = Math.round(performance.now() - releasedAt);
  persist(deps);
  deps.log(
    'info',
    `dictation ${entry.ms} ms release-to-output · ${cleaned.steps.map((s) => `${s.model} ${s.status} ${s.ms.toFixed(0)} ms`).join(' · ') || 'no cleanup'} · ${delivery.pasted ? 'pasted' : delivery.copied ? 'copied' : 'not delivered'}${delivery.entered ? ' + Enter' : ''}${delivery.reason ? ` (${delivery.reason})` : ''}`,
  );
  return { entry, delivery, steps: cleaned.steps };
}
