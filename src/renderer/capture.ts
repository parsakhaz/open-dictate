// Mic capture for dictation: getUserMedia -> 16 kHz AudioContext -> worklet (gain, levels, 100 ms chunks)
// -> the recognizer's MessagePort. The context and worklet are prepared once at start-up; only the mic stream
// is opened per dictation, and closed after.
import { SilenceWatch } from '../core/audio';
import { listMics, type MicDevice } from '../core/mics';
import { dictate } from './bridge';

let sttPort: MessagePort | null = null;
const waiting: ((p: MessagePort) => void)[] = [];
window.addEventListener('message', (e: MessageEvent) => {
  if (e.data === 'dictate:stt-port' && e.ports[0]) {
    sttPort = e.ports[0];
    for (const w of waiting.splice(0)) w(sttPort);
  }
});

function port(): Promise<MessagePort> {
  return sttPort ? Promise.resolve(sttPort) : new Promise((r) => waiting.push(r));
}

let ctx: AudioContext | null = null;
let node: AudioWorkletNode | null = null;
let ready: Promise<void> | null = null;

/** Builds the audio graph once and leaves it suspended: no audio thread work while idle. */
export function prepare(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
      await ctx.audioWorklet.addModule('./worklet.js');
      node = new AudioWorkletNode(ctx, 'dictate-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(ctx.destination);
      node.port.onmessage = (e) => onWorklet(e.data);
      await ctx.suspend();
    })();
  }
  return ready;
}

interface Session {
  id: number;
  stream: MediaStream | null;
  source: AudioNode | null;
  out: MessagePort;
  silence: SilenceWatch;
  silent: boolean;
  ending: boolean;
}

let session: Session | null = null;
let onLevel: (rms: number, peak: number) => void = () => undefined;

export function setLevelListener(cb: (rms: number, peak: number) => void): void {
  onLevel = cb;
}

let flushed: (() => void) | null = null;

function onWorklet(m: { type: 'chunk'; samples: Float32Array } | { type: 'level'; rms: number; peak: number; limited: number } | { type: 'flushed' }): void {
  if (m.type === 'flushed') {
    flushed?.();
    flushed = null;
    return;
  }
  const s = session;
  if (!s) return;
  if (m.type === 'chunk') {
    // No transfer list: the far end is a MessagePortMain, which only transfers ports.
    s.out.postMessage({ type: 'frame', id: s.id, samples: m.samples });
  } else {
    onLevel(m.rms, m.peak);
    const silent = s.silence.push(m.rms, (512 / 16000) * 1000);
    if (silent !== s.silent) {
      s.silent = silent;
      dictate.send('dictate:silent', { id: s.id, silent });
    }
  }
}

async function openStream(deviceId: string | null): Promise<MediaStream> {
  const audio = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: { exact: deviceId } } });
    } catch (err) {
      // The device went away between enumeration and now: fall back to the system default.
      console.warn('[dictate] mic open failed, using default', err);
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio });
}

function attach(s: Session, stream: MediaStream): void {
  s.source?.disconnect();
  for (const t of s.stream?.getTracks() ?? []) t.stop();
  s.stream = stream;
  s.source = ctx!.createMediaStreamSource(stream);
  s.source.connect(node!);
  const track = stream.getAudioTracks()[0];
  track?.addEventListener('ended', () => {
    // Unplugged mid-recording: main picks the fallback and calls switchDevice(); audio so far is kept.
    if (session === s && !s.ending) dictate.send('dictate:mic-lost', { id: s.id });
  });
}

// QA: DICTATE_FAKE_MIC plays a WAV through the real capture path instead of opening the mic.
let fakeBuffer: Promise<AudioBuffer> | null = null;

async function attachFake(s: Session, wav: Uint8Array): Promise<void> {
  fakeBuffer ??= ctx!.decodeAudioData(wav.slice().buffer);
  const src = ctx!.createBufferSource();
  src.buffer = await fakeBuffer;
  src.connect(node!);
  src.start();
  s.source = src;
}

export async function start(id: number, deviceId: string | null, gainDb: number, fakeWav?: Uint8Array): Promise<void> {
  const t0 = performance.now();
  await prepare();
  if (session) await cancel(session.id);
  const out = await port();
  const s: Session = { id, stream: null, source: null, out, silence: new SilenceWatch(), silent: false, ending: false };
  session = s;
  out.postMessage({ type: 'begin', id });
  node!.port.postMessage({ type: 'gain', db: gainDb });
  try {
    let label = 'fake mic';
    if (fakeWav) await attachFake(s, fakeWav);
    else {
      const stream = await openStream(deviceId);
      if (session !== s) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      attach(s, stream);
      label = stream.getAudioTracks()[0]?.label ?? '';
    }
    await ctx!.resume();
    dictate.send('dictate:capture-started', { id, label, openMs: Math.round(performance.now() - t0) });
  } catch (err) {
    if (session === s) session = null;
    out.postMessage({ type: 'cancel', id });
    dictate.send('dictate:capture-error', { id, message: (err as Error).message });
  }
}

/** Mid-recording device change: the recognizer stream carries on. */
export async function switchDevice(id: number, deviceId: string | null, gainDb: number): Promise<void> {
  const s = session;
  if (!s || s.id !== id) return;
  node!.port.postMessage({ type: 'gain', db: gainDb });
  try {
    const stream = await openStream(deviceId);
    if (session !== s) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    attach(s, stream);
  } catch (err) {
    dictate.send('dictate:capture-error', { id, message: (err as Error).message });
  }
}

function close(s: Session): void {
  s.source?.disconnect();
  for (const t of s.stream?.getTracks() ?? []) t.stop();
  s.stream = null;
  s.source = null;
  void ctx?.suspend();
}

/** Sends the last partial chunk, then the end marker; the recognizer answers main with the final. */
export async function stop(id: number): Promise<void> {
  const s = session;
  if (!s || s.id !== id) {
    // Never started (mic failed): still end the recognizer stream so main gets a final.
    (await port()).postMessage({ type: 'end', id });
    return;
  }
  s.ending = true;
  s.source?.disconnect();
  await new Promise<void>((r) => {
    flushed = r;
    node!.port.postMessage({ type: 'flush' });
    setTimeout(r, 100);
  });
  session = null;
  close(s);
  s.out.postMessage({ type: 'end', id });
}

export async function cancel(id: number): Promise<void> {
  const s = session;
  if (!s || s.id !== id) return;
  s.ending = true;
  session = null;
  close(s);
  s.out.postMessage({ type: 'cancel', id });
}

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
