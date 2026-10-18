// "Clean up as I speak", measured: release-to-text with the toggle off and on for short, medium and long WAVs
// streamed in real time, and accuracy of whole-dictation versus per-sentence cleanup. Real recognizer and
// llama-servers; runs only with DICTATE_LIVE_BENCH=1 and writes tmp/live-bench.json.
//   DICTATE_LIVE_BENCH=1 pnpm vitest run test/live.bench.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { termHits, wer } from '../../../voice-lab/voice-lab/src/core/scoring';
import { dbfs } from '../src/core/audio';
import { type ChainDeps, runChain, stepsFor } from '../src/core/chain';
import { DEFAULT_SEGMENTER, LiveCleanup, Segmenter } from '../src/core/live';
import { DEFAULT_LLAMA_SERVER, DEFAULT_MODELS_DIR, EMBERON_GGUF, GEMMA_GGUF, resolveModelsDir, STT_MODEL } from '../src/core/settings';
import { chatRequest } from '../src/core/templating';
import type { StepResult, VocabTerm } from '../src/core/types';
import { parseVocabularyFile } from '../src/core/vocabulary';
import { LlamaServer } from '../src/engine/llama';
import type { SherpaModule } from '../src/engine/sherpaTypes';
import { Stt } from '../src/engine/stt';
import { readWav } from '../src/engine/wav';

const root = path.join(__dirname, '..');
const VL = path.join(root, '..', '..', 'voice-lab', 'voice-lab');
const models = resolveModelsDir(process.env.DICTATE_MODELS_DIR || DEFAULT_MODELS_DIR, fs.existsSync);
const exe = process.env.DICTATE_LLAMA_SERVER || DEFAULT_LLAMA_SERVER;
const on = !!process.env.DICTATE_LIVE_BENCH;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the recognizer makes of a term: a known mishearing, else its words in lower case ("click house"). */
function misheard(t: VocabTerm): string {
  const alias = t.aliases?.find((a) => a.toLowerCase() !== t.term.toLowerCase());
  return alias ?? t.term.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[.-]/g, ' ').toLowerCase();
}

function degrade(text: string, vocab: VocabTerm[]): string {
  let out = text;
  for (const t of [...vocab].sort((a, b) => b.term.length - a.term.length)) out = out.split(t.term).join(misheard(t));
  return out;
}

/** Sentences as the Segmenter would commit them, all but the last (which is cleaned at release). */
function spans(raw: string): { raw: string; start: number; end: number }[] {
  const out: { raw: string; start: number; end: number }[] = [];
  const re = /[.?!]+["”’)]?(?=\s+\S)/g;
  let start = 0;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    const end = m.index + m[0].length;
    const s = raw.slice(start, end);
    const lead = s.length - s.trimStart().length;
    out.push({ raw: s.trim(), start: start + lead, end });
    start = end;
  }
  return out;
}

describe.skipIf(!on)('live cleanup benchmark', () => {
  const vocab = parseVocabularyFile(fs.readFileSync(path.join(root, 'defaults/vocabulary.json'), 'utf8')).terms;
  const steps = stepsFor('gemma-emberon', fs.readFileSync(path.join(root, 'defaults/prompt-v3.txt'), 'utf8'), vocab);
  const servers = {
    gemma: new LlamaServer('gemma', { exe, gguf: path.join(models, GEMMA_GGUF), log: () => undefined, warmup: () => chatRequest(steps[0].system, 'okay so this is a quick warm up sentence') }),
    emberon: new LlamaServer('emberon', { exe, gguf: path.join(models, EMBERON_GGUF), log: () => undefined, warmup: () => chatRequest(steps[1].system, 'okay so this is a quick warm up sentence') }),
  };
  const chain: ChainDeps = { ready: (m) => servers[m].whenReady(10_000), complete: (m, body, signal) => servers[m].complete(body, signal) };
  const out: Record<string, unknown> = {};

  beforeAll(async () => {
    await Promise.all([servers.gemma.start(), servers.emberon.start()]);
  }, 180_000);
  afterAll(() => {
    servers.gemma.stop();
    servers.emberon.stop();
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tmp', 'live-bench.json'), JSON.stringify(out, null, 2));
  });

  async function whole(raw: string) {
    return runChain(raw, steps, chain);
  }
  async function live(raw: string, withContext = true) {
    const lc = new LiveCleanup((r, context, signal) => runChain(r, steps, chain, { context: withContext ? context : [], signal }));
    lc.committed(spans(raw));
    return lc.finish(raw);
  }

  it('accuracy: per-sentence cleanup with context against whole-dictation cleanup', async () => {
    const bank = (JSON.parse(fs.readFileSync(path.join(VL, 'defaults', 'reference-sentences.json'), 'utf8')) as { sentences: { id: string; text: string }[] }).sentences;
    // Three-sentence dictations from the long and the vocabulary sentences (s09-s30).
    const pool = bank.filter((s) => Number(s.id.slice(1)) >= 9);
    const dictations: { ref: string; raw: string }[] = [];
    for (let i = 0; i + 3 <= pool.length; i += 3) {
      const ref = pool
        .slice(i, i + 3)
        .map((s) => s.text)
        .join(' ');
      dictations.push({ ref, raw: degrade(ref, vocab) });
    }
    const rows: Record<string, unknown>[] = [];
    const zero = () => ({ hits: 0, terms: 0, ok: 0, steps: 0, errs: 0, words: 0, joins: 0, ins: 0, del: 0 });
    const total = { whole: zero(), live: zero(), liveNoContext: zero() };
    for (const d of dictations) {
      for (const mode of ['whole', 'live', 'liveNoContext'] as const) {
        const r = mode === 'whole' ? await whole(d.raw) : await live(d.raw, mode === 'live');
        const th = termHits(d.ref, r.text, vocab);
        const w = wer(d.ref, r.text);
        const st = r.steps as StepResult[];
        const t = total[mode];
        t.hits += th.hits;
        t.terms += th.total;
        t.ok += st.filter((s) => s.status === 'ok').length;
        t.steps += st.length;
        t.errs += w.substitutions + w.deletions + w.insertions;
        t.words += w.refWords;
        t.ins += w.insertions;
        t.del += w.deletions;
        // A sentence end run into the next word: "logs.Deploy".
        t.joins += (r.text.match(/[a-z][.?!][A-Z]/g) ?? []).length;
        rows.push({ mode, ref: d.ref, raw: d.raw, text: r.text, termHits: `${th.hits}/${th.total}`, wer: Number(w.wer.toFixed(3)), steps: st.map((s) => `${s.model} ${s.status}`) });
      }
    }
    const summary = Object.fromEntries(
      Object.entries(total).map(([k, t]) => [k, { termHitRate: +(t.hits / t.terms).toFixed(3), guardPassRate: +(t.ok / t.steps).toFixed(3), wer: +(t.errs / t.words).toFixed(3), insertions: t.ins, deletions: t.del, joins: t.joins, terms: t.terms, steps: t.steps }]),
    );
    out.accuracy = { dictations: dictations.length, summary, rows };
    console.log(JSON.stringify(summary, null, 2));
    expect(rows.length).toBe(dictations.length * 3);
  }, 900_000);

  it.skipIf(!!process.env.DICTATE_LIVE_BENCH_ACCURACY_ONLY)('latency: release-to-text, toggle off and on, short / medium / long, streamed in real time', async () => {
    const stt = new Stt(require('sherpa-onnx-node') as SherpaModule, path.join(models, STT_MODEL), 4);
    stt.load();
    const fx = (f: string) => readWav(path.join(VL, 'fixtures', f)).samples;
    const gap = new Float32Array(6400);
    const s1 = fx('synthetic/s1.wav');
    const s2 = fx('synthetic/s2.wav');
    const medium = new Float32Array(s1.length + gap.length + s2.length);
    medium.set(s1);
    medium.set(s2, s1.length + gap.length);
    const wavs = { short: s1, medium, long: fx('readaloud/three-sentences.wav') };
    const rows: Record<string, unknown>[] = [];
    for (let rep = 0; rep < 2; rep++) {
      for (const [name, samples] of Object.entries(wavs)) {
        for (const mode of ['off', 'on'] as const) {
          const seg = new Segmenter(DEFAULT_SEGMENTER);
          const lc = new LiveCleanup((r, context, signal) => runChain(r, steps, chain, { context, signal }));
          stt.begin();
          let silentSince: number | null = null;
          const t0 = performance.now();
          for (let i = 0; i < samples.length; i += 1600) {
            const frame = samples.slice(i, i + 1600);
            let sum = 0;
            for (const x of frame) sum += x * x;
            const now = performance.now();
            if (dbfs(Math.sqrt(sum / frame.length)) < -45) silentSince ??= now;
            else silentSince = null;
            const p = stt.accept(frame);
            if (mode === 'on') {
              if (p !== null) {
                const c = seg.update(p, now);
                lc.revised(seg.takeRevised());
                lc.committed(c);
              }
              seg.silence(silentSince);
              lc.committed(seg.tick(now));
            }
            // Real time: one 100 ms frame per 100 ms.
            const due = t0 + ((i + 1600) / 16000) * 1000;
            await sleep(Math.max(0, due - performance.now()));
          }
          const released = performance.now();
          const { text: final, flushMs } = stt.finish();
          const r = mode === 'on' ? await lc.finish(final.trim()) : { ...(await whole(final.trim())), early: 0, redone: 0 };
          const ms = performance.now() - released;
          rows.push({ name, mode, rep, seconds: +(samples.length / 16000).toFixed(1), releaseToTextMs: Math.round(ms), flushMs: Math.round(flushMs), early: r.early, redone: r.redone, steps: r.steps.map((s) => `${s.model} ${s.status} ${Math.round(s.ms)}`), text: r.text });
          console.log(name, mode, Math.round(ms), 'ms', `early ${r.early} redone ${r.redone}`);
          await sleep(500);
        }
      }
    }
    out.latency = rows;
    expect(rows.length).toBe(12);
  }, 900_000);
});
