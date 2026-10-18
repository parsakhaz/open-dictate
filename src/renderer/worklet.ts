// AudioWorklet host for the Chunker: gain, levels and session-tagged 100 ms chunks. Runs in AudioWorkletGlobalScope.
import { Chunker, type ChunkerOut } from '../core/chunker';

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

export type ToWorklet = { type: 'session'; sid: number; gainDb: number } | { type: 'gain'; db: number } | { type: 'flush'; sid: number } | { type: 'reset' };

class CaptureProcessor extends AudioWorkletProcessor {
  private readonly chunker = new Chunker((m: ChunkerOut, transfer?: ArrayBuffer[]) => this.port.postMessage(m, transfer ?? []));

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<ToWorklet>) => {
      const m = e.data;
      if (m.type === 'session') this.chunker.session(m.sid, m.gainDb);
      else if (m.type === 'gain') this.chunker.setGain(m.db);
      else if (m.type === 'flush') this.chunker.flush(m.sid);
      else this.chunker.reset();
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (ch) this.chunker.push(ch);
    return true;
  }
}

registerProcessor('dictate-capture', CaptureProcessor);
