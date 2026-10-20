import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGC_TARGET_DBFS, type GainSpec } from '../src/core/agc';
import { dbfs } from '../src/core/audio';
import { Chunker, type ChunkerOut } from '../src/core/chunker';
import { DEFAULT_MODELS_DIR, resolveModelsDir, STT_MODEL } from '../src/core/settings';
import type { SherpaModule } from '../src/engine/sherpaTypes';
import { Stt } from '../src/engine/stt';
import { readWav } from '../src/engine/wav';

const modelDir = path.join(resolveModelsDir(process.env.DICTATE_MODELS_DIR || DEFAULT_MODELS_DIR, fs.existsSync), STT_MODEL);
const have = fs.existsSync(modelDir);

/** The fixture as a quieter mic would hear it: attenuated, with a little self-noise so the pauses are not digital silence. */
function asHeard(samples: Float32Array, attenuationDb: number): Float32Array {
  const k = 10 ** (attenuationDb / 20);
  const hiss = 10 ** (-75 / 20) * Math.sqrt(3);
  let s = 7;
  return samples.map((x) => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return x * k + (s / 2 ** 31 - 1) * hiss;
  });
}

/** Runs audio through the real capture Chunker in 128-sample blocks (the worklet's size), as dictation does. */
function capture(samples: Float32Array, gain: GainSpec): { chunks: Float32Array[]; out: Float32Array; endGainDb: number } {
  const chunks: Float32Array[] = [];
  let endGainDb = 0;
  const c = new Chunker((m: ChunkerOut) => {
    if (m.type === 'chunk') chunks.push(m.samples.slice());
    if (m.type === 'level') endGainDb = m.gainDb;
  });
  c.session(1, gain);
  for (let i = 0; i < samples.length; i += 128) c.push(samples.subarray(i, i + 128));
  c.flush(1);
  const out = new Float32Array(chunks.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of chunks) {
    out.set(x, o);
    o += x.length;
  }
  return { chunks, out, endGainDb };
}

/** RMS of the 20 ms frames where the clean fixture has speech (it is silent between words). */
function speechDb(x: Float32Array, clean: Float32Array): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 320 <= clean.length; i += 320) {
    let e = 0;
    for (let j = i; j < i + 320; j++) e += clean[j] * clean[j];
    if (dbfs(Math.sqrt(e / 320)) < -40) continue;
    for (let j = i; j < i + 320; j++) sum += x[j] * x[j];
    n += 320;
  }
  return dbfs(Math.sqrt(sum / n));
}

const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean);

/** Word error rate against the reference transcript. */
function wer(ref: string, hyp: string): number {
  const r = words(ref);
  const h = words(hyp);
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const row = [i];
    for (let j = 1; j <= h.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[h.length] / r.length;
}

describe.skipIf(!have)('automatic gain on the speech fixture, through Nemotron', () => {
  it('brings quiet recordings to the target level and recognises them as well as the original', () => {
    const sherpa = require('sherpa-onnx-node') as SherpaModule;
    const stt = new Stt(sherpa, modelDir, 4);
    stt.load();
    const transcribe = (chunks: Float32Array[]) => {
      stt.begin();
      for (const c of chunks) stt.accept(c);
      return stt.finish().text;
    };
    const { samples: clean } = readWav(path.join(__dirname, '..', 'fixtures', 'two-sentences.wav'));
    const reference = transcribe(capture(clean, { auto: false, db: 0 }).chunks);

    const rows: Record<string, string | number>[] = [];
    for (const att of [0, -20, -30]) {
      const heard = asHeard(clean, att);
      // the gain the first pass ended at is where the next dictation on this mic starts
      const first = capture(heard, { auto: true, db: 30, startDb: 0 });
      const cases: [string, GainSpec][] = [
        ['none', { auto: false, db: 0 }],
        ['fixed +30', { auto: false, db: 30 }],
        ['auto, first dictation', { auto: true, db: 30, startDb: 0 }],
        ['auto, next dictation', { auto: true, db: 30, startDb: first.endGainDb }],
      ];
      for (const [name, gain] of cases) {
        const r = capture(heard, gain);
        const text = transcribe(r.chunks);
        rows.push({ input: `${att} dB`, gain: name, inDb: +speechDb(heard, clean).toFixed(1), outDb: +speechDb(r.out, clean).toFixed(1), peak: +dbfs(r.out.reduce((m, v) => Math.max(m, Math.abs(v)), 0)).toFixed(1), endGain: +r.endGainDb.toFixed(1), wer: +wer(reference, text).toFixed(3), exact: words(text).join(' ') === words(reference).join(' ') ? 'yes' : 'no', text });
      }
    }
    console.log(`reference: ${reference}`);
    console.table(rows.map(({ text: _t, ...r }) => r));
    for (const r of rows.filter((x) => (x.wer as number) > 0)) console.log(`${r.input} ${r.gain}: ${r.text}`);

    const row = (input: string, gain: string) => rows.find((r) => r.input === input && r.gain === gain)!;
    for (const input of ['-20 dB', '-30 dB']) {
      // automatic gain brings the quiet input to within a few dB of the target...
      expect(Math.abs((row(input, 'auto, next dictation').outDb as number) - AGC_TARGET_DBFS)).toBeLessThan(4);
      // ...and recognises it at least as well as the unboosted input
      expect(row(input, 'auto, next dictation').wer).toBeLessThanOrEqual(row(input, 'none').wer as number);
      expect(row(input, 'auto, first dictation').wer).toBeLessThanOrEqual(row(input, 'none').wer as number);
    }
    // the original is already at a normal level: it is left alone
    expect(Math.abs(row('0 dB', 'auto, first dictation').endGain as number)).toBeLessThan(3);
    // (compared with the same input unboosted: the clean reference itself can differ by a word on some platforms)
    expect(row('0 dB', 'auto, first dictation').wer).toBeLessThanOrEqual(row('0 dB', 'none').wer as number);
  }, 180_000);
});
