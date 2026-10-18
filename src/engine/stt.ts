// One streaming recognizer (voice-lab's sherpa-onnx lane, trimmed to one stream): decode while the person
// speaks, then flush the last chunk on release. Transport-free, so the utility process and the tests share it.
import fs from 'node:fs';
import path from 'node:path';
import { SAMPLE_RATE } from '../core/types';
import type { OnlineRecognizer, SherpaModule, SherpaStream } from './sherpaTypes';

/**
 * Silence appended on release so the streaming model sees its right context before the final.
 * voice-lab used 0.8 s; Nemotron 1120 ms needs only part of its chunk to commit the last word.
 */
export const FLUSH_PAD_S = 0.8;

export function modelFiles(dir: string) {
  const files = fs.readdirSync(dir);
  const pick = (re: RegExp) => {
    const c = files.filter((f) => re.test(f)).sort();
    const f = c.find((x) => /int8/.test(x)) ?? c[0];
    if (!f) throw new Error(`no file matching ${re} in ${dir}`);
    return path.join(dir, f);
  };
  return { encoder: pick(/^encoder.*\.onnx$/), decoder: pick(/^decoder.*\.onnx$/), joiner: pick(/^joiner.*\.onnx$/), tokens: path.join(dir, 'tokens.txt') };
}

export class Stt {
  private recognizer?: OnlineRecognizer;
  private stream?: SherpaStream;
  private partial = '';
  private padS = FLUSH_PAD_S;

  constructor(
    private readonly sherpa: SherpaModule,
    private readonly modelDir: string,
    private readonly threads: number,
  ) {}

  /** Loads the model once; returns the load time in ms. */
  load(): number {
    const t0 = performance.now();
    const f = modelFiles(this.modelDir);
    this.recognizer = new this.sherpa.OnlineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: { transducer: { encoder: f.encoder, decoder: f.decoder, joiner: f.joiner }, tokens: f.tokens, numThreads: this.threads, provider: 'cpu', debug: 0 },
      decodingMethod: 'greedy_search',
      maxActivePaths: 4,
      // The person decides when an utterance ends (key release), so the model's endpointing is off.
      enableEndpoint: 0,
    });
    return performance.now() - t0;
  }

  setFlushPad(seconds: number): void {
    this.padS = seconds;
  }

  begin(): void {
    if (!this.recognizer) throw new Error('STT model not loaded');
    this.stream = this.recognizer.createStream();
    this.partial = '';
  }

  get active(): boolean {
    return !!this.stream;
  }

  /** Feeds 16 kHz mono samples; returns the new partial text when it changed. Decodes only when a chunk is ready. */
  accept(samples: Float32Array): string | null {
    const r = this.recognizer;
    const s = this.stream;
    if (!r || !s) return null;
    s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
    let decoded = false;
    while (r.isReady(s)) {
      r.decode(s);
      decoded = true;
    }
    if (!decoded) return null;
    const text = r.getResult(s).text.trim();
    if (text === this.partial) return null;
    this.partial = text;
    return text;
  }

  /** Flushes the last chunk and returns the final text. */
  finish(): { text: string; flushMs: number } {
    const r = this.recognizer;
    const s = this.stream;
    this.stream = undefined;
    if (!r || !s) return { text: '', flushMs: 0 };
    const t0 = performance.now();
    s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: new Float32Array(Math.round(this.padS * SAMPLE_RATE)) });
    s.inputFinished();
    while (r.isReady(s)) r.decode(s);
    const text = r.getResult(s).text.trim();
    return { text, flushMs: performance.now() - t0 };
  }

  cancel(): void {
    this.stream = undefined;
  }
}
