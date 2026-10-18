// AudioWorklet: applies input gain (soft-limited), reports a level ~30 times a second for the meter, and
// batches 1600-sample (100 ms at 16 kHz) chunks for the recognizer. Runs in AudioWorkletGlobalScope.
import { applyGain } from '../core/audio';

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

const CHUNK = 1600;
const LEVEL_EVERY = 512;

class CaptureProcessor extends AudioWorkletProcessor {
  private buf = new Float32Array(CHUNK);
  private n = 0;
  private gainDb = 0;
  private sum = 0;
  private peak = 0;
  private limited = 0;
  private count = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<{ type: 'gain'; db: number } | { type: 'flush' }>) => {
      if (e.data.type === 'gain') this.gainDb = e.data.db;
      else if (e.data.type === 'flush') {
        if (this.n > 0) this.port.postMessage({ type: 'chunk', samples: this.buf.slice(0, this.n) });
        this.n = 0;
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const raw = inputs[0]?.[0];
    if (!raw) return true;
    const ch = raw.slice();
    const st = applyGain(ch, this.gainDb);
    this.sum += st.rms * st.rms * ch.length;
    this.peak = Math.max(this.peak, st.peak);
    this.limited += st.limited;
    this.count += ch.length;
    if (this.count >= LEVEL_EVERY) {
      this.port.postMessage({ type: 'level', rms: Math.sqrt(this.sum / this.count), peak: this.peak, limited: this.limited });
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
        const out = this.buf;
        this.port.postMessage({ type: 'chunk', samples: out }, [out.buffer]);
        this.buf = new Float32Array(CHUNK);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('dictate-capture', CaptureProcessor);
