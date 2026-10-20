import { describe, expect, it } from 'vitest';
import { AGC_TARGET_DBFS, Agc } from '../src/core/agc';
import { dbfs } from '../src/core/audio';

const SR = 16000;

/** A deterministic noise source, so every run hears the same room. */
function noise(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 31 - 1;
  };
}

/**
 * Speech-like test signal: a 140 Hz voice with harmonics, opened and closed in 4 Hz syllables, in talk spurts
 * of `talkS` seconds separated by `pauseS` of silence. `speechDb` is the RMS of the spurts; `noiseDb` adds room hiss
 * under everything.
 */
function speech(seconds: number, speechDb: number, opts: { noiseDb?: number; talkS?: number; pauseS?: number } = {}): Float32Array {
  const { noiseDb = -120, talkS = 1.5, pauseS = 0 } = opts;
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const voice = new Float32Array(n);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const talking = pauseS === 0 || t % (talkS + pauseS) < talkS;
    if (!talking) continue;
    const env = Math.abs(Math.sin(Math.PI * 4 * t)) ** 0.7;
    let v = 0;
    for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * 140 * h * t) / h;
    voice[i] = v * env;
    sum += voice[i] ** 2;
    count++;
  }
  const k = count ? 10 ** (speechDb / 20) / Math.sqrt(sum / count) : 0;
  const rnd = noise();
  const nk = 10 ** (noiseDb / 20) * Math.sqrt(3);
  for (let i = 0; i < n; i++) out[i] = voice[i] * k + rnd() * nk;
  return out;
}

/** Runs the signal through in 128-sample blocks (the worklet's size), recording the gain after each block. */
function run(agc: Agc, signal: Float32Array, block = 128): { out: Float32Array; gains: number[]; limited: number } {
  const out = signal.slice();
  const gains: number[] = [];
  let limited = 0;
  for (let i = 0; i < out.length; i += block) {
    limited += agc.process(out.subarray(i, i + block)).limited;
    gains.push(agc.gainDb);
  }
  return { out, gains, limited };
}

function rmsDb(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return dbfs(Math.sqrt(s / Math.max(1, to - from)));
}

const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe('Agc', () => {
  it('raises quiet speech to the target level', () => {
    const agc = new Agc({ auto: true, db: 30 });
    const { out } = run(agc, speech(8, -45, { noiseDb: -75 }));
    // after the first few seconds the speech sits within a few dB of the target
    expect(rmsDb(out, 4 * SR)).toBeGreaterThan(AGC_TARGET_DBFS - 4);
    expect(rmsDb(out, 4 * SR)).toBeLessThan(AGC_TARGET_DBFS + 4);
  });

  it('leaves loud speech alone and never clips it', () => {
    const agc = new Agc({ auto: true, db: 30 });
    const sig = speech(6, -10, { noiseDb: -80, pauseS: 0.3 });
    const { out, gains } = run(agc, sig);
    expect(Math.max(...gains)).toBeLessThan(0.5);
    expect(peak(out)).toBeLessThan(1);
  });

  it('leaves a good headset close to where it is', () => {
    const agc = new Agc({ auto: true, db: 30 });
    const { gains } = run(agc, speech(8, -22, { noiseDb: -80, pauseS: 0.3 }));
    expect(Math.max(...gains)).toBeLessThan(3);
  });

  it('brings a sudden loud voice down fast, and the limiter keeps it below full scale meanwhile', () => {
    const agc = new Agc({ auto: true, db: 30, startDb: 25 });
    const sig = speech(1, -10, { noiseDb: -80 });
    const { out, gains } = run(agc, sig);
    expect(peak(out)).toBeLessThan(1);
    // within 150 ms the gain is most of the way down
    expect(gains[Math.round((0.15 * SR) / 128)]).toBeLessThan(10);
  });

  it('never boosts room hiss while nobody speaks', () => {
    for (const startDb of [0, 12]) {
      const agc = new Agc({ auto: true, db: 30, startDb });
      const { gains } = run(agc, speech(6, -120, { noiseDb: -55 }));
      expect(Math.max(...gains)).toBeLessThanOrEqual(startDb + 0.01);
    }
  });

  it('does not boost near-silence on a dead quiet mic either', () => {
    const agc = new Agc({ auto: true, db: 30 });
    const { gains } = run(agc, speech(4, -120, { noiseDb: -85 }));
    expect(Math.max(...gains)).toBeLessThan(0.01);
  });

  it('holds the gain through a pause instead of drifting up on the hiss', () => {
    const agc = new Agc({ auto: true, db: 30 });
    run(agc, speech(6, -45, { noiseDb: -70 }));
    const before = agc.gainDb;
    const { gains } = run(agc, speech(4, -120, { noiseDb: -70 }));
    expect(Math.max(...gains)).toBeLessThan(before + 0.5);
    expect(Math.min(...gains)).toBeGreaterThan(before - 0.5);
  });

  it('does not pump on the short pauses between phrases', () => {
    const agc = new Agc({ auto: true, db: 30 });
    const { gains } = run(agc, speech(12, -40, { noiseDb: -70, talkS: 1.2, pauseS: 0.3 }));
    const settled = gains.slice(Math.floor(gains.length / 2));
    expect(Math.max(...settled) - Math.min(...settled)).toBeLessThan(3);
  });

  it('never goes past the maximum boost', () => {
    const agc = new Agc({ auto: true, db: 12 });
    const { gains } = run(agc, speech(6, -50, { noiseDb: -80 }));
    expect(Math.max(...gains)).toBeLessThanOrEqual(12 + 1e-6);
    expect(gains.at(-1)).toBeGreaterThan(11);
  });

  it('starts the next dictation at the gain the last one reached', () => {
    const first = new Agc({ auto: true, db: 30 });
    run(first, speech(6, -45, { noiseDb: -75 }));
    const next = new Agc({ auto: true, db: 30, startDb: first.gainDb });
    const { out } = run(next, speech(0.5, -45, { noiseDb: -75 }));
    expect(rmsDb(out)).toBeGreaterThan(AGC_TARGET_DBFS - 6);
  });

  it('keeps a fixed gain in manual mode, whatever it hears', () => {
    const agc = new Agc({ auto: false, db: 20 });
    const sig = new Float32Array([0.01, -0.02]);
    agc.process(sig);
    expect(sig[0]).toBeCloseTo(0.1, 6);
    expect(sig[1]).toBeCloseTo(-0.2, 6);
    run(agc, speech(3, -50, { noiseDb: -60 }));
    expect(agc.gainDb).toBeCloseTo(20, 6);
  });

  it('softens a manual boost past the knee instead of clipping, keeping the sign and the order', () => {
    const agc = new Agc({ auto: false, db: 20 });
    const s = new Float32Array([0.5, -0.9, 0.09]);
    expect(agc.process(s).limited).toBe(3);
    for (const x of s) expect(Math.abs(x)).toBeLessThanOrEqual(1);
    expect(s[1]).toBeLessThan(-0.8);
    expect(s[0]).toBeGreaterThan(s[2]);
  });
});
