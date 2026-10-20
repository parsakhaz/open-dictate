// Native mic capture on its own thread: WASAPI (shared mode, the device's mix format, event-driven), resampled to
// 16 kHz mono, then gain, levels and session-tagged 100 ms chunks (the same Chunker the browser worklet runs).
// While a stream is open the thread loops on the capture event and reads commands between packets; with no
// stream it idles in the event loop. DICTATE_FAKE_MIC plays a WAV through the same path for QA.
import { type MessagePort, parentPort, receiveMessageOnPort, workerData } from 'node:worker_threads';
import type { GainSpec } from '../core/agc';
import { Chunker, type ChunkerOut } from '../core/chunker';
import { sameMicName } from '../core/mics';
import { Resampler } from '../core/resample';
import { readWav } from '../engine/wav';
import * as wasapi from './wasapi';

export type ToMic =
  /** Opens the named endpoint (null: the default), or keeps the warm stream when it is the same one. */
  | { type: 'open'; label: string | null; t0: number }
  /** Stops forwarding audio to the chunker (the recording is ending), or starts it again. */
  | { type: 'forward'; on: boolean }
  /** Closes stream `gen` (an older one, replaced by a switch, is already closed). */
  | { type: 'close'; gen: number }
  | { type: 'session'; sid: number; gain: GainSpec }
  | { type: 'gain'; gain: GainSpec }
  | { type: 'flush'; sid: number }
  | { type: 'reset' }
  | { type: 'endpoints' };

export type FromMic =
  | ChunkerOut
  | { type: 'opened'; gen: number; label: string; bluetooth: boolean; warm: boolean; openMs: number }
  | { type: 'open-failed'; message: string }
  /** The first audio of a session reached the chunker, `ms` after the key-down time `t0` of its open. */
  | { type: 'first'; sid: number; ms: number }
  /** The open stream died (unplugged, disabled). */
  | { type: 'ended'; gen: number; message: string }
  | { type: 'endpoints'; list: { name: string; bluetooth: boolean }[] }
  | { type: 'error'; message: string };

const port = (workerData as { port: MessagePort; fakeWav?: string }).port;
const fakeFile = (workerData as { fakeWav?: string }).fakeWav;
const post = (m: FromMic, transfer?: ArrayBuffer[]) => port.postMessage(m, transfer as never);
const now = () => performance.timeOrigin + performance.now();

const chunker = new Chunker((m, transfer) => post(m, transfer));

interface Stream {
  key: string;
  label: string;
  bluetooth: boolean;
  rate: number;
  read(ms: number): Float32Array;
  close(): void;
}

let stream: Stream | null = null;
/** Bumped for every stream opened. */
let gen = 0;
let resampler: Resampler | null = null;
let forwarding = false;
let pumping = false;
/** The session whose first samples are still to be reported, and its key-down time. */
let firstFor: { sid: number; t0: number } | null = null;
let sid = 0;
let t0 = 0;

// ---------- the QA fake: a WAV played in real time ----------

let fake: Float32Array | null = null;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
function fakeStream(): Stream {
  if (!fake) {
    const w = readWav(fakeFile!);
    fake = new Resampler(w.sampleRate).push(w.samples);
  }
  const wav = fake;
  // A session's WAV carries on across a device switch, like a real voice would.
  const start = fakeStart ?? now();
  fakeStart = start;
  let pos = Math.round(((now() - start) / 1000) * 16000);
  return {
    key: 'fake',
    label: 'fake mic',
    bluetooth: false,
    rate: 16000,
    read(ms) {
      Atomics.wait(sleeper, 0, 0, Math.min(ms, 10));
      const upto = Math.round(((now() - start) / 1000) * 16000);
      const out = new Float32Array(Math.max(0, upto - pos));
      for (let i = 0; i < out.length; i++) out[i] = wav[pos + i] ?? 0;
      pos = upto;
      return out;
    },
    close() {},
  };
}
let fakeStart: number | null = null;

// ---------- opening ----------

function openEndpoint(label: string | null): Stream {
  if (fakeFile) return fakeStream();
  let ep: wasapi.Endpoint;
  if (label) {
    const all = wasapi.endpoints();
    const matches = all.filter((e) => sameMicName(e.name, label));
    for (const e of all) if (!matches.includes(e) || matches.length !== 1) wasapi.releaseEndpoint(e);
    // Two identical mics cannot be told apart by name here: the browser path, which has the exact device, takes it.
    if (matches.length !== 1) throw new Error(matches.length ? `${matches.length} mics are named "${label}"` : `no mic named "${label}"`);
    ep = matches[0];
  } else ep = wasapi.defaultEndpoint();
  const s = wasapi.open(ep);
  return { key: ep.id, label: ep.name, bluetooth: ep.bluetooth, rate: s.rate, read: (ms) => s.read(ms), close: () => s.close() };
}

function close(): void {
  if (!stream) return;
  try {
    stream.close();
  } catch {
    // already gone
  }
  stream = null;
  resampler = null;
  forwarding = false;
}

function doOpen(label: string | null, keyDown: number): void {
  const a = now();
  try {
    if (stream && !fakeFile && label === null) {
      // The default endpoint may have changed since the warm stream opened.
      const d = wasapi.defaultEndpoint();
      const same = d.id === stream.key;
      wasapi.releaseEndpoint(d);
      if (!same) close();
    } else if (stream && label !== null && !sameMicName(stream.label, label)) close();
    const warm = !!stream;
    if (!stream) {
      stream = openEndpoint(label);
      gen++;
      resampler = new Resampler(stream.rate);
    }
    forwarding = true;
    t0 = keyDown;
    firstFor = sid ? { sid, t0 } : null;
    post({ type: 'opened', gen, label: stream.label, bluetooth: stream.bluetooth, warm, openMs: Math.round(now() - a) });
    if (!pumping) setImmediate(pump);
  } catch (err) {
    close();
    post({ type: 'open-failed', message: (err as Error).message });
  }
}

function apply(m: ToMic): void {
  switch (m.type) {
    case 'open':
      doOpen(m.label, m.t0);
      return;
    case 'forward':
      forwarding = m.on;
      return;
    case 'close':
      if (m.gen !== gen) return;
      close();
      fakeStart = null;
      return;
    case 'session':
      sid = m.sid;
      fakeStart = null;
      chunker.session(m.sid, m.gain);
      if (stream) firstFor = { sid, t0 };
      return;
    case 'gain':
      chunker.setGain(m.gain);
      return;
    case 'flush':
      chunker.flush(m.sid);
      return;
    case 'reset':
      sid = 0;
      firstFor = null;
      chunker.reset();
      return;
    case 'endpoints': {
      try {
        const list = fakeFile ? [] : wasapi.endpoints();
        post({ type: 'endpoints', list: list.map((e) => ({ name: e.name, bluetooth: e.bluetooth })) });
        for (const e of list) wasapi.releaseEndpoint(e);
      } catch (err) {
        post({ type: 'error', message: (err as Error).message });
      }
      return;
    }
  }
}

/** Reads packets while a stream is open, handling commands between them. */
function pump(): void {
  pumping = true;
  try {
    while (stream) {
      let samples: Float32Array;
      try {
        samples = stream.read(20);
      } catch (err) {
        close();
        post({ type: 'ended', gen, message: (err as Error).message });
        break;
      }
      if (samples.length && resampler) {
        const s16 = resampler.push(samples);
        // A warm stream with no recording reads and drops its audio.
        if (forwarding && sid && s16.length) {
          if (firstFor && firstFor.sid === sid) {
            post({ type: 'first', sid, ms: Math.round(now() - firstFor.t0) });
            firstFor = null;
          }
          chunker.push(s16);
        }
      }
      for (let r = receiveMessageOnPort(port); r; r = receiveMessageOnPort(port)) apply(r.message as ToMic);
    }
  } finally {
    pumping = false;
  }
}

port.on('message', (m: ToMic) => apply(m));
try {
  if (!fakeFile) wasapi.init();
  parentPort!.postMessage({ type: 'ready' });
} catch (err) {
  parentPort!.postMessage({ type: 'failed', message: (err as Error).message });
}
