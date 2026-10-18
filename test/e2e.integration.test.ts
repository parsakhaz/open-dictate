// The whole path after the microphone: a WAV fixture streamed through the real recognizer in 100 ms frames,
// then the cleanup chain, then the output sink (a fake paste) and history; then the history picker choosing
// that entry through the same sink. Cleanup runs on real llama-servers with DICTATE_LLM_TESTS=1, else on a stub.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ChainDeps, stepsFor } from '../src/core/chain';
import { HistoryStore } from '../src/core/history';
import { DEFAULT_LLAMA_SERVER, DEFAULT_MODELS_DIR, EMBERON_GGUF, GEMMA_GGUF, resolveModelsDir, STT_MODEL } from '../src/core/settings';
import { chatRequest } from '../src/core/templating';
import type { OutputMode } from '../src/core/types';
import { parseVocabularyFile } from '../src/core/vocabulary';
import { LlamaServer } from '../src/engine/llama';
import type { SherpaModule } from '../src/engine/sherpaTypes';
import { Stt } from '../src/engine/stt';
import { readWav } from '../src/engine/wav';
import { pickFromHistory } from '../src/main/pick';
import { type Delivery, finishDictation, type OutputSink } from '../src/main/pipeline';

const root = path.join(__dirname, '..');
const models = resolveModelsDir(process.env.DICTATE_MODELS_DIR || DEFAULT_MODELS_DIR, fs.existsSync);
const sttDir = path.join(models, STT_MODEL);
const exe = process.env.DICTATE_LLAMA_SERVER || DEFAULT_LLAMA_SERVER;
const realLlm = !!process.env.DICTATE_LLM_TESTS && fs.existsSync(exe) && fs.existsSync(path.join(models, GEMMA_GGUF)) && fs.existsSync(path.join(models, EMBERON_GGUF));

class FakePaste implements OutputSink {
  readonly pasted: { text: string; mode: OutputMode }[] = [];
  async deliver(text: string, mode: OutputMode): Promise<Delivery> {
    this.pasted.push({ text, mode });
    return { pasted: mode !== 'clipboard', copied: mode !== 'paste' };
  }
}

/** Stand-in cleanup: capitalises "kubernetes" and "clickhouse" the way the vocabulary asks. */
const stubChain: ChainDeps = {
  ready: async () => true,
  complete: async (_m, body) => {
    const msgs = body.messages as { content: string }[];
    return msgs[msgs.length - 1].content.replace(/click house/i, 'ClickHouse');
  },
};

describe.skipIf(!fs.existsSync(sttDir))('WAV fixture -> STT -> cleanup -> output sink -> history picker', () => {
  const vocab = parseVocabularyFile(fs.readFileSync(path.join(root, 'defaults/vocabulary.json'), 'utf8')).terms;
  const steps = stepsFor('gemma-emberon', fs.readFileSync(path.join(root, 'defaults/prompt-v3.txt'), 'utf8'), vocab);
  const servers = realLlm
    ? {
        gemma: new LlamaServer('gemma', { exe, gguf: path.join(models, GEMMA_GGUF), log: () => undefined, warmup: () => chatRequest(steps[0].system, 'warm up') }),
        emberon: new LlamaServer('emberon', { exe, gguf: path.join(models, EMBERON_GGUF), log: () => undefined, warmup: () => chatRequest(steps[1].system, 'warm up') }),
      }
    : null;
  const chain: ChainDeps = servers
    ? { ready: (m) => servers[m].whenReady(10_000), complete: (m, body, signal) => servers[m].complete(body, signal) }
    : stubChain;

  beforeAll(async () => {
    if (servers) await Promise.all([servers.gemma.start(), servers.emberon.start()]);
  }, 180_000);
  afterAll(() => {
    servers?.gemma.stop();
    servers?.emberon.stop();
  });

  it('delivers the cleaned dictation once, keeps it in history, and the picker pastes it again', async () => {
    const stt = new Stt(require('sherpa-onnx-node') as SherpaModule, sttDir, 4);
    stt.load();
    const { samples } = readWav(path.join(root, 'fixtures', 'two-sentences.wav'));
    stt.begin();
    for (let i = 0; i < samples.length; i += 1600) stt.accept(samples.slice(i, i + 1600));

    // Key release: flush, clean, deliver.
    const released = performance.now();
    const { text: raw } = stt.finish();
    const sink = new FakePaste();
    const history = new HistoryStore();
    const result = await finishDictation(raw, steps, 'paste', released, { chain, sink, history, saveHistory: () => undefined, log: () => undefined });
    const ms = performance.now() - released;
    console.log({ raw, text: result.entry?.text, steps: result.steps, releaseToPasteMs: Math.round(ms) });

    expect(raw).toMatch(/Kubernetes/);
    expect(sink.pasted).toHaveLength(1);
    expect(sink.pasted[0].mode).toBe('paste');
    expect(sink.pasted[0].text).toMatch(/ClickHouse/);
    expect(result.steps.every((s) => s.status === 'ok')).toBe(true);
    expect(history.latest()?.raw).toBe(raw);
    // Delivered with a trailing space, so the next dictation does not run into it; history keeps the text.
    expect(`${history.latest()?.text} `).toBe(sink.pasted[0].text);
    expect(ms).toBeLessThan(2500);

    // The picker: choose the entry, then its raw transcript, then copy only.
    const id = history.latest()!.id;
    await pickFromHistory(history, { id, raw: false, copyOnly: false }, sink);
    await pickFromHistory(history, { id, raw: true, copyOnly: false }, sink);
    await pickFromHistory(history, { id, raw: false, copyOnly: true }, sink);
    expect(sink.pasted.slice(1)).toEqual([
      { text: sink.pasted[0].text, mode: 'paste' },
      { text: `${raw} `, mode: 'paste' },
      { text: history.latest()!.text, mode: 'clipboard' },
    ]);
  }, 120_000);
});
