// Streaming resampler to the recognizer's 16 kHz, for native capture in the device's own mix format (usually
// 48 kHz). A windowed-sinc low-pass at the output Nyquist, evaluated at each output instant: about 32 taps per
// output sample, a fraction of a percent of one core. Pure; keeps the tail of each block for the next.

const HALF = 16;

function sinc(x: number): number {
  return x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
}

export class Resampler {
  private readonly step: number;
  private readonly cutoff: number;
  /** Input not yet fully used: the last 2*HALF samples of earlier blocks, then the new block. */
  private hist = new Float32Array(0);
  /** Position of the next output sample, in input samples, relative to hist[0]. */
  private pos: number;

  constructor(
    readonly inRate: number,
    readonly outRate = 16000,
  ) {
    this.step = inRate / outRate;
    this.cutoff = Math.min(1, outRate / inRate);
    this.pos = HALF;
  }

  push(input: Float32Array): Float32Array {
    if (this.inRate === this.outRate) return input.slice();
    const buf = new Float32Array(this.hist.length + input.length);
    buf.set(this.hist);
    buf.set(input, this.hist.length);
    const out: number[] = [];
    // An output sample needs HALF input samples after it.
    while (this.pos + HALF < buf.length) {
      const c = Math.floor(this.pos);
      let acc = 0;
      let norm = 0;
      for (let k = c - HALF + 1; k <= c + HALF; k++) {
        if (k < 0) continue;
        const d = this.pos - k;
        // Blackman window over the 2*HALF taps.
        const wpos = (d + HALF) / (2 * HALF);
        const win = 0.42 - 0.5 * Math.cos(2 * Math.PI * wpos) + 0.08 * Math.cos(4 * Math.PI * wpos);
        const h = this.cutoff * sinc(this.cutoff * d) * win;
        acc += buf[k] * h;
        norm += h;
      }
      out.push(norm ? acc / norm : 0);
      this.pos += this.step;
    }
    // Keep what the next outputs still need.
    const keepFrom = Math.max(0, Math.floor(this.pos) - HALF);
    this.hist = buf.slice(keepFrom);
    this.pos -= keepFrom;
    return Float32Array.from(out);
  }
}
