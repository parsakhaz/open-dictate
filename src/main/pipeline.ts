// After the recognizer's final: cleanup chain, then the output sink, then history. No Electron imports, so the
// integration test drives it with a fake sink.
import { type ChainDeps, type ChainStep, runChain } from '../core/chain';
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
}

export interface OutputSink {
  deliver(text: string, mode: OutputMode): Promise<Delivery>;
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
}

export interface DictationResult {
  entry?: HistoryEntry;
  delivery?: Delivery;
  steps: StepResult[];
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

/** Cleans `raw` and delivers it. `releasedAt` (performance.now() at key release) times the whole trip. */
export async function finishDictation(raw: string, steps: ChainStep[], mode: OutputMode, releasedAt: number, deps: PipelineDeps, onPhase: (p: Phase) => void = () => undefined): Promise<DictationResult> {
  const heard = raw.trim();
  if (!heard) return { steps: [] };
  if (steps.length) onPhase('cleaning');
  const cleaned = await runChain(heard, steps, deps.chain, { timeoutMs: deps.stepTimeoutMs ?? 3000 });
  for (const s of cleaned.steps) if (s.status !== 'ok') deps.log('warn', `cleanup ${s.model} ${s.status}${s.reason ? `: ${s.reason}` : ''}`);
  onPhase('delivering');
  // Into history, on disk, before delivery: if delivery hangs or the app quits mid-paste, the words are kept.
  const entry: HistoryEntry = { id: newId(), at: new Date().toISOString(), raw: heard, text: cleaned.text };
  deps.history.add(entry);
  persist(deps);
  let delivery: Delivery;
  try {
    delivery = await deps.sink.deliver(cleaned.text, mode);
  } catch (err) {
    delivery = { pasted: false, copied: false, reason: (err as Error).message };
    deps.log('error', `delivery failed: ${(err as Error).message}`);
  }
  entry.ms = Math.round(performance.now() - releasedAt);
  persist(deps);
  deps.log(
    'info',
    `dictation ${entry.ms} ms release-to-output · ${cleaned.steps.map((s) => `${s.model} ${s.status} ${s.ms.toFixed(0)} ms`).join(' · ') || 'no cleanup'} · ${delivery.pasted ? 'pasted' : delivery.copied ? 'copied' : 'not delivered'}${delivery.reason ? ` (${delivery.reason})` : ''}`,
  );
  return { entry, delivery, steps: cleaned.steps };
}
