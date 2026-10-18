// Main-thread side of the native mic worker: starts it, and adapts it to the CaptureController's backend, so
// native capture keeps the same session queue, device switching, silence watch and session-tagged audio as the
// browser path. Holding the stream open after a recording (the warm period) is decided by WarmMic.
import { MessageChannel, Worker } from 'node:worker_threads';
import type { CaptureBackend, MicStream, SttMsg, WorkletMsg } from '../core/capture';
import type { ChunkerOut } from '../core/chunker';
import type { WarmMic } from '../core/warm';
import type { FromMic, ToMic } from '../native/mic-worker';

export interface NativeMicDeps {
  /** The endpoint name for a browser deviceId (null: the system default). */
  labelFor(deviceId: string | null): string | null;
  stt(m: SttMsg): void;
  /** Chunker output for the CaptureController. */
  onAudio(m: ChunkerOut): void;
  /** The first audio of session `sid` arrived, `ms` after its key down; `warm` when the stream was already open. */
  onFirst(sid: number, ms: number, warm: boolean): void;
  onOpened(label: string, bluetooth: boolean, warm: boolean, openMs: number): void;
  log(level: 'info' | 'warn' | 'error', msg: string): void;
  /** Key-down time (performance.timeOrigin + performance.now()) of the recording being opened. */
  keyDownAt(): number;
}

type Opened = Extract<FromMic, { type: 'opened' }>;

export class NativeMic implements CaptureBackend {
  private readonly worker: Worker;
  private readonly port: MessageChannel['port1'];
  readonly ready: Promise<boolean>;
  private waiting: ((m: Opened | Error) => void) | null = null;
  private current = 0;
  private lastWarm = false;
  private readonly ended = new Map<number, () => void>();
  /** A named mic failed to open natively in this start: the default must not stand in for it. */
  private namedFailed = false;
  warm?: WarmMic;

  constructor(
    script: string,
    private readonly deps: NativeMicDeps,
    fakeWav?: string,
  ) {
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    this.worker = new Worker(script, { workerData: { port: port2, fakeWav }, transferList: [port2] });
    this.ready = new Promise((resolve) => {
      this.worker.once('message', (m: { type: string; message?: string }) => {
        if (m.type !== 'ready') deps.log('warn', `native mic unavailable: ${m.message}`);
        resolve(m.type === 'ready');
      });
      this.worker.once('error', (err) => {
        deps.log('error', `native mic worker: ${err.message}`);
        resolve(false);
      });
    });
    this.port.on('message', (m: FromMic) => this.onMessage(m));
  }

  private send(m: ToMic): void {
    this.port.postMessage(m);
  }

  private onMessage(m: FromMic): void {
    switch (m.type) {
      case 'chunk':
      case 'level':
      case 'flushed':
        this.deps.onAudio(m);
        return;
      case 'opened':
      case 'open-failed':
        this.waiting?.(m.type === 'opened' ? m : new Error(m.message));
        this.waiting = null;
        return;
      case 'first':
        this.deps.onFirst(m.sid, m.ms, this.lastWarm);
        return;
      case 'ended':
        this.ended.get(m.gen)?.();
        return;
      case 'error':
        this.deps.log('warn', `native mic: ${m.message}`);
        return;
    }
  }

  /** Closes a warm stream (WarmMic's decision). */
  closeWarm(): void {
    this.send({ type: 'close', gen: this.current });
  }

  // ---------- CaptureBackend ----------

  async prepare(): Promise<void> {
    if (!(await this.ready)) throw new Error('native mic unavailable');
  }

  async open(deviceId: string | null): Promise<MicStream> {
    if (deviceId === null && this.namedFailed) {
      this.namedFailed = false;
      throw new Error('the chosen mic could not be opened natively');
    }
    const label = deviceId === null ? null : this.deps.labelFor(deviceId);
    const opened = await new Promise<Opened | Error>((resolve) => {
      this.waiting = resolve;
      this.send({ type: 'open', label, t0: this.deps.keyDownAt() });
    });
    if (opened instanceof Error) {
      if (deviceId !== null) this.namedFailed = true;
      throw opened;
    }
    this.namedFailed = false;
    this.current = opened.gen;
    this.lastWarm = opened.warm;
    this.warm?.started();
    this.deps.onOpened(opened.label, opened.bluetooth, opened.warm, opened.openMs);
    const gen = opened.gen;
    return {
      label: opened.label,
      stop: () => {
        this.ended.delete(gen);
        // Replaced by a newer stream (a device switch): the worker already closed it.
        if (gen !== this.current) return;
        // WarmMic keeps it open, or closes it through closeWarm().
        if (this.warm) this.warm.ended();
        else this.send({ type: 'close', gen });
      },
      onEnded: (cb) => this.ended.set(gen, cb),
    };
  }

  connect(): void {
    this.send({ type: 'forward', on: true });
  }

  disconnect(): void {
    this.send({ type: 'forward', on: false });
  }

  async resume(): Promise<void> {}

  async suspend(): Promise<void> {}

  worklet(m: WorkletMsg): void {
    this.send(m);
  }

  stt(m: SttMsg): void {
    this.deps.stt(m);
  }

  endpoints(): Promise<{ name: string; bluetooth: boolean }[]> {
    return new Promise((resolve) => {
      const l = (m: FromMic) => {
        if (m.type !== 'endpoints') return;
        this.port.off('message', l);
        resolve(m.list);
      };
      this.port.on('message', l);
      this.send({ type: 'endpoints' });
    });
  }

  stop(): void {
    void this.worker.terminate();
  }
}
