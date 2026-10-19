import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type ChainDeps, runChain, stepsFor } from '../src/core/chain';
import { DEFAULT_LLAMA_SERVER, DEFAULT_MODELS_DIR, EMBERON_GGUF, GEMMA_GGUF, resolveModelsDir } from '../src/core/settings';
import type { CleanupModel } from '../src/core/chain';
import { chatRequest } from '../src/core/templating';
import { LlamaServer } from '../src/engine/llama';
import { runHardwareCheck } from '../src/main/hardware';

const models = resolveModelsDir(process.env.DICTATE_MODELS_DIR || DEFAULT_MODELS_DIR, fs.existsSync);
const exe = process.env.DICTATE_LLAMA_SERVER || DEFAULT_LLAMA_SERVER;
const have = fs.existsSync(exe) && fs.existsSync(path.join(models, GEMMA_GGUF)) && fs.existsSync(path.join(models, EMBERON_GGUF));
const root = path.join(__dirname, '..');

describe.skipIf(!have || !process.env.DICTATE_LLM_TESTS)('hardware check on real llama-servers', () => {
  it('times Emberon and Gemma → Emberon on the bundled sample and picks a chain by the D10 rule', async () => {
    const v3 = fs.readFileSync(path.join(root, 'defaults/prompt-v3.txt'), 'utf8');
    const log = (l: string, m: string) => l !== 'info' && console.log(l, m);
    const all = stepsFor('gemma-emberon', v3, []);
    const servers: Record<CleanupModel, LlamaServer> = {
      gemma: new LlamaServer('gemma', { exe, gguf: path.join(models, GEMMA_GGUF), log, warmup: () => chatRequest(all[0].system, 'warm up') }),
      emberon: new LlamaServer('emberon', { exe, gguf: path.join(models, EMBERON_GGUF), log, warmup: () => chatRequest(all[1].system, 'warm up') }),
    };
    const deps: ChainDeps = { ready: (m) => servers[m].whenReady(90_000), complete: (m, body, signal) => servers[m].complete(body, signal) };
    try {
      await Promise.all([servers.gemma.start(), servers.emberon.start()]);
      const report = await runHardwareCheck({
        llamaServer: exe,
        modelsDir: models,
        sample: fs.readFileSync(path.join(root, 'defaults/hardware-sample.txt'), 'utf8'),
        clean: (text, chain) => runChain(text, stepsFor(chain, v3, []), deps, { timeoutMs: 3000 }),
        measureGemma: true,
      });
      console.log(JSON.stringify(report, null, 2));
      expect(report.failure).toBeUndefined();
      expect(report.emberonMs).toBeGreaterThan(0);
      expect(report.gemmaChainMs).toBeGreaterThan(0);
      const expected = report.gemmaChainMs! < 1000 ? 'gemma-emberon' : report.emberonMs! < 1000 ? 'emberon' : 'off';
      expect(report.choice.chain).toBe(expected);
    } finally {
      servers.gemma.stop();
      servers.emberon.stop();
    }
  }, 300_000);
});
