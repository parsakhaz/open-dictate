// Input gain with a clipping guard, levels, and the near-silence check. Pure; browser-safe.

/** The laptop's built-in array measures about -37 dBFS speech even close up, so it starts with +20 dB. */
export const QUIET_MIC = /Microphone Array \(AMD Audio Device\)/i;

export function defaultGainDb(label: string | undefined): number {
  return label && QUIET_MIC.test(label) ? 20 : 0;
}

/** Above this the signal is compressed smoothly towards 1 instead of clipping hard. */
const KNEE = 0.8;

/**
 * Applies `gainDb` in place. Samples past the knee are soft-limited (tanh), so boosted speech never wraps
 * or clips flat; `limited` counts how many were.
 */
export function applyGain(samples: Float32Array, gainDb: number): { peak: number; rms: number; limited: number } {
  const g = 10 ** (gainDb / 20);
  let peak = 0;
  let sum = 0;
  let limited = 0;
  for (let i = 0; i < samples.length; i++) {
    let x = samples[i] * g;
    const a = Math.abs(x);
    if (a > KNEE) {
      x = Math.sign(x) * (KNEE + (1 - KNEE) * Math.tanh((a - KNEE) / (1 - KNEE)));
      limited++;
    }
    samples[i] = x;
    const b = Math.abs(x);
    if (b > peak) peak = b;
    sum += x * x;
  }
  return { peak, rms: samples.length ? Math.sqrt(sum / samples.length) : 0, limited };
}

export function dbfs(rms: number): number {
  return rms > 0 ? 20 * Math.log10(rms) : -120;
}

/** Below this (after gain) for SILENT_MS the pill warns that the mic hears nothing. */
export const SILENT_DBFS = -55;
export const SILENT_MS = 2000;

/** Tracks how long the input has stayed near-silent. */
export class SilenceWatch {
  private quietMs = 0;

  /** Feed one chunk; returns true while the input has been near-silent for SILENT_MS or more. */
  push(rms: number, chunkMs: number): boolean {
    this.quietMs = dbfs(rms) < SILENT_DBFS ? this.quietMs + chunkMs : 0;
    return this.quietMs >= SILENT_MS;
  }
}
