// Main-thread side of the keyboard hook worker: starts it, forwards config, restarts it if it dies.
import { MessageChannel, Worker } from 'node:worker_threads';
import { WM_APP_WAKE, WM_QUIT } from '../native/constants';
import type { FromHook, ToHook } from '../native/keyhook-worker';
import { platformCapabilities, reportHookUnavailable } from '../native/platform';
import { PortableKeyHook, type PortableHookSource } from '../native/portable-keyhook';

const postThreadMessage = (tid: number, message: number): boolean =>
  (require('../native/win32') as typeof import('../native/win32')).postThreadMessage(tid, message);

export class KeyHook {
  private worker?: Worker;
  private port?: MessageChannel['port1'];
  private tid = 0;
  private stopping = false;
  private last: ToHook[] = [];
  private restarts = 0;
  private portable?: PortableKeyHook;
  private restartTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly script: string,
    private readonly onEvent: (e: FromHook) => void,
    private readonly log: (level: 'info' | 'warn' | 'error', msg: string) => void,
  ) {}

  start(): void {
    if (this.worker || this.portable) return;
    this.stopping = false;
    if (process.platform !== 'win32') {
      const capabilities = platformCapabilities();
      if (!capabilities.globalHotkeys) {
        const message = capabilities.reason ?? 'Global keyboard input is unavailable. Use Dictate’s Start/Stop controls.';
        this.log('warn', message);
        this.onEvent({ type: 'error', message });
        return;
      }
      try {
        const { uIOhook } = require('uiohook-napi') as { uIOhook: PortableHookSource };
        this.portable = new PortableKeyHook(uIOhook, this.onEvent);
        this.portable.start();
        reportHookUnavailable();
        for (const message of this.last) this.portable.send(message);
        this.log('info', 'global keyboard input ready (keys are observed, not swallowed)');
      } catch (err) {
        this.portable = undefined;
        const message = `Global keyboard input unavailable: ${(err as Error).message}`;
        reportHookUnavailable(message);
        this.log('warn', message);
        this.onEvent({ type: 'error', message });
      }
      return;
    }
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    const w = new Worker(this.script, { workerData: { port: port2 }, transferList: [port2] });
    this.worker = w;
    w.on('message', (m: FromHook) => {
      if (m.type === 'ready') {
        this.tid = m.tid;
        this.restarts = 0;
        this.log('info', `keyboard hook ready on thread ${m.tid}`);
        // Re-apply config after a restart.
        for (const c of this.last) this.send(c, false);
      } else if (m.type === 'error') this.log('error', `keyboard hook: ${m.message}`);
      this.onEvent(m);
    });
    w.on('error', (err) => this.log('error', `keyboard hook worker: ${err.message}`));
    w.on('exit', (code) => {
      if (this.worker !== w) return;
      this.worker = undefined;
      this.port?.close();
      this.port = undefined;
      this.tid = 0;
      if (this.stopping) return;
      const delay = Math.min(10_000, 500 * 2 ** this.restarts++);
      this.log('warn', `keyboard hook exited (${code}); restarting in ${delay} ms`);
      this.restartTimer = setTimeout(() => !this.stopping && this.start(), delay);
    });
  }

  /** Sends config to the hook thread and wakes it to read it. Config is remembered across restarts. */
  send(m: ToHook, remember = true): void {
    if (remember) this.last = [...this.last.filter((c) => c.type !== m.type), m];
    if (this.portable) { this.portable.send(m); return; }
    if (!this.port || !this.tid) return;
    this.port.postMessage(m);
    postThreadMessage(this.tid, WM_APP_WAKE);
  }

  stop(): void {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.portable?.stop();
    this.portable = undefined;
    if (this.tid) postThreadMessage(this.tid, WM_QUIT);
    const w = this.worker;
    this.worker = undefined;
    this.port?.close();
    this.port = undefined;
    // The thread leaves GetMessage on WM_QUIT; terminate as a backstop.
    setTimeout(() => void w?.terminate(), 500);
  }
}
