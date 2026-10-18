// Delivering text into the focused app: paste through the clipboard and put the person's clipboard back, or type
// it when the clipboard cannot be used safely. No Electron or Win32 imports: the ports are injected, so the
// rules are unit-tested and output.ts only wires the real clipboard and SendInput.
import type { OutputMode } from '../core/types';
import type { Delivery, OutputSink } from './pipeline';

/** How long the target app gets to read the clipboard before the old contents go back. */
export const RESTORE_MS = 350;

export interface ClipboardPort {
  /** Everything on the clipboard, read out in full; rejects if it cannot be read. */
  snapshot(): Promise<unknown>;
  restore(snapshot: unknown): Promise<void>;
  writeText(text: string): Promise<void>;
  readText(): Promise<string>;
}

export interface InputPort {
  /** Sends Ctrl+V; returns how many of its 4 key events Windows accepted. */
  sendCtrlV(): number;
  /** Types the text as Unicode key events; false if Windows blocked them. */
  typeText(text: string): boolean;
}

export interface TargetPort {
  foreground(): number;
  /** True for the desktop, the taskbar and dictate's own windows: nothing to paste into. */
  noTextField(hwnd: number): boolean;
  /** True when the focused control shows a text caret: a text field that will take the paste. */
  hasCaret(hwnd: number): boolean;
}

export interface PasteDeps {
  clipboard: ClipboardPort;
  input: InputPort;
  target: TargetPort;
  /** True while the person still holds a modifier: Ctrl+V would become Ctrl+Shift+V. */
  modifiersDown: () => boolean;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export class PasteSink implements OutputSink {
  /** Deliveries run one at a time so two quick dictations never interleave their clipboard swaps. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: PasteDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  deliver(text: string, mode: OutputMode): Promise<Delivery> {
    const run = this.queue.then(() => this.run(text, mode));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async copy(text: string): Promise<boolean> {
    try {
      await this.deps.clipboard.writeText(text);
      return true;
    } catch (err) {
      this.deps.log('warn', `clipboard write failed: ${(err as Error).message}`);
      return false;
    }
  }

  private type(text: string, why: string): Delivery {
    const typed = this.deps.input.typeText(text);
    return { pasted: typed, copied: false, confirmed: typed, reason: typed ? `typed (${why})` : `${why}, and typing was blocked` };
  }

  private async run(text: string, mode: OutputMode): Promise<Delivery> {
    if (mode === 'clipboard') {
      const copied = await this.copy(text);
      return { pasted: false, copied, reason: copied ? undefined : 'clipboard busy' };
    }
    for (let i = 0; i < 40 && this.deps.modifiersDown(); i++) await this.sleep(25);
    const fg = this.deps.target.foreground();
    if (this.deps.target.noTextField(fg)) {
      const copied = await this.copy(text);
      return { pasted: false, copied, reason: 'no text field in focus' };
    }
    const confirmed = this.deps.target.hasCaret(fg);
    let saved: unknown;
    if (mode === 'paste') {
      try {
        saved = await this.deps.clipboard.snapshot();
      } catch (err) {
        // The clipboard cannot be saved, so it must not be overwritten.
        this.deps.log('warn', `clipboard read failed (${(err as Error).message})`);
        return this.type(text, 'clipboard unreadable');
      }
    }
    if (!(await this.copy(text))) return this.type(text, 'clipboard busy');
    const sent = this.deps.input.sendCtrlV();
    if (sent !== 4) {
      // Blocked (an elevated window, the secure desktop): the text stays on the clipboard.
      return { pasted: false, copied: true, reason: `SendInput inserted ${sent} of 4 events` };
    }
    if (!confirmed) {
      // Ctrl+V went to a control that shows no caret, so it may have landed nowhere (a web page's body, a
      // list). Keep the text on the clipboard rather than restoring over it.
      return { pasted: true, copied: true, confirmed: false, reason: 'no caret: kept on the clipboard' };
    }
    if (mode === 'paste') {
      await this.sleep(RESTORE_MS);
      try {
        // Only put the old clipboard back if nothing else has replaced our text meanwhile.
        if ((await this.deps.clipboard.readText()) === text) await this.deps.clipboard.restore(saved);
      } catch (err) {
        this.deps.log('warn', `clipboard restore failed: ${(err as Error).message}`);
      }
    }
    return { pasted: true, copied: mode === 'both', confirmed: true };
  }
}
