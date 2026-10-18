// The browser side of capture: getUserMedia, a 16 kHz AudioContext with the capture worklet, and the
// recognizer's MessagePort. Session logic lives in core/capture.ts. The context and worklet are prepared once;
// only the mic stream is opened per dictation, and closed after.
import { type CaptureBackend, CaptureController, type CaptureEvents, type MicStream, type SttMsg, type WorkletMsg } from '../core/capture';
import type { ChunkerOut } from '../core/chunker';
import { listMics, type MicDevice } from '../core/mics';
import { dictate } from './bridge';

// ---------- the recognizer port: messages wait until it arrives ----------

let sttPort: MessagePort | null = null;
const pending: SttMsg[] = [];
window.addEventListener('message', (e: MessageEvent) => {
  if (e.data === 'dictate:stt-port' && e.ports[0]) {
    sttPort = e.ports[0];
    for (const m of pending.splice(0)) sttPort.postMessage(m);
  }
});

function toStt(m: SttMsg): void {
  // No transfer list: the far end is a MessagePortMain, which only transfers ports.
  if (sttPort) sttPort.postMessage(m);
  else pending.push(m);
}

// ---------- audio graph ----------

let ctx: AudioContext | null = null;
let node: AudioWorkletNode | null = null;
let ready: Promise<void> | null = null;
let fakeWav: Uint8Array | undefined;
let fakeBuffer: Promise<AudioBuffer> | null = null;

export function prepare(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
      await ctx.audioWorklet.addModule('./worklet.js');
      node = new AudioWorkletNode(ctx, 'dictate-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(ctx.destination);
      node.port.onmessage = (e: MessageEvent<ChunkerOut>) => controller.onWorklet(e.data);
      await ctx.suspend();
    })();
  }
  return ready;
}

interface BrowserStream extends MicStream {
  source: AudioNode;
}

async function openMic(deviceId: string | null): Promise<BrowserStream> {
  const audio = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  const stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { ...audio, deviceId: { exact: deviceId } } : audio });
  const track = stream.getAudioTracks()[0];
  return {
    label: track?.label ?? '',
    source: ctx!.createMediaStreamSource(stream),
    stop: () => {
      for (const t of stream.getTracks()) t.stop();
    },
    onEnded: (cb) => track?.addEventListener('ended', cb),
  };
}

/** QA: DICTATE_FAKE_MIC plays a WAV through the real capture path instead of opening the mic. */
async function openFake(wav: Uint8Array): Promise<BrowserStream> {
  fakeBuffer ??= ctx!.decodeAudioData(wav.slice().buffer);
  const src = ctx!.createBufferSource();
  src.buffer = await fakeBuffer;
  src.start();
  return {
    label: 'fake mic',
    source: src,
    stop: () => {
      try {
        src.stop();
      } catch {
        // already stopped
      }
    },
    onEnded: () => undefined,
  };
}

const backend: CaptureBackend = {
  prepare,
  open: (deviceId) => (fakeWav ? openFake(fakeWav) : openMic(deviceId)),
  connect: (s) => {
    (s as BrowserStream).source.connect(node!);
  },
  disconnect: (s) => (s as BrowserStream).source.disconnect(),
  resume: async () => {
    await ctx?.resume();
  },
  suspend: async () => {
    await ctx?.suspend();
  },
  worklet: (m: WorkletMsg) => node?.port.postMessage(m),
  stt: toStt,
};

let levelListener: (rms: number, peak: number) => void = () => undefined;

const events: CaptureEvents = {
  started: (id, label, openMs) => dictate.send('dictate:capture-started', { id, label, openMs }),
  error: (id, message) => dictate.send('dictate:capture-error', { id, message }),
  lost: (id, label) => dictate.send('dictate:mic-lost', { id, label }),
  failed: (id, message) => dictate.send('dictate:capture-failed', { id, message }),
  silent: (id, silent) => dictate.send('dictate:silent', { id, silent }),
  level: (rms, peak) => levelListener(rms, peak),
};

const controller = new CaptureController(backend, events);

export function setLevelListener(cb: (rms: number, peak: number) => void): void {
  levelListener = cb;
}

export function start(id: number, deviceId: string | null, gainDb: number, fake?: Uint8Array): Promise<void> {
  fakeWav = fake;
  return controller.start(id, deviceId, gainDb);
}

export const stop = (id: number) => controller.stop(id);
export const cancel = (id: number) => controller.cancel(id);
export const switchDevice = (id: number, deviceId: string | null, gainDb: number) => controller.switchDevice(id, deviceId, gainDb);

// ---------- devices ----------

export interface DeviceList {
  list: MicDevice[];
  /** The label of the device Windows uses as the default input, for its gain setting. */
  defaultLabel: string;
}

export async function devices(): Promise<DeviceList> {
  const all = await navigator.mediaDevices.enumerateDevices();
  const def = all.find((d) => d.kind === 'audioinput' && d.deviceId === 'default');
  return { list: listMics(all), defaultLabel: (def?.label ?? '').replace(/^Default - /, '') };
}

let debounce: ReturnType<typeof setTimeout> | undefined;
export function watchDevices(cb: (d: DeviceList) => void): void {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    clearTimeout(debounce);
    debounce = setTimeout(async () => cb(await devices()), 400);
  });
}
