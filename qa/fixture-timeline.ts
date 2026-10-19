// The real recognizer's live words for a WAV, in real time, then the real cleanup of the final text: the
// timeline the README demo replays into the pill. Run through qa/fixture-timeline.mjs, which bundles this file.
import fs from 'node:fs';
import path from 'node:path';
import { type ChainDeps, type CleanupModel, runChain, stepsFor } from '../src/core/chain';
import { EMBERON_GGUF, GEMMA_GGUF, STT_MODEL } from '../src/core/settings';
import { chatRequest } from '../src/core/templating';
import { LlamaServer } from '../src/engine/llama';
import type { SherpaModule } from '../src/engine/sherpaTypes';
import { Stt } from '../src/engine/stt';
import { readWav } from '../src/engine/wav';

const root = process.env.DICTATE_QA_ROOT ?? '.';
const models = process.env.DICTATE_MODELS_DIR ?? '';
const wav = process.env.DICTATE_QA_WAV ?? path.join(root, 'fixtures', 'two-sentences.wav');
const exe = process.env.DICTATE_LLAMA_SERVER ?? '';

void (async () => {
  const sherpa = require('sherpa-onnx-node') as SherpaModule;
  const stt = new Stt(sherpa, path.join(models, STT_MODEL), 4);
  stt.load();
  const { samples, sampleRate } = readWav(wav);
  stt.begin();
  const partials: { t: number; text: string }[] = [];
  let last = '';
  // 100 ms frames, timed as the audio would arrive.
  for (let i = 0; i < samples.length; i += sampleRate / 10) {
    const p = stt.accept(samples.slice(i, i + sampleRate / 10));
    if (p && p !== last) partials.push({ t: +(i / sampleRate + 0.1).toFixed(2), text: (last = p) });
  }
  const { text: raw, flushMs } = stt.finish();
  const out: Record<string, unknown> = { wav: path.basename(wav), seconds: +(samples.length / sampleRate).toFixed(2), partials, raw, flushMs: Math.round(flushMs) };
  if (exe && fs.existsSync(exe)) {
    const v3 = fs.readFileSync(path.join(root, 'defaults/prompt-v3.txt'), 'utf8');
    const vocab = JSON.parse(fs.readFileSync(path.join(root, 'defaults/vocabulary.json'), 'utf8'));
    // DICTATE_QA_VOCAB adds terms, as a person would in Settings → Vocabulary.
    const extra = JSON.parse(process.env.DICTATE_QA_VOCAB ?? '[]');
    const steps = stepsFor('gemma-emberon', v3, [...(Array.isArray(vocab) ? vocab : (vocab.terms ?? [])), ...extra]);
    out.addedVocabulary = extra;
    const log = () => undefined;
    const servers: Record<CleanupModel, LlamaServer> = {
      gemma: new LlamaServer('gemma', { exe, gguf: path.join(models, GEMMA_GGUF), log, warmup: () => chatRequest(steps[0].system, 'warm up') }),
      emberon: new LlamaServer('emberon', { exe, gguf: path.join(models, EMBERON_GGUF), log, warmup: () => chatRequest(steps[1].system, 'warm up') }),
    };
    try {
      await Promise.all([servers.gemma.start(), servers.emberon.start()]);
      const deps: ChainDeps = { ready: (m) => servers[m].whenReady(60_000), complete: (m, body, signal) => servers[m].complete(body, signal) };
      await runChain(raw, steps, deps);
      const t0 = performance.now();
      const r = await runChain(raw, steps, deps);
      Object.assign(out, { cleaned: r.text, cleanupMs: Math.round(performance.now() - t0), steps: r.steps.map((s) => `${s.model} ${s.status}`) });
    } finally {
      servers.gemma.stop();
      servers.emberon.stop();
    }
  }
  const file = process.env.DICTATE_QA_REPORT;
  if (file) fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})();
