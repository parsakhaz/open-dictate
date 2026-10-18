// The cleanup chain: each step cleans the previous step's text; a step that fails, times out or fails the
// guard leaves the previous text in place, so the transcript is never lost. Pure apart from the injected calls.
import { checkOutput } from './guard';
import { chatRequest, cleanupMaxTokens, EMBERON_SYSTEM, fillTemplate, plainText } from './templating';
import { type CleanupChain, DEFAULT_GUARD, type GuardThresholds, type StepResult, type VocabTerm } from './types';

export type CleanupModel = 'gemma' | 'emberon';

export interface ChainStep {
  model: CleanupModel;
  system: string;
}

export interface ChainDeps {
  /** Resolves true once the model's server can take a request; false if it is not running at all. */
  ready: (model: CleanupModel) => Promise<boolean>;
  /** Sends one chat request and returns the reply's content. */
  complete: (model: CleanupModel, body: Record<string, unknown>, signal: AbortSignal) => Promise<string>;
}

export interface ChainOptions {
  timeoutMs?: number;
  guard?: GuardThresholds;
}

/** Gemma with prompt v3 goes first: run the other way round, Emberon mangles names such as "Doozy". */
export function stepsFor(chain: CleanupChain, v3Template: string, vocab: VocabTerm[]): ChainStep[] {
  const gemma: ChainStep = { model: 'gemma', system: fillTemplate(v3Template, vocab) };
  const emberon: ChainStep = { model: 'emberon', system: EMBERON_SYSTEM };
  if (chain === 'gemma') return [gemma];
  if (chain === 'emberon') return [emberon];
  if (chain === 'gemma-emberon') return [gemma, emberon];
  return [];
}

class Timeout extends Error {}

/**
 * A step's time budget: `base` (3 s) covers any short dictation; a long one also gets time to generate its
 * output (~15 ms a token on the iGPU), so a 2-minute dictation is cleaned instead of timing out.
 */
export function stepTimeout(base: number, input: string): number {
  return base + Math.max(0, cleanupMaxTokens(input) - 128) * 15;
}

export async function runChain(raw: string, steps: ChainStep[], deps: ChainDeps, opts: ChainOptions = {}): Promise<{ text: string; steps: StepResult[] }> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  let text = raw.trim();
  const results: StepResult[] = [];
  if (!text) return { text, steps: results };
  for (const step of steps) {
    if (!(await deps.ready(step.model))) {
      results.push({ model: step.model, status: 'skipped', ms: 0, reason: 'not running' });
      continue;
    }
    const t0 = performance.now();
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = stepTimeout(timeoutMs, text);
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        reject(new Timeout());
      }, budget);
    });
    try {
      const content = await Promise.race([deps.complete(step.model, chatRequest(step.system, text), ctrl.signal), timedOut]);
      const out = plainText(content);
      const ms = performance.now() - t0;
      const guard = out ? checkOutput(text, out, opts.guard ?? DEFAULT_GUARD) : { ok: false, reason: 'empty reply' };
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
    }
  }
  return { text, steps: results };
}
