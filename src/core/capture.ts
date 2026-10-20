// Capture sessions, independent of the browser APIs so they can be tested. Every start, stop, cancel and device
// switch runs through one queue, so a new recording can never overlap the flush of the previous one; audio is
// matched to its session by id, so nothing from one recording reaches another. Pure apart from the injected backend.
import type { GainSpec } from './agc';
import { SilenceWatch } from './audio';
import type { ChunkerOut } from './chunker';

export interface MicStream {
  label: string;
  stop(): void;
  onEnded(cb: () => void): void;
}

export type WorkletMsg = { type: 'session'; sid: number; gain: GainSpec } | { type: 'gain'; gain: GainSpec } | { type: 'flush'; sid: number } | { type: 'reset' };

export type SttMsg = { type: 'begin'; id: number } | { type: 'frame'; id: number; samples: Float32Array } | { type: 'end'; id: number } | { type: 'cancel'; id: number };

export interface CaptureBackend {
  /** Builds the audio graph once. */
  prepare(): Promise<void>;
  /** Opens a microphone (null = the system default), or the QA fake when one is configured. */
  open(deviceId: string | null): Promise<MicStream>;
  connect(s: MicStream): void;
  disconnect(s: MicStream): void;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  worklet(m: WorkletMsg): void;
  stt(m: SttMsg): void;
}

export interface CaptureEvents {
  started(id: number, label: string, openMs: number): void;
  error(id: number, message: string): void;
  /** The mic stream ended mid-recording; capture already moved to the default mic. */
  lost(id: number, label: string): void;
  /** The mic ended and no other could be opened: main finishes the recording with what was heard. */
  failed(id: number, message: string): void;
  silent(id: number, silent: boolean): void;
  level(rms: number, peak: number): void;
  /** The recording ended on mic `label` with this gain applied: the next one starts there. */
  gain(id: number, label: string, gainDb: number): void;
}

interface Session {
  id: number;
  stream: MicStream | null;
  silence: SilenceWatch;
  silent: boolean;
  ending: boolean;
  /** The gain the worklet last reported, once it has reported one. */
  gainDb: number | null;
}

/** Longest wait for the worklet to hand over its last partial chunk. */
export const FLUSH_WAIT_MS = 150;

export class CaptureController {
  private queue: Promise<void> = Promise.resolve();
  private session: Session | null = null;
  private readonly flushed = new Map<number, () => void>();

  constructor(
    private readonly backend: CaptureBackend,
    private readonly events: CaptureEvents,
    private readonly now: () => number = () => performance.now(),
  ) {}

  private enqueue(op: () => Promise<void>): Promise<void> {
    const run = this.queue.then(op, op);
    this.queue = run.catch(() => undefined);
    return run;
  }

  get current(): number | null {
    return this.session?.id ?? null;
  }

  start(id: number, deviceId: string | null, gain: GainSpec): Promise<void> {
    return this.enqueue(() => this.doStart(id, deviceId, gain));
  }

  stop(id: number): Promise<void> {
    return this.enqueue(() => this.doStop(id));
  }

  cancel(id: number): Promise<void> {
    return this.enqueue(() => this.doCancel(id));
  }

  switchDevice(id: number, deviceId: string | null, gain: GainSpec): Promise<void> {
    return this.enqueue(() => this.doSwitch(id, deviceId, gain));
  }

  private async openWithFallback(deviceId: string | null): Promise<MicStream> {
    if (deviceId) {
      try {
        return await this.backend.open(deviceId);
      } catch {
        // gone between enumeration and now: the default mic instead
      }
    }
    return this.backend.open(null);
  }

  private attach(s: Session, stream: MicStream): void {
    if (s.stream) {
      this.backend.disconnect(s.stream);
      s.stream.stop();
    }
    s.stream = stream;
    this.backend.connect(stream);
    stream.onEnded(() => this.onEnded(s, stream));
  }

  private onEnded(s: Session, stream: MicStream): void {
    if (this.session !== s || s.stream !== stream || s.ending) return;
    this.events.lost(s.id, stream.label);
    void this.enqueue(async () => {
      if (this.session !== s || s.stream !== stream || s.ending) return;
      this.backend.disconnect(stream);
      s.stream = null;
      try {
        this.attach(s, await this.backend.open(null));
      } catch (err) {
        this.events.failed(s.id, (err as Error).message);
      }
    });
  }

  private async doStart(id: number, deviceId: string | null, gain: GainSpec): Promise<void> {
    const t0 = this.now();
    await this.backend.prepare();
    if (this.session) await this.doCancel(this.session.id);
    const s: Session = { id, stream: null, silence: new SilenceWatch(), silent: false, ending: false, gainDb: null };
    this.session = s;
    this.backend.stt({ type: 'begin', id });
    this.backend.worklet({ type: 'session', sid: id, gain });
    try {
      this.attach(s, await this.openWithFallback(deviceId));
      await this.backend.resume();
      this.events.started(id, s.stream!.label, Math.round(this.now() - t0));
    } catch (err) {
      this.session = null;
      this.backend.worklet({ type: 'reset' });
      this.backend.stt({ type: 'cancel', id });
      this.events.error(id, (err as Error).message);
    }
  }

  private async doSwitch(id: number, deviceId: string | null, gain: GainSpec): Promise<void> {
    const s = this.session;
    if (!s || s.id !== id || s.ending) return;
    this.backend.worklet({ type: 'gain', gain });
    s.gainDb = null;
    try {
      this.attach(s, await this.openWithFallback(deviceId));
    } catch (err) {
      this.events.error(id, (err as Error).message);
    }
  }

  private close(s: Session): void {
    if (s.stream) {
      this.backend.disconnect(s.stream);
      s.stream.stop();
      s.stream = null;
    }
  }

  /** Sends the last partial chunk, then the end marker; the recognizer answers main with the final. */
  private async doStop(id: number): Promise<void> {
    const s = this.session;
    if (!s || s.id !== id) {
      // Never started (the mic failed): still end the recognizer stream so main gets a final.
      this.backend.stt({ type: 'end', id });
      return;
    }
    s.ending = true;
    if (s.stream) this.backend.disconnect(s.stream);
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.flushed.delete(id);
        resolve();
      }, FLUSH_WAIT_MS);
      this.flushed.set(id, () => {
        clearTimeout(t);
        this.flushed.delete(id);
        resolve();
      });
      this.backend.worklet({ type: 'flush', sid: id });
    });
    this.session = null;
    if (s.stream && s.gainDb !== null) this.events.gain(id, s.stream.label, s.gainDb);
    this.close(s);
    this.backend.worklet({ type: 'reset' });
    this.backend.stt({ type: 'end', id });
    await this.backend.suspend();
  }

  private async doCancel(id: number): Promise<void> {
    const s = this.session;
    if (!s || s.id !== id) return;
    s.ending = true;
    this.session = null;
    this.close(s);
    this.backend.worklet({ type: 'reset' });
    this.backend.stt({ type: 'cancel', id });
    await this.backend.suspend();
  }

  /** Messages from the worklet. Only the current session's audio is forwarded. */
  onWorklet(m: ChunkerOut): void {
    if (m.type === 'flushed') {
      this.flushed.get(m.sid)?.();
      return;
    }
    const s = this.session;
    if (!s || m.sid !== s.id) return;
    if (m.type === 'chunk') {
      this.backend.stt({ type: 'frame', id: s.id, samples: m.samples });
      return;
    }
    this.events.level(m.rms, m.peak);
    s.gainDb = m.gainDb;
    const silent = s.silence.push(m.rms, (512 / 16000) * 1000);
    if (silent !== s.silent) {
      s.silent = silent;
      this.events.silent(s.id, silent);
    }
  }
}
