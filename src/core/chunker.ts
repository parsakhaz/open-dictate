// The capture worklet's logic, kept pure so it can be tested: input gain, levels for the meter, and 1600-sample
// (100 ms) chunks, each tagged with the session it belongs to. A new session or a reset drops whatever was
// buffered, so audio from a cancelled recording can never leak into the next one.
import { applyGain } from './audio';

export const CHUNK = 1600;
export const LEVEL_EVERY = 512;

export type ChunkerOut = { type: 'chunk'; sid: number; samples: Float32Array } | { type: 'level'; sid: number; rms: number; peak: number; limited: number } | { type: 'flushed'; sid: number };

export class Chunker {
  private buf = new Float32Array(CHUNK);
  private n = 0;
  private sid = 0;
  private gainDb = 0;
  private sum = 0;
  private peak = 0;
  private limited = 0;
  private count = 0;

  constructor(private readonly out: (m: ChunkerOut, transfer?: ArrayBuffer[]) => void) {}

  /** Starts a session: anything buffered for an earlier one is dropped. */
  session(sid: number, gainDb: number): void {
    this.reset();
    this.sid = sid;
    this.gainDb = gainDb;
  }

  setGain(db: number): void {
    this.gainDb = db;
  }

  reset(): void {
    this.buf = new Float32Array(CHUNK);
    this.n = 0;
    this.sum = 0;
    this.peak = 0;
    this.limited = 0;
    this.count = 0;
    this.sid = 0;
  }

  /** Sends the partial chunk of session `sid` (if it is current), then `flushed`. */
  flush(sid: number): void {
    if (sid === this.sid && this.n > 0) {
      this.out({ type: 'chunk', sid, samples: this.buf.slice(0, this.n) });
      this.n = 0;
    }
    this.out({ type: 'flushed', sid });
  }

  push(raw: Float32Array): void {
    if (!this.sid) return;
    const ch = raw.slice();
    const st = applyGain(ch, this.gainDb);
    this.sum += st.rms * st.rms * ch.length;
    this.peak = Math.max(this.peak, st.peak);
    this.limited += st.limited;
    this.count += ch.length;
    if (this.count >= LEVEL_EVERY) {
      this.out({ type: 'level', sid: this.sid, rms: Math.sqrt(this.sum / this.count), peak: this.peak, limited: this.limited });
      this.sum = 0;
      this.peak = 0;
      this.limited = 0;
      this.count = 0;
    }
    let i = 0;
    while (i < ch.length) {
      const take = Math.min(CHUNK - this.n, ch.length - i);
      this.buf.set(ch.subarray(i, i + take), this.n);
      this.n += take;
      i += take;
      if (this.n === CHUNK) {
        const full = this.buf;
        this.out({ type: 'chunk', sid: this.sid, samples: full }, [full.buffer]);
        this.buf = new Float32Array(CHUNK);
        this.n = 0;
      }
    }
  }
}
