// L6 · The point-and-say helper's client: starts src/native/pointhelper/pointhelper.ps1 in its own process (COM and
// an app's accessibility tree stay out of Dictate), asks it what is under a point, and restarts it if it dies. One
// request in flight at a time; an answer that takes too long counts as nothing found.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseElement, type UiaElement } from '../../core/pointsay';
import type { Logger } from '../log';

export interface Hit {
  /** The left (primary) mouse button is down. */
  left: boolean;
  /** The point is over one of Dictate's own windows. */
  own: boolean;
  /** The top-level window there, found without UI Automation: its process decides the excluded apps. */
  process: string;
  title: string;
  /** What UI Automation read there; null where it can't (an elevated window, an empty desktop). */
  element: UiaElement | null;
}

export type HelperStatus = 'idle' | 'starting' | 'ready' | 'failed';

const ANSWER_MS = 1500;
const START_MS = 15_000;
const MAX_RESTARTS = 3;

/** Where the script is: beside the app when packaged (electron-builder.cjs extraResources), in the source tree otherwise. */
export function helperScript(appRoot: string, resources: string, packaged: boolean): string {
  return packaged ? path.join(resources, 'pointhelper', 'pointhelper.ps1') : path.join(appRoot, 'src', 'native', 'pointhelper', 'pointhelper.ps1');
}

export class PointHelper {
  status: HelperStatus = 'idle';
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<boolean> | null = null;
  private pending = new Map<number, (v: Record<string, unknown> | null) => void>();
  private next = 1;
  private restarts = 0;
  private stopped = false;

  constructor(
    private script: string,
    private ownPid: number,
    private log: Logger,
  ) {}

  /** Starts the helper if it isn't running; true once it answers. */
  start(): Promise<boolean> {
    if (this.ready) return this.ready;
    if (this.stopped || this.restarts > MAX_RESTARTS || !fs.existsSync(this.script)) {
      if (this.status !== 'failed') this.log('warn', `point: helper not started (${fs.existsSync(this.script) ? 'stopped too often' : `missing ${this.script}`})`);
      this.status = 'failed';
      return Promise.resolve(false);
    }
    this.status = 'starting';
    const root = process.env.SystemRoot ?? 'C:\\Windows';
    const exe = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script, '-OwnPid', String(this.ownPid)], { windowsHide: true, stdio: 'pipe' });
    this.child = child;
    let buf = '';
    let resolveReady: (ok: boolean) => void = () => {};
    this.ready = new Promise((r) => {
      resolveReady = r;
    });
    const startTimer = setTimeout(() => resolveReady(false), START_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      buf += d;
      for (let n = buf.indexOf('\n'); n >= 0; n = buf.indexOf('\n')) {
        const line = buf.slice(0, n).trim();
        buf = buf.slice(n + 1);
        if (!line) continue;
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.ready) {
          clearTimeout(startTimer);
          this.status = 'ready';
          resolveReady(true);
          continue;
        }
        const done = this.pending.get(Number(m.id));
        this.pending.delete(Number(m.id));
        done?.(m.ok ? m : null);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => this.log('warn', `point helper: ${d.trim().slice(0, 300)}`));
    const gone = (why: string) => {
      if (this.child !== child) return;
      clearTimeout(startTimer);
      resolveReady(false);
      this.child = null;
      this.ready = null;
      this.status = this.stopped ? 'idle' : 'failed';
      for (const done of this.pending.values()) done(null);
      this.pending.clear();
      if (!this.stopped) {
        this.restarts++;
        this.log('warn', `point: helper ended (${why})`);
      }
    };
    child.on('exit', (code) => gone(`exit ${code}`));
    child.on('error', (err) => gone(err.message));
    return this.ready;
  }

  /** What is at (x, y), physical pixels; null when the helper isn't there or doesn't answer in time. */
  async at(x: number, y: number, withText: boolean): Promise<Hit | null> {
    if (!(await this.start()) || !this.child) return null;
    const id = this.next++;
    const answer = new Promise<Record<string, unknown> | null>((resolve) => {
      this.pending.set(id, resolve);
      setTimeout(() => {
        if (this.pending.delete(id)) resolve(null);
      }, ANSWER_MS);
    });
    this.child.stdin.write(`${JSON.stringify({ id, op: 'at', x: Math.round(x), y: Math.round(y), text: withText })}\n`);
    const m = await answer;
    if (!m) return null;
    const hit = (m.hit ?? {}) as Record<string, unknown>;
    return { left: m.left === true, own: m.own === true, process: typeof hit.process === 'string' ? hit.process : '', title: typeof hit.title === 'string' ? hit.title : '', element: parseElement(m.element) };
  }

  stop(): void {
    this.stopped = true;
    const c = this.child;
    this.child = null;
    this.ready = null;
    this.status = 'idle';
    c?.stdin.end();
    setTimeout(() => c?.kill(), 500).unref();
  }
}
