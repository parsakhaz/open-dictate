import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type ChainDeps, runChain, stepsFor } from '../src/core/chain';
import { chatRequest } from '../src/core/templating';
import { DEFAULT_LLAMA_SERVER, DEFAULT_MODELS_DIR, EMBERON_GGUF, GEMMA_GGUF, resolveModelsDir } from '../src/core/settings';
import { parseVocabularyFile } from '../src/core/vocabulary';
import { LlamaServer } from '../src/engine/llama';

const models = resolveModelsDir(process.env.DICTATE_MODELS_DIR || DEFAULT_MODELS_DIR, fs.existsSync);
const exe = process.env.DICTATE_LLAMA_SERVER || DEFAULT_LLAMA_SERVER;
const have = fs.existsSync(exe) && fs.existsSync(path.join(models, GEMMA_GGUF)) && fs.existsSync(path.join(models, EMBERON_GGUF));
const root = path.join(__dirname, '..');

describe.skipIf(!have || !process.env.DICTATE_LLM_TESTS)('cleanup chain on real llama-servers', () => {
  it('cleans names with Gemma v3 then Emberon on every warm run, deterministically, each under 1.5 s', async () => {
    const vocab = parseVocabularyFile(fs.readFileSync(path.join(root, 'defaults/vocabulary.json'), 'utf8')).terms;
    const steps = stepsFor('gemma-emberon', fs.readFileSync(path.join(root, 'defaults/prompt-v3.txt'), 'utf8'), vocab);
    const log = (l: string, m: string) => console.log(l, m);
    const servers = {
      gemma: new LlamaServer('gemma', { exe, gguf: path.join(models, GEMMA_GGUF), log, warmup: () => chatRequest(steps[0].system, 'warm up') }),
      emberon: new LlamaServer('emberon', { exe, gguf: path.join(models, EMBERON_GGUF), log, warmup: () => chatRequest(steps[1].system, 'warm up') }),
    };
    try {
      await Promise.all([servers.gemma.start(), servers.emberon.start()]);
      const deps: ChainDeps = {
        ready: async (m) => servers[m].whenReady(10_000),
        complete: (m, body, signal) => servers[m].complete(body, signal),
      };
      const raw = 'so um the doozie integration in pain should use claude code and codex with opus';
      const times: number[] = [];
      let last = '';
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        const r = await runChain(raw, steps, deps);
        times.push(performance.now() - t0);
        console.log(r);
        // every run: both steps succeed and every name is fixed
        expect(r.steps.map((s) => s.status)).toEqual(['ok', 'ok']);
        expect(r.text).toMatch(/Doozy/);
        expect(r.text).toMatch(/Pane/);
        expect(r.text).toMatch(/Claude Code/);
        if (last) expect(r.text).toBe(last); // deterministic at temperature 0
        last = r.text;
      }
      console.log('chain ms', times.map(Math.round));
      // warm budget for a one-sentence dictation (measured ~280 ms; generous for a busy laptop)
      for (const t of times) expect(t).toBeLessThan(1500);
    } finally {
      servers.gemma.stop();
      servers.emberon.stop();
    }
  }, 240_000);
});
