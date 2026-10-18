import { describe, expect, it } from 'vitest';
import { applyGain, dbfs, defaultGainDb, SilenceWatch } from '../src/core/audio';

describe('defaultGainDb', () => {
  it('boosts the quiet built-in array by 20 dB and leaves other mics alone', () => {
    expect(defaultGainDb('Microphone Array (AMD Audio Device)')).toBe(20);
    expect(defaultGainDb('Microphone (BOYA mini 2)')).toBe(0);
    expect(defaultGainDb(undefined)).toBe(0);
  });
});

describe('applyGain', () => {
  it('multiplies by 10 at +20 dB', () => {
    const s = new Float32Array([0.01, -0.02]);
    const r = applyGain(s, 20);
    expect(s[0]).toBeCloseTo(0.1, 6);
    expect(s[1]).toBeCloseTo(-0.2, 6);
    expect(r.limited).toBe(0);
    expect(r.peak).toBeCloseTo(0.2, 6);
  });

  it('never lets a boosted sample pass full scale, and keeps the sign', () => {
    const s = new Float32Array([0.5, -0.9, 0.09]);
    const r = applyGain(s, 20);
    expect(r.limited).toBe(3);
    for (const x of s) expect(Math.abs(x)).toBeLessThanOrEqual(1);
    expect(s[1]).toBeLessThan(-0.8);
    // louder in stays louder out
    expect(s[0]).toBeGreaterThan(s[2]);
  });
});

describe('levels', () => {
  it('converts RMS to dBFS', () => {
    expect(dbfs(1)).toBe(0);
    expect(dbfs(0.1)).toBeCloseTo(-20, 6);
    expect(dbfs(0)).toBe(-120);
  });

  it('warns after 2 s of near-silence and clears on speech', () => {
    const w = new SilenceWatch();
    for (let i = 0; i < 19; i++) expect(w.push(0.0001, 100)).toBe(false);
    expect(w.push(0.0001, 100)).toBe(true);
    expect(w.push(0.05, 100)).toBe(false);
  });
});
