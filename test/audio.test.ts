import { describe, expect, it } from 'vitest';
import { dbfs, defaultGainDb, SilenceWatch } from '../src/core/audio';

describe('defaultGainDb', () => {
  it('boosts the quiet built-in array by 30 dB and leaves other mics alone', () => {
    expect(defaultGainDb('Microphone Array (AMD Audio Device)')).toBe(30);
    expect(defaultGainDb('Microphone (BOYA mini 2)')).toBe(0);
    expect(defaultGainDb(undefined)).toBe(0);
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
