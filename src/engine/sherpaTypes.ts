// sherpa-onnx-node 1.13.8 ships no TypeScript types; this is the subset dictate uses (from voice-lab).

export interface SherpaStream {
  acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void;
  inputFinished(): void;
}

export interface OnlineRecognizer {
  createStream(): SherpaStream;
  isReady(s: SherpaStream): boolean;
  decode(s: SherpaStream): void;
  getResult(s: SherpaStream): { text: string };
}

export interface SherpaModule {
  OnlineRecognizer: new (config: Record<string, unknown>) => OnlineRecognizer;
}
