// The cleanup chain: each step cleans the previous step's text; a step that fails, times out or fails the
// guard leaves the previous text in place, so the transcript is never lost. Pure apart from the injected calls.
import { checkOutput } from './guard';
import { chatRequest, cleanupMaxTokens, EMBERON_SYSTEM, fillTemplate, plainText } from './templating';
import { type CleanupChain, DEFAULT_GUARD, type GuardThresholds, type StepResult, type VocabTerm } from './types';

export type CleanupModel = 'gemma' | 'emberon';

export interface ChainStep {
  model: CleanupModel;
  system: string;
  /** Canonical terms already present in the input must survive cleanup unchanged. */
  preserveTerms?: string[];
}

export interface ChainDeps {
  /** Resolves true once the model's server can take a request; false if it is not running at all. */
  ready: (model: CleanupModel) => Promise<boolean>;
  /** Sends one chat request and returns the reply's content. */
  complete: (model: CleanupModel, body: Record<string, unknown>, signal: AbortSignal) => Promise<string>;
}

/** One step's work on one piece of a dictation: what went in and what came out (its input, if it failed). */
export interface Turn {
  model: CleanupModel;
  input: string;
  output: string;
}

export interface ChainOptions {
  timeoutMs?: number;
  guard?: GuardThresholds;
  /** Earlier pieces of the same dictation (live cleanup): each step sees its own earlier turns as chat history. */
  context?: Turn[];
  /** Aborts the whole chain (Esc). */
  signal?: AbortSignal;
}

/** Gemma with prompt v3 goes first: run the other way round, Emberon mangles names such as "Doozy". */
export function stepsFor(chain: CleanupChain, v3Template: string, vocab: VocabTerm[]): ChainStep[] {
  const preserveTerms = vocab.map((v) => v.term);
  const gemma: ChainStep = { model: 'gemma', system: fillTemplate(v3Template, vocab), preserveTerms };
  const emberon: ChainStep = { model: 'emberon', system: EMBERON_SYSTEM, preserveTerms };
  if (chain === 'gemma') return [gemma];
  if (chain === 'emberon') return [emberon];
  if (chain === 'gemma-emberon') return [gemma, emberon];
  return [];
}

class Timeout extends Error {}

function vocabularyProblem(input: string, output: string, terms: string[] = []): string | undefined {
  for (const term of terms) {
    if (!term.trim()) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu');
    if (pattern.test(input) && !pattern.test(output)) return `cleanup changed vocabulary: ${term}`;
  }
  return undefined;
}

/** The most any one cleanup step may take, however long the dictation. */
export const MAX_STEP_MS = 8000;

/**
 * A step's time budget: `base` (3 s) for any dictation up to ~250 characters; a longer one also gets time to
 * generate its output (~15 ms a token on the iGPU), never more than MAX_STEP_MS. Past that the step falls
 * back to its input, as on any timeout.
 */
export function stepTimeout(base: number, input: string): number {
  return Math.min(MAX_STEP_MS, base + Math.max(0, cleanupMaxTokens(input) - 128) * 15);
}

export async function runChain(raw: string, steps: ChainStep[], deps: ChainDeps, opts: ChainOptions = {}): Promise<{ text: string; steps: StepResult[]; turns: Turn[] }> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  let text = raw.trim();
  const results: StepResult[] = [];
  const turns: Turn[] = [];
  if (!text) return { text, steps: results, turns };
  for (const step of steps) {
    if (opts.signal?.aborted) {
      results.push({ model: step.model, status: 'skipped', ms: 0, reason: 'cancelled' });
      continue;
    }
    if (!(await deps.ready(step.model))) {
      results.push({ model: step.model, status: 'skipped', ms: 0, reason: 'not running' });
      continue;
    }
    const t0 = performance.now();
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    opts.signal?.addEventListener('abort', onAbort);
    const input = text;
    const history = (opts.context ?? []).filter((t) => t.model === step.model).map((t) => ({ user: t.input, assistant: t.output }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = stepTimeout(timeoutMs, text);
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        reject(new Timeout());
      }, budget);
    });
    try {
      const content = await Promise.race([deps.complete(step.model, chatRequest(step.system, text, history), ctrl.signal), timedOut]);
      const out = plainText(content);
      const ms = performance.now() - t0;
      const changedTerm = vocabularyProblem(text, out, step.preserveTerms);
      const guard = changedTerm ? { ok: false, reason: changedTerm } : out ? checkOutput(text, out, opts.guard ?? DEFAULT_GUARD) : { ok: false, reason: 'empty reply' };
      if (guard.ok) {
        results.push({ model: step.model, status: 'ok', ms });
        text = out;
      } else {
        results.push({ model: step.model, status: 'rejected', ms, reason: guard.reason });
      }
    } catch (err) {
      const ms = performance.now() - t0;
      if (err instanceof Timeout) results.push({ model: step.model, status: 'timeout', ms, reason: `over ${budget} ms` });
      else results.push({ model: step.model, status: 'error', ms, reason: (err as Error).message });
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
    turns.push({ model: step.model, input, output: text });
  }
  return { text, steps: results, turns };
}
