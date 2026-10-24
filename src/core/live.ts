// "Clean up as I speak": finished sentences are cleaned while the person is still talking, so at release only
// the last one is left. The Segmenter decides when a sentence of the streaming transcript is finished and will
// not change; LiveCleanup runs them one at a time, in order, each with the earlier ones as context, and at
// release cleans the remainder and joins the pieces. Pure apart from the injected chain runner.
import { RELEASE_STEP_MS, type Turn } from './chain';
import type { StepResult } from './types';

export interface SentenceSpan {
  raw: string;
  /** Character offsets in the transcript. */
  start: number;
  end: number;
}

export interface SegmenterOptions {
  /** A sentence must stay unchanged this long, with the next one started, before it is sent. */
  stableMs: number;
  /** The fallback split: speech silent at least this long… */
  pauseMs: number;
  /** …and the transcript unchanged for one recognizer chunk, so the words before the pause are in it. */
  chunkMs: number;
}

export const DEFAULT_SEGMENTER: SegmenterOptions = { stableMs: 300, pauseMs: 700, chunkMs: 1200 };

/** Sentence end: . ? ! (and a closing quote or bracket), followed by the start of the next sentence. */
const SENTENCE_END = /[.?!]+["”’)]?(?=\s+\S)/;

export class Segmenter {
  readonly committed: SentenceSpan[] = [];
  private text = '';
  private changedAt = 0;
  private candidate: { raw: string; end: number; since: number } | null = null;
  private silentSince: number | null = null;
  private pauseUsed = false;
  private revisedSpans: SentenceSpan[] = [];

  constructor(private readonly opts: SegmenterOptions = DEFAULT_SEGMENTER) {}

  /** The recognizer's whole transcript so far, at time `t` (ms). Returns sentences newly committed. */
  update(text: string, t: number): SentenceSpan[] {
    if (text !== this.text) {
      this.text = text;
      this.changedAt = t;
      this.pauseUsed = false;
    }
    // A committed sentence the recognizer has since changed is withdrawn, with everything after it.
    const bad = this.committed.findIndex((s) => text.slice(s.start, s.end) !== s.raw);
    if (bad >= 0) {
      this.revisedSpans.push(...this.committed.splice(bad));
      this.candidate = null;
    }
    return this.scan(t);
  }

  /** Audio has been silent since `since` (ms), or null when there is sound. */
  silence(since: number | null): void {
    this.silentSince = since;
  }

  /** Time passing with no new transcript: the pause fallback. */
  tick(t: number): SentenceSpan[] {
    const out = this.scan(t);
    if (this.silentSince === null || this.pauseUsed) return out;
    if (t - this.silentSince < this.opts.pauseMs || t - this.changedAt < this.opts.chunkMs) return out;
    const base = this.end;
    const tail = this.text.slice(base);
    const raw = tail.trim();
    if (!raw) return out;
    this.pauseUsed = true;
    const start = base + tail.indexOf(raw);
    const s = { raw, start, end: start + raw.length };
    this.committed.push(s);
    this.candidate = null;
    return [...out, s];
  }

  /** Committed sentences withdrawn since the last call (the recognizer revised them). */
  takeRevised(): SentenceSpan[] {
    return this.revisedSpans.splice(0);
  }

  private get end(): number {
    return this.committed.at(-1)?.end ?? 0;
  }

  private scan(t: number): SentenceSpan[] {
    const base = this.end;
    const tail = this.text.slice(base);
    const m = SENTENCE_END.exec(tail);
    if (!m) {
      this.candidate = null;
      return [];
    }
    const start = base + (tail.length - tail.trimStart().length);
    const end = base + m.index + m[0].length;
    const raw = this.text.slice(start, end);
    if (!this.candidate || this.candidate.raw !== raw || this.candidate.end !== end) {
      this.candidate = { raw, end, since: t };
      return [];
    }
    if (t - this.candidate.since < this.opts.stableMs) return [];
    const s = { raw, start, end };
    this.committed.push(s);
    this.candidate = null;
    return [s, ...this.scan(t)];
  }
}

export interface PieceResult {
  text: string;
  steps: StepResult[];
  turns: Turn[];
}

/** Runs the cleanup chain on one piece, with the earlier pieces' turns as context; `capMs` after release. */
export type PieceRunner = (raw: string, context: Turn[], signal: AbortSignal, capMs?: number) => Promise<PieceResult>;

interface Job {
  span: SentenceSpan;
  ctrl: AbortController;
  dropped: boolean;
  result: Promise<PieceResult | null>;
  done?: PieceResult;
}

export class LiveCleanup {
  private readonly jobs: Job[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private cancelled = false;
  private redone = 0;

  constructor(private readonly run: PieceRunner) {}

  private contextBefore(job: Job | null): Turn[] {
    const out: Turn[] = [];
    for (const j of this.jobs) {
      if (j === job) break;
      if (!j.dropped && j.done) out.push(...j.done.turns);
    }
    return out;
  }

  /** Sentences the Segmenter committed: queued, in order. */
  committed(spans: SentenceSpan[]): void {
    for (const span of spans) {
      const job: Job = { span, ctrl: new AbortController(), dropped: false, result: Promise.resolve(null) };
      job.result = this.queue.then(async () => {
        if (job.dropped || this.cancelled) return null;
        const r = await this.run(span.raw, this.contextBefore(job), job.ctrl.signal);
        if (!job.dropped) job.done = r;
        return r;
      });
      this.queue = job.result.catch(() => null);
      this.jobs.push(job);
    }
  }

  /** Sentences the recognizer revised after they were sent: their results are thrown away. */
  revised(spans: SentenceSpan[]): void {
    for (const s of spans) {
      const job = this.jobs.find((j) => !j.dropped && j.span.start === s.start && j.span.raw === s.raw);
      if (job) this.drop(job);
    }
  }

  private drop(job: Job): void {
    job.dropped = true;
    job.ctrl.abort();
    this.redone++;
  }

  /** Esc: everything stops, including requests in flight. */
  cancel(): void {
    this.cancelled = true;
    for (const j of this.jobs) j.ctrl.abort();
  }

  /**
   * At release, with the recognizer's final transcript: keeps the early sentences that still match it, cleans
   * the remainder with them as context, and joins the pieces with single spaces.
   */
  async finish(final: string): Promise<{ text: string; steps: StepResult[]; early: number; redone: number }> {
    if (this.cancelled) throw new Error('cancelled');
    let keptEnd = 0;
    let mismatch = false;
    for (const j of this.jobs) {
      if (j.dropped) continue;
      if (mismatch || final.slice(j.span.start, j.span.end) !== j.span.raw) {
        mismatch = true;
        this.drop(j);
      } else keptEnd = j.span.end;
    }
    await this.queue;
    if (this.cancelled) throw new Error('cancelled');
    const kept = this.jobs.filter((j) => !j.dropped && j.done);
    const pieces = kept.map((j) => j.done!.text.trim());
    const steps = kept.flatMap((j) => j.done!.steps);
    const rest = final.slice(keptEnd).trim();
    if (rest) {
      const ctrl = new AbortController();
      const r = await this.run(rest, this.contextBefore(null), ctrl.signal, RELEASE_STEP_MS);
      if (this.cancelled) throw new Error('cancelled');
      pieces.push(r.text.trim());
      steps.push(...r.steps);
    }
    return { text: pieces.filter(Boolean).join(' '), steps, early: kept.length, redone: this.redone };
  }
}
