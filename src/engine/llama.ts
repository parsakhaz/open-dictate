// One llama-server per cleanup model (from voice-lab's LlamaServer): spawn, health, one warm-up with the real
// system prompt, then idle at zero CPU (--poll 0, no polling from us). Restarts itself after a crash.
import { type ChildProcess, spawn } from 'node:child_process';
import net from 'node:net';

export type Log = (level: 'info' | 'warn' | 'error', msg: string) => void;

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

export interface LlamaOptions {
  exe: string;
  gguf: string;
  /** Context per slot; the v3 prompt with ~60 terms is ~900 tokens, a long dictation a few hundred more. */
  ctx?: number;
  /** Sent once after start-up so the system prompt is cached and Vulkan is warm. */
  warmup?: () => Record<string, unknown>;
  log: Log;
  spawn?: typeof spawn;
  /** Test seam: the port finder. */
  freePort?: () => Promise<number>;
  /** Called with each new server's pid (main ties it to dictate's lifetime). */
  adopt?: (pid: number) => void;
}

export type ServerState = 'stopped' | 'starting' | 'ready' | 'crashed';

export function llamaArgs(gguf: string, port: number, ctx: number): string[] {
  return [
    '-m', gguf,
    '--host', '127.0.0.1',
    '--port', String(port),
    // Every layer on the iGPU (Vulkan), flash attention, one slot: one dictation at a time.
    '-ngl', '99',
    '-fa', 'on',
    '-c', String(ctx),
    '-np', '1',
    // Weights stay resident: mmap, locked into RAM so Windows does not page them out between dictations.
    '-lm', 'mmap+mlock',
    // No busy-wait between requests: an idle server costs ~0% CPU.
    '--poll', '0',
    '-t', '4',
    '--jinja',
    '--no-webui',
  ];
}

export class LlamaServer {
  private proc?: ChildProcess;
  private port = 0;
  private readyPromise?: Promise<void>;
  state: ServerState = 'stopped';
  private wanted = false;
  private restarts = 0;
  private restartTimer?: ReturnType<typeof setTimeout>;
  /** Bumped by every launch and stop: a launch whose generation is stale never claims the server's state. */
  private gen = 0;
  /** Called on every state change, for the tray and settings. */
  onState?: (s: ServerState) => void;

  constructor(
    readonly name: string,
    private readonly opts: LlamaOptions,
  ) {}

  private set(s: ServerState): void {
    this.state = s;
    this.onState?.(s);
  }

  /** Starts the server if it is not running; resolves once it has answered its warm-up. */
  start(): Promise<void> {
    this.wanted = true;
    if (!this.readyPromise) {
      const gen = ++this.gen;
      const p = this.launch(gen);
      this.readyPromise = p;
      p.catch((err) => {
        // A launch superseded by stop() or a newer launch is not a failure of the current one.
        if (gen !== this.gen) return;
        this.opts.log('error', `${this.name}: ${(err as Error).message}`);
        this.readyPromise = undefined;
        this.set('crashed');
        this.scheduleRestart();
      });
    }
    return this.readyPromise;
  }

  /** Resolves true once ready, false if not wanted or not ready within `ms`. */
  async whenReady(ms: number): Promise<boolean> {
    if (!this.wanted) return false;
    if (this.state === 'ready') return true;
    const p = this.readyPromise ?? this.start();
    let t: ReturnType<typeof setTimeout> | undefined;
    const ok = await Promise.race([p.then(() => true, () => false), new Promise<boolean>((r) => (t = setTimeout(() => r(false), ms)))]);
    clearTimeout(t);
    return ok;
  }

  private scheduleRestart(): void {
    if (!this.wanted || this.restartTimer) return;
    // 1 s, 2 s, 4 s ... capped at 30 s; a healthy run resets the count.
    const delay = Math.min(30_000, 1000 * 2 ** this.restarts++);
    this.opts.log('warn', `${this.name}: restarting in ${delay / 1000} s`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.wanted) void this.start().catch(() => undefined);
    }, delay);
  }

  private async launch(gen: number): Promise<void> {
    this.set('starting');
    // The port stays local to this launch until it is ready and still current: a stale launch finishing late
    // must never repoint the server at its port.
    const port = await (this.opts.freePort ?? freePort)();
    const current = () => this.wanted && gen === this.gen;
    if (!current()) throw new Error('stopped');
    const t0 = performance.now();
    const args = llamaArgs(this.opts.gguf, port, this.opts.ctx ?? 4096);
    const proc = (this.opts.spawn ?? spawn)(this.opts.exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    this.proc = proc;
    if (proc.pid) this.opts.adopt?.(proc.pid);
    let spawnError: Error | undefined;
    proc.on('error', (err) => {
      spawnError = err;
    });
    let tail = '';
    proc.stderr?.on('data', (d) => {
      tail = (tail + d).slice(-4000);
    });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      this.readyPromise = undefined;
      if (!this.wanted) return this.set('stopped');
      this.opts.log('error', `${this.name} llama-server exited (${code}): ${tail.split('\n').slice(-3).join(' | ')}`);
      this.set('crashed');
      this.scheduleRestart();
    });
    try {
      for (;;) {
        if (!current()) throw new Error('stopped');
        if (spawnError) throw new Error(`llama-server could not start (${this.opts.exe}): ${spawnError.message}`);
        if (proc.exitCode !== null) throw new Error(`llama-server exited (${proc.exitCode}) during start-up: ${tail.slice(-500)}`);
        try {
          const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
          if (r.ok) break;
        } catch {
          // not listening yet
        }
        if (performance.now() - t0 > 120_000) throw new Error(`not healthy after 120 s: ${tail.slice(-500)}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      const loadMs = performance.now() - t0;
      if (this.opts.warmup) {
        const w0 = performance.now();
        await this.post(port, this.opts.warmup(), AbortSignal.timeout(60_000));
        this.opts.log('info', `${this.name} ready in ${(loadMs / 1000).toFixed(2)} s, warm-up ${(performance.now() - w0).toFixed(0)} ms`);
      } else {
        this.opts.log('info', `${this.name} ready in ${(loadMs / 1000).toFixed(2)} s`);
      }
      if (!current()) throw new Error('stopped');
    } catch (err) {
      // A failed or abandoned launch takes its process with it, so retries never pile up resident models.
      if (this.proc === proc) this.proc = undefined;
      proc.kill();
      throw err;
    }
    this.port = port;
    this.restarts = 0;
    this.set('ready');
  }

  private async post(port: number, body: Record<string, unknown>, signal?: AbortSignal): Promise<{ choices?: { message?: { content?: string } }[]; timings?: Record<string, number> }> {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return (await r.json()) as never;
  }

  /** One chat completion; returns the reply's content. */
  async complete(body: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    if (this.state !== 'ready') throw new Error(`${this.name} is ${this.state}`);
    const j = await this.post(this.port, body, signal);
    return j.choices?.[0]?.message?.content ?? '';
  }

  /** Kills the process (battery unload or quit). start() brings it back. */
  stop(): void {
    this.wanted = false;
    this.gen++;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.readyPromise = undefined;
    const p = this.proc;
    this.proc = undefined;
    p?.kill();
    this.set('stopped');
  }

  /** For QA: kill the process as a crash would. */
  crashForTest(): void {
    this.proc?.kill();
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }
}
