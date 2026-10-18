// Electron utility process hosting the recognizer, so decoding never blocks hotkeys or the UI.
// Audio arrives from the capture renderer on a MessagePort, in order with its begin/end markers; main gets
// partials and finals on parentPort.
import type { SherpaModule } from './sherpaTypes';
import { Stt } from './stt';

export type MainToStt = { type: 'init'; modelDir: string; threads: number } | { type: 'attach' };

/** On the audio port, from the capture renderer. */
export type AudioToStt = { type: 'begin'; id: number } | { type: 'frame'; id: number; samples: Float32Array } | { type: 'end'; id: number } | { type: 'cancel'; id: number };

export type SttToMain =
  | { type: 'ready'; loadMs: number }
  | { type: 'error'; message: string }
  | { type: 'partial'; id: number; text: string }
  | { type: 'final'; id: number; text: string; flushMs: number; audioMs: number };

interface PortLike {
  on(event: 'message', cb: (e: { data: unknown }) => void): void;
  start(): void;
}

const parentPort = (process as unknown as { parentPort: { on: (e: 'message', cb: (ev: { data: MainToStt; ports: PortLike[] }) => void) => void; postMessage: (m: SttToMain) => void } }).parentPort;
const send = (m: SttToMain) => parentPort.postMessage(m);

let stt: Stt | undefined;
let current = -1;
let audioMs = 0;

function onAudio(m: AudioToStt): void {
  if (!stt) return;
  if (m.type === 'begin') {
    current = m.id;
    audioMs = 0;
    stt.begin();
    return;
  }
  if (m.id !== current) return;
  if (m.type === 'frame') {
    audioMs += (m.samples.length / 16000) * 1000;
    const p = stt.accept(m.samples);
    if (p !== null) send({ type: 'partial', id: m.id, text: p });
  } else if (m.type === 'end') {
    const { text, flushMs } = stt.finish();
    send({ type: 'final', id: m.id, text, flushMs, audioMs });
    current = -1;
  } else if (m.type === 'cancel') {
    stt.cancel();
    current = -1;
  }
}

parentPort.on('message', (ev) => {
  const m = ev.data;
  if (m.type === 'init') {
    try {
      const sherpa: SherpaModule = require('sherpa-onnx-node');
      stt = new Stt(sherpa, m.modelDir, m.threads);
      send({ type: 'ready', loadMs: stt.load() });
    } catch (err) {
      send({ type: 'error', message: (err as Error).message });
    }
  } else if (m.type === 'attach') {
    const port = ev.ports[0];
    port.on('message', (e) => {
      try {
        onAudio(e.data as AudioToStt);
      } catch (err) {
        send({ type: 'error', message: (err as Error).message });
      }
    });
    port.start();
  }
});
