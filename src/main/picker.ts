// The history picker's lifecycle: create, wait for its page, open at the caret, route keys, close. The window and
// the keyboard hook are injected, so the failure paths are unit-tested. Keyboard capture is the dangerous part
// (while it is on, typing goes to the picker, not the app), so every way the picker can go away turns it off.

export interface PickerWindow {
  send(channel: string, ...args: unknown[]): void;
  showInactive(): void;
  hide(): void;
  isVisible(): boolean;
  destroy(): void;
  place(caret: { x: number; y: number; width: number; height: number } | null): void;
  /** The page registered its listeners. */
  onReady(cb: () => void): void;
  /** The renderer crashed or the window was destroyed. */
  onGone(cb: () => void): void;
}

export interface PickerDeps {
  create(): PickerWindow;
  /** Turns the hook's picker key capture on or off. */
  capture(on: boolean): void;
  foreground(): number;
  caret(): { x: number; y: number; width: number; height: number } | null;
  items(): unknown[];
  /** The dictation key's name, for the empty-history hint. */
  hotkey?(): string;
  log(level: 'info' | 'warn' | 'error', msg: string): void;
  readyTimeoutMs?: number;
  /** How often to check that the target app still has focus while the picker is open. */
  watchMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
}

interface Instance {
  win: PickerWindow;
  ready: Promise<boolean>;
  gone: boolean;
}

export class PickerController {
  private inst: Instance | undefined;
  /** Bumped by every open and close, so an open still waiting for the page is dropped if closed meanwhile. */
  private token = 0;
  private watch: unknown;
  private open_ = false;
  /** The window that had focus when the picker opened: picks are pasted there. */
  target = 0;

  constructor(private readonly deps: PickerDeps) {}

  private get t() {
    return {
      setTimeout: this.deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms)),
      clearTimeout: this.deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)),
      setInterval: this.deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms)),
      clearInterval: this.deps.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>)),
    };
  }

  get isOpen(): boolean {
    return this.open_;
  }

  /** Creates the window (once) and resolves true when its page is ready; a page that never answers is discarded. */
  ensure(): Promise<boolean> {
    if (this.inst && !this.inst.gone) return this.inst.ready;
    const win = this.deps.create();
    const inst: Instance = { win, ready: Promise.resolve(false), gone: false };
    inst.ready = new Promise<boolean>((resolve) => {
      const timer = this.t.setTimeout(() => {
        // Not ready in time: throw this window away so the next open starts afresh.
        this.deps.log('error', 'history picker did not load in time; will retry on the next open');
        this.discard(inst);
        resolve(false);
      }, this.deps.readyTimeoutMs ?? 5000);
      win.onReady(() => {
        this.t.clearTimeout(timer);
        resolve(!inst.gone);
      });
      win.onGone(() => {
        this.t.clearTimeout(timer);
        this.deps.log('error', 'history picker window went away');
        this.discard(inst);
        resolve(false);
      });
    });
    this.inst = inst;
    return inst.ready;
  }

  private discard(inst: Instance): void {
    if (inst.gone) return;
    inst.gone = true;
    if (this.inst === inst) {
      this.inst = undefined;
      // If it was open, the person's keyboard must come back now.
      this.releaseKeyboard();
    }
    try {
      inst.win.destroy();
    } catch {
      // already gone
    }
  }

  async open(): Promise<void> {
    const token = ++this.token;
    const target = this.deps.foreground();
    const caret = this.deps.caret();
    if (!(await this.ensure())) return;
    // Closed or reopened while the page was loading, or the window died meanwhile.
    const inst = this.inst;
    if (token !== this.token || !inst || inst.gone) return;
    this.target = target;
    inst.win.place(caret);
    inst.win.send('dictate:picker-open', { items: this.deps.items(), now: Date.now(), hotkey: this.deps.hotkey?.() ?? 'the dictation key' });
    inst.win.showInactive();
    this.open_ = true;
    // Keys go to the picker only once it is on screen and listening.
    this.deps.capture(true);
    // If focus moves elsewhere (a click, Alt+Tab, a notification), close at once so typing there is never eaten.
    this.t.clearInterval(this.watch);
    this.watch = this.t.setInterval(() => {
      if (this.deps.foreground() !== this.target) this.close();
    }, this.deps.watchMs ?? 200);
    this.deps.log('info', 'history picker opened');
  }

  private releaseKeyboard(): void {
    this.t.clearInterval(this.watch);
    this.watch = undefined;
    if (this.open_) this.deps.capture(false);
    this.open_ = false;
  }

  /** Always safe to call: releases the keyboard first, whatever state the window is in. */
  close(): void {
    this.token++;
    const wasOpen = this.open_;
    this.releaseKeyboard();
    const inst = this.inst;
    if (!wasOpen || !inst || inst.gone) return;
    try {
      inst.win.send('dictate:picker-close');
      inst.win.hide();
    } catch {
      // a window torn down underneath us; the keyboard is already released
    }
  }

  send(channel: string, ...args: unknown[]): void {
    if (this.inst && !this.inst.gone) this.inst.win.send(channel, ...args);
  }
}
