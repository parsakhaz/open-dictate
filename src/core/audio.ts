// Default gains, the clipping guard, levels, and the near-silence check. Pure; browser-safe.

/** The laptop's built-in array measures about -37 dBFS speech even close up, so it starts with +30 dB. */
export const QUIET_MIC = /Microphone Array \(AMD Audio Device\)/i;

/**
 * The gain for a mic the person has not set: +30 dB for the quiet built-in array. With automatic gain this is
 * the maximum boost, and any other mic may be raised up to +20 dB; a fixed gain leaves other mics alone.
 */
export function defaultGainDb(label: string | undefined, auto = false): number {
  if (label && QUIET_MIC.test(label)) return 30;
  return auto ? 20 : 0;
}

/** Where automatic gain starts on a mic it has not heard yet: the quiet array's -37 dBFS needs about +17 dB. */
export function defaultStartDb(label: string | undefined): number {
  return label && QUIET_MIC.test(label) ? 17 : 0;
}

/** Above this the signal is compressed smoothly towards 1 instead of clipping hard. */
export const KNEE = 0.8;

/** A sample past the knee, compressed (tanh) so it never reaches full scale and keeps its sign. */
export function softLimit(x: number): number {
  return Math.sign(x) * (KNEE + (1 - KNEE) * Math.tanh((Math.abs(x) - KNEE) / (1 - KNEE)));
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
