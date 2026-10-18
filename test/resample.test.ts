import { describe, expect, it } from 'vitest';
import { Resampler } from '../src/core/resample';

function tone(hz: number, rate: number, seconds: number): Float32Array {
  const n = Math.round(rate * seconds);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / rate);
  return x;
}

function rms(x: Float32Array, from = 0): number {
  let s = 0;
  for (let i = from; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / (x.length - from));
}

/** Feeds in 10 ms blocks of the input rate, like WASAPI does. */
function run(r: Resampler, x: Float32Array, block: number): Float32Array {
  const parts: Float32Array[] = [];
  for (let i = 0; i < x.length; i += block) parts.push(r.push(x.subarray(i, i + block)));
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('Resampler', () => {
  it('turns 48 kHz into 16 kHz: one third of the samples, streamed in 10 ms blocks', () => {
    const out = run(new Resampler(48000), tone(440, 48000, 1), 480);
    expect(Math.abs(out.length - 16000)).toBeLessThan(40);
  });

  it('keeps speech-band tones at their level', () => {
    const out = run(new Resampler(48000), tone(1000, 48000, 1), 480);
    expect(rms(out, 100)).toBeCloseTo(0.5 / Math.SQRT2, 1);
  });

  it('removes what 16 kHz cannot hold (no aliasing of a 12 kHz tone)', () => {
    const out = run(new Resampler(48000), tone(12000, 48000, 1), 480);
    expect(rms(out, 100)).toBeLessThan(0.02);
  });

  it('handles 44.1 kHz with odd block sizes', () => {
    const out = run(new Resampler(44100), tone(440, 44100, 1), 441);
    expect(Math.abs(out.length - 16000)).toBeLessThan(40);
    expect(rms(out, 100)).toBeCloseTo(0.5 / Math.SQRT2, 1);
  });

  it('passes 16 kHz through unchanged', () => {
    const x = tone(440, 16000, 0.1);
    expect(new Resampler(16000).push(x)).toEqual(x);
  });
});
