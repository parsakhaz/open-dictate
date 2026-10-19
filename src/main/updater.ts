// Auto-update (C6, D11): checks GitHub Releases a minute after start and daily. Where the build can replace
// itself (Windows, AppImage) it downloads in the background and installs on quit, or after 10 idle minutes,
// never during a recording, cleanup or download; elsewhere it only says a new version is out. No Electron
// imports: main passes the engine (electron-updater) and the timers, so the rules are testable.
import { type Busy, installWaitMs, isNewer, nextCheckMs, type UpdateMode, versionFromTag } from '../core/updates';

export interface UpdateState {
  status: 'off' | 'disabled' | 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error';
  mode: UpdateMode;
  version?: string;
  /** The release page, for "notify" builds that cannot install themselves. */
  url?: string;
  percent?: number;
  message?: string;
  checkedAt?: string;
}

/** The parts of electron-updater this uses. */
export interface UpdateEngine {
  check(): Promise<void>;
  /** Quits, installs silently and relaunches (to the tray). */
  install(): void;
  on(event: 'available', cb: (version: string) => void): void;
  on(event: 'none', cb: () => void): void;
  on(event: 'progress', cb: (percent: number) => void): void;
  on(event: 'downloaded', cb: (version: string) => void): void;
  on(event: 'error', cb: (message: string) => void): void;
}

export interface UpdaterDeps {
  mode: UpdateMode;
  currentVersion: string;
  enabled: () => boolean;
  busy: () => Busy;
  lastActivityAt: () => number;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Required in "install" mode. */
  engine?: UpdateEngine;
  /** The latest release's tag and page, for "notify" mode. */
  latestRelease?: () => Promise<{ tag: string; url: string } | null>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  onChange?: () => void;
}

export class Updater {
  state: UpdateState;
  private checkTimer: unknown;
  private installTimer: unknown;
  private lastCheckAt: number | null = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly d: UpdaterDeps) {
    this.now = d.now ?? Date.now;
    this.setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.state = { status: d.mode === 'off' ? 'off' : d.enabled() ? 'idle' : 'disabled', mode: d.mode };
    const e = d.engine;
    if (d.mode !== 'install' || !e) return;
    e.on('available', (version) => this.set({ status: 'downloading', version, percent: 0 }));
    e.on('none', () => this.set({ status: 'up-to-date' }));
    e.on('progress', (percent) => this.set({ status: 'downloading', percent: Math.round(percent) }));
    e.on('downloaded', (version) => {
      this.set({ status: 'ready', version });
      this.d.log('info', `update ${version} downloaded; installs on quit or after 10 idle minutes`);
      this.armInstall();
    });
    e.on('error', (message) => {
      this.set({ status: 'error', message });
      this.d.log('warn', `update check failed: ${message}`);
    });
  }

  private set(patch: Partial<UpdateState>): void {
    // A new status drops the old one's message and progress; the version, page and check time stay.
    const { message: _m, percent: _p, ...lasting } = this.state;
    const fresh = patch.status !== undefined && patch.status !== this.state.status;
    this.state = { ...(fresh ? lasting : this.state), ...patch, mode: this.d.mode };
    this.d.onChange?.();
  }

  /** Arms the next scheduled check; one timer, no polling. */
  start(): void {
    this.clearTimer(this.checkTimer);
    if (this.d.mode === 'off' || !this.d.enabled()) return;
    this.checkTimer = this.setTimer(() => void this.check().finally(() => this.start()), nextCheckMs(this.lastCheckAt, this.now()));
  }

  /** The setting changed. */
  setEnabled(on: boolean): void {
    if (this.d.mode === 'off') return;
    if (!on) {
      this.clearTimer(this.checkTimer);
      this.clearTimer(this.installTimer);
      if (this.state.status !== 'ready') this.set({ status: 'disabled' });
      return;
    }
    if (this.state.status === 'disabled') this.set({ status: 'idle' });
    this.start();
  }

  async check(): Promise<void> {
    if (this.d.mode === 'off' || this.state.status === 'checking' || this.state.status === 'downloading' || this.state.status === 'ready') return;
    this.lastCheckAt = this.now();
    this.set({ status: 'checking', checkedAt: new Date(this.now()).toISOString() });
    try {
      if (this.d.mode === 'install' && this.d.engine) {
        await this.d.engine.check();
        // The engine's events set the outcome; a check that raised none found nothing.
        if ((this.state.status as UpdateState['status']) === 'checking') this.set({ status: 'up-to-date' });
        return;
      }
      const latest = await this.d.latestRelease?.();
      const version = latest && versionFromTag(latest.tag);
      if (latest && version && isNewer(version, this.d.currentVersion)) this.set({ status: 'available', version, url: latest.url });
      else this.set({ status: 'up-to-date' });
    } catch (err) {
      this.set({ status: 'error', message: (err as Error).message });
      this.d.log('warn', `update check failed: ${(err as Error).message}`);
    }
  }

  /** Dictation, cleanup or a download just ended: the idle clock restarts. */
  activity(): void {
    if (this.state.status === 'ready') this.armInstall();
  }

  private armInstall(): void {
    this.clearTimer(this.installTimer);
    if (!this.d.enabled()) return;
    const wait = installWaitMs(this.d.busy(), this.d.lastActivityAt(), this.now());
    // Busy: whatever is running calls activity() when it ends.
    if (wait === null) return;
    this.installTimer = this.setTimer(() => {
      // Something may have started since the timer was armed.
      if (installWaitMs(this.d.busy(), this.d.lastActivityAt(), this.now()) === 0) {
        this.d.log('info', `installing update ${this.state.version} after 10 idle minutes`);
        this.d.engine?.install();
      } else this.armInstall();
    }, wait);
  }
}
