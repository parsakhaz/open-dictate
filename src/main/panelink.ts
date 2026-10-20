// Dictate's link to Pane, only through runpane: a supervised `runpane watch` for agent states, and one-shot
// commands for names, an agent's last reply, opening a tab and sending a reply. No Electron imports.
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { lineReader } from '../core/agentwire';
import { backoffMs, type Launch, paneLink, parseWatchEntry, runpaneLaunch, type WatchEvent, watchArgs } from '../core/panewatch';
import type { Logger } from './log';

export interface TabNames {
  paneId: string;
  paneName: string;
  panelTitle?: string;
  agentType?: string;
}

export interface PaneLinkOptions {
  paneDir: string;
  log: Logger;
  onEvent(e: WatchEvent): void;
  onAttached?(attached: boolean): void;
}

/** A process run on behalf of the person: never inherits the Pane tab ids Dictate itself may have been started with. */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.PANE_SESSION_ID;
  delete env.PANE_PANEL_ID;
  return env;
}

export class PaneLink {
  private watch: ChildProcess | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private stopped = true;
  private names = new Map<string, TabNames>();
  attached = false;

  constructor(private opts: PaneLinkOptions) {}

  private launch(): Launch | null {
    return runpaneLaunch(this.opts.paneDir, process.platform, (f) => {
      try {
        return fs.readFileSync(f, 'utf8');
      } catch {
        return null;
      }
    });
  }

  get installed(): boolean {
    return this.launch() !== null;
  }

  start(): void {
    this.stopped = false;
    this.follow();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.watch?.kill();
    this.watch = undefined;
    this.setAttached(false);
    // Nothing keeps them current from here on, and a restarted watch only reports what happens next.
    this.names.clear();
  }

  private setAttached(on: boolean): void {
    if (this.attached === on) return;
    this.attached = on;
    this.opts.onAttached?.(on);
  }

  private retry(): void {
    if (this.stopped) return;
    this.failures++;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.follow(), backoffMs(this.failures));
  }

  private follow(): void {
    if (this.stopped || this.watch) return;
    const l = this.launch();
    if (!l) {
      this.retry();
      return;
    }
    const startedAt = Date.now();
    const child = spawn(l.file, [...l.args, ...watchArgs()], { env: childEnv(l.env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.watch = child;
    let errText = '';
    child.stdout?.on(
      'data',
      lineReader((m) => {
        // Output a stopped watch had already buffered is not followed.
        if (this.watch !== child) return;
        const e = parseWatchEntry(m, startedAt);
        if (!this.attached) {
          this.setAttached(true);
          this.opts.log('info', 'pane: watching agent states');
        }
        if (!e) return;
        if (e.panelId) this.names.set(e.panelId, { paneId: e.paneId, paneName: e.paneName, panelTitle: e.panelTitle, agentType: e.agentType });
        this.opts.onEvent(e);
      }),
    );
    child.stderr?.on('data', (d) => {
      errText = `${errText}${d}`.slice(-400);
    });
    child.on('error', (err) => {
      errText = err.message;
    });
    child.on('close', (code) => {
      if (this.watch !== child) return;
      this.watch = undefined;
      this.names.clear();
      this.setAttached(false);
      // A watch that ran a while was healthy: start the backoff again from the beginning.
      if (Date.now() - startedAt > 30_000) this.failures = 0;
      if (!this.stopped) this.opts.log(this.failures ? 'info' : 'warn', `pane: watch ended (${code ?? 'signal'})${errText ? `: ${errText.trim().split('\n').pop()}` : ''}`);
      this.retry();
    });
    // runpane prints nothing until something happens: a watch alive for a few seconds is attached.
    setTimeout(() => {
      if (this.watch === child && child.exitCode === null) this.setAttached(true);
    }, 3000);
  }

  /** Runs `runpane <args> --json` and parses its answer; rejects with runpane's own message. */
  run<T>(args: string[], timeoutMs = 8000): Promise<T> {
    const l = this.launch();
    if (!l) return Promise.reject(new Error("Pane's runpane CLI isn't installed"));
    return new Promise((resolve, reject) => {
      execFile(l.file, [...l.args, ...args, '--json'], { env: childEnv(l.env), timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          parsed = undefined;
        }
        if (parsed && typeof parsed === 'object' && (parsed as { ok?: unknown }).ok !== false) return resolve(parsed as T);
        const msg = (parsed as { error?: { message?: string } } | undefined)?.error?.message ?? (String(stderr).trim() || err?.message || 'runpane failed');
        reject(new Error(msg.split('\n')[0].slice(0, 300)));
      });
    });
  }

  /** The Pane name, tab title and agent of one tab: from the watch when it has seen it, else asked once. */
  async tabNames(paneId: string, panelId: string): Promise<TabNames | null> {
    // Names are kept current only by a running watch's events; without one, ask runpane each time.
    const known = this.watch ? this.names.get(panelId) : undefined;
    if (known && known.paneId === paneId) return known;
    const watch = this.watch;
    try {
      const panes = await this.run<{ panes: { id: string; name: string }[] }>(['panes', 'list']);
      const pane = panes.panes.find((p) => p.id === paneId);
      if (!pane) return null;
      const panels = await this.run<{ panels: { id: string; title: string; agentType?: string }[] }>(['panels', 'list', '--pane', paneId]);
      const found = panels.panels.map((p): [string, TabNames] => [p.id, { paneId, paneName: pane.name, panelTitle: p.title, agentType: p.agentType }]);
      // Kept only while the watch that was running when the lookup began still runs to keep them current.
      if (watch && this.watch === watch) for (const [id, names] of found) this.names.set(id, names);
      return found.find(([id]) => id === panelId)?.[1] ?? null;
    } catch {
      return null;
    }
  }

  /** What the agent in a tab last said, from its transcript; null when Pane can't tell. */
  async lastMessage(panelId: string, limit = 2000): Promise<string | null> {
    try {
      const r = await this.run<{ text?: string; message?: string }>(['panels', 'last-message', '--panel', panelId, '--limit', String(limit)]);
      return r.text ?? r.message ?? null;
    } catch {
      return null;
    }
  }

  /** Brings Pane forward on exactly that tab. Only ever after the person's click. */
  async open(paneId: string, panelId: string): Promise<boolean> {
    try {
      await this.run(['links', 'open', '--url', paneLink(paneId, panelId), '--yes']);
      return true;
    } catch (err) {
      this.opts.log('warn', `pane: could not open the tab (${(err as Error).message})`);
      return false;
    }
  }

  /** Types and submits the person's reply in that tab. Only ever after their key press. */
  async send(panelId: string, text: string): Promise<{ delivered: boolean; blocked?: string }> {
    try {
      const r = await this.run<{ delivered?: boolean; blocked?: string }>(['agents', 'send', '--panel', panelId, '--text', text, '--yes'], 20_000);
      return { delivered: r.delivered === true, ...(r.blocked ? { blocked: r.blocked } : {}) };
    } catch (err) {
      return { delivered: false, blocked: (err as Error).message };
    }
  }
}
