import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODELS_DIR, resolveModelsDir, STT_MODEL } from '../src/core/settings';
import type { SherpaModule } from '../src/engine/sherpaTypes';
import { Stt } from '../src/engine/stt';
import { readWav } from '../src/engine/wav';

const modelDir = path.join(resolveModelsDir(process.env.DICTATE_MODELS_DIR || DEFAULT_MODELS_DIR, fs.existsSync), STT_MODEL);
const have = fs.existsSync(modelDir);

describe.skipIf(!have)('Nemotron 1120 ms streaming STT', () => {
  it('streams a fixture in 100 ms frames and flushes a final', () => {
    const sherpa = require('sherpa-onnx-node') as SherpaModule;
    const stt = new Stt(sherpa, modelDir, 4);
    const loadMs = stt.load();
    const { samples, sampleRate } = readWav(path.join(__dirname, '..', 'fixtures', 'two-sentences.wav'));
    expect(sampleRate).toBe(16000);
    stt.begin();
    const partials: string[] = [];
    for (let i = 0; i < samples.length; i += 1600) {
      const p = stt.accept(samples.slice(i, i + 1600));
      if (p) partials.push(p);
    }
    const { text, flushMs } = stt.finish();
    console.log({ loadMs: Math.round(loadMs), flushMs: Math.round(flushMs), partials: partials.length, text });
    expect(partials.length).toBeGreaterThan(0);
    expect(text.split(/\s+/).length).toBeGreaterThan(5);
    expect(text.toLowerCase()).toContain('deploy the kubernetes cluster with terraform');
    expect(text.toLowerCase()).toContain('nemotron streaming models');
  }, 60_000);
});
