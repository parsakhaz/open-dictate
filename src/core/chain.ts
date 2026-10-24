// The cleanup chain: each step cleans the previous step's text in bounded chunks; a chunk that fails, times out
// or fails the guard keeps its text, so the transcript is never lost. Pure apart from the injected calls.
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
  /** Resolves true once the model's server can take a request; false if it is not running at all, or not within `maxMs`. */
  ready: (model: CleanupModel, maxMs?: number) => Promise<boolean>;
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
  /** After release: the most any step may take in all, its wait for the server included (RELEASE_STEP_MS). */
  capMs?: number;
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

/** The most a step may take once the key is released: past it, that step's input goes out. */
export const RELEASE_STEP_MS = 2000;

/**
 * A step's time budget: `base` (3 s) for any dictation up to ~250 characters; a longer one also gets time to
 * generate its output (~15 ms a token on the iGPU), never more than MAX_STEP_MS. Past that the step falls
 * back to its input, as on any timeout.
 */
export function stepTimeout(base: number, input: string): number {
  return Math.min(MAX_STEP_MS, base + Math.max(0, cleanupMaxTokens(input) - 128) * 15);
}

/** Each cleanup server's context window in tokens (llama-server `-c`). */
export const CONTEXT_TOKENS = 4096;

/** Cleanup cleans a long text in chunks of about this many characters (±10%), cut at sentence ends. */
const CHUNK_CHARS = 400;

/** Earlier turns a request carries so names stay consistent: the most recent, up to this many characters. */
const CONTEXT_CHARS = 1600;

/** Splits text at sentence ends into chunks of at most 1.1× `target`; a longer sentence is cut at a space. */
export function chunk(text: string, target = CHUNK_CHARS): string[] {
  const max = Math.floor(target * 1.1);
  const out: string[] = [];
  let cur = '';
  for (let sentence of text.trim().split(/(?<=[.?!…])\s+/)) {
    if (cur && cur.length + 1 + sentence.length > max) {
      out.push(cur);
      cur = '';
    }
    while (sentence.length > max) {
      const space = sentence.lastIndexOf(' ', max);
      const cut = space > target * 0.9 ? space : max;
      out.push(sentence.slice(0, cut).trim());
      sentence = sentence.slice(cut).trim();
    }
    cur = cur ? `${cur} ${sentence}` : sentence;
  }
  if (cur) out.push(cur);
  return out;
}

/** A request's size in tokens, generously: ~2.5 characters a token plus a few per message, and its output budget. */
function requestTokens(body: Record<string, unknown>): number {
  const messages = body.messages as { content: string }[];
  return messages.reduce((n, m) => n + Math.ceil(m.content.length / 2.5) + 8, 0) + Number(body.max_tokens ?? 0);
}

/** The request for one chunk, with as many of the most recent turns as fit the context budgets. */
function request(step: ChainStep, input: string, earlier: Turn[]): Record<string, unknown> {
  const history: { user: string; assistant: string }[] = [];
  let chars = 0;
  for (let i = earlier.length - 1; i >= 0; i--) {
    const t = { user: earlier[i].input, assistant: earlier[i].output };
    chars += t.user.length + t.assistant.length;
    if (chars > CONTEXT_CHARS || requestTokens(chatRequest(step.system, input, [t, ...history])) > CONTEXT_TOKENS) break;
    history.unshift(t);
  }
  return chatRequest(step.system, input, history);
}

/**
 * Runs each step over the text, chunk by chunk. A chunk whose request fails, times out or fails the guard
 * keeps its input. With `capMs`, a step stops after that long in all, and its remaining chunks keep their input.
 */
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
    const deadline = performance.now() + (opts.capMs ?? Number.POSITIVE_INFINITY);
    if (!(await deps.ready(step.model, opts.capMs))) {
      results.push({ model: step.model, status: 'skipped', ms: 0, reason: 'not running' });
      continue;
    }
    const earlier = (opts.context ?? []).filter((t) => t.model === step.model);
    const pieces: string[] = [];
    for (const input of chunk(text)) {
      const output = await cleanChunk(step, input, earlier, deps, Math.round(Math.min(stepTimeout(timeoutMs, input), deadline - performance.now())), results, opts);
      const turn = { model: step.model, input, output };
      earlier.push(turn);
      turns.push(turn);
      pieces.push(output);
    }
    text = pieces.join(' ');
  }
  return { text, steps: results, turns };
}

/** One request for one chunk: its cleaned text, or its input when the request or the guard fails. */
async function cleanChunk(step: ChainStep, input: string, earlier: Turn[], deps: ChainDeps, budget: number, results: StepResult[], opts: ChainOptions): Promise<string> {
  if (opts.signal?.aborted) {
    results.push({ model: step.model, status: 'skipped', ms: 0, reason: 'cancelled' });
    return input;
  }
  if (budget <= 0) {
    results.push({ model: step.model, status: 'timeout', ms: 0, reason: 'out of time after release' });
    return input;
  }
  const t0 = performance.now();
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onAbort);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Timeout());
    }, budget);
  });
  try {
    const content = await Promise.race([deps.complete(step.model, request(step, input, earlier), ctrl.signal), timedOut]);
    const out = plainText(content);
    const ms = performance.now() - t0;
    const changedTerm = vocabularyProblem(input, out, step.preserveTerms);
    const guard = changedTerm ? { ok: false, reason: changedTerm } : out ? checkOutput(input, out, opts.guard ?? DEFAULT_GUARD) : { ok: false, reason: 'empty reply' };
    if (guard.ok) {
      results.push({ model: step.model, status: 'ok', ms });
      return out;
    }
    results.push({ model: step.model, status: 'rejected', ms, reason: guard.reason });
  } catch (err) {
    const ms = performance.now() - t0;
    if (err instanceof Timeout) results.push({ model: step.model, status: 'timeout', ms, reason: `over ${budget} ms` });
    else results.push({ model: step.model, status: 'error', ms, reason: (err as Error).message });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
  return input;
}
