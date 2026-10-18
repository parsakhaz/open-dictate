// The real output sink: paste into the focused app with real key events, then put the person's clipboard back.
// If the clipboard cannot be opened (another app holds it), the text is typed as Unicode key events instead.
import { ClipboardItem, clipboard } from 'electron';
import type { OutputMode } from '../core/types';
import { foregroundWindow, looksLikeNoTextTarget, sendCtrlV, typeText, windowPid } from '../native/win32';
import type { Delivery, OutputSink } from './pipeline';

/** How long the target app gets to read the clipboard before the old contents go back. */
export const RESTORE_MS = 350;
/** Clipboard calls that take longer than this are treated as failed: another app has it locked. */
const CLIPBOARD_MS = 800;

function within<T>(p: Promise<T>, ms = CLIPBOARD_MS): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((_, reject) => (t = setTimeout(() => reject(new Error('clipboard busy')), ms)))]).finally(() => clearTimeout(t));
}

type Snapshot = Record<string, unknown>[];

/** Every entry and format on the clipboard, read out in full so it survives our own write. */
async function snapshot(): Promise<Snapshot> {
  const items = await within(clipboard.read());
  const out: Snapshot = [];
  for (const it of items) {
    const rec: Record<string, unknown> = {};
    for (const t of it.types) {
      try {
        rec[t] = await within(it.getType(t));
      } catch {
        // a format that cannot be read back is skipped
      }
    }
    if (Object.keys(rec).length) out.push(rec);
  }
  return out;
}

async function restore(s: Snapshot): Promise<void> {
  if (!s.length) return clipboard.clear();
  await within(clipboard.write(s.map((r) => new ClipboardItem(r as never))));
}

export interface PasteDeps {
  /** True while the person still holds a modifier: Ctrl+V would become Ctrl+Shift+V. */
  modifiersDown: () => boolean;
  /** Our own windows: never paste into them. */
  ownPid: number;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PasteSink implements OutputSink {
  /** Deliveries run one at a time so two quick dictations never interleave their clipboard swaps. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: PasteDeps) {}

  deliver(text: string, mode: OutputMode): Promise<Delivery> {
    const run = this.queue.then(() => this.run(text, mode));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async copy(text: string): Promise<boolean> {
    try {
      await within(clipboard.writeText(text));
      return true;
    } catch (err) {
      this.deps.log('warn', `clipboard write failed: ${(err as Error).message}`);
      return false;
    }
  }

  private async run(text: string, mode: OutputMode): Promise<Delivery> {
    if (mode === 'clipboard') {
      const copied = await this.copy(text);
      return { pasted: false, copied, reason: copied ? undefined : 'clipboard busy' };
    }
    for (let i = 0; i < 40 && this.deps.modifiersDown(); i++) await sleep(25);
    const fg = foregroundWindow();
    if (looksLikeNoTextTarget(fg) || windowPid(fg) === this.deps.ownPid) {
      const copied = await this.copy(text);
      return { pasted: false, copied, reason: 'no text field in focus' };
    }
    let saved: Snapshot | undefined;
    if (mode === 'paste') {
      try {
        saved = await snapshot();
      } catch (err) {
        this.deps.log('warn', `clipboard read failed: ${(err as Error).message}`);
      }
    }
    if (!(await this.copy(text))) {
      // The clipboard is locked by another app: type the words instead.
      const typed = typeText(text);
      return { pasted: typed, copied: false, reason: typed ? 'typed (clipboard busy)' : 'clipboard busy and typing was blocked' };
    }
    const sent = sendCtrlV();
    if (sent !== 4) {
      // Blocked (an elevated window, the secure desktop): the text stays on the clipboard.
      return { pasted: false, copied: true, reason: `SendInput inserted ${sent} of 4 events` };
    }
    if (saved) {
      await sleep(RESTORE_MS);
      try {
        // Only put the old clipboard back if nothing else has replaced our text meanwhile.
        if ((await within(clipboard.readText())) === text) await restore(saved);
      } catch (err) {
        this.deps.log('warn', `clipboard restore failed: ${(err as Error).message}`);
      }
    }
    return { pasted: true, copied: mode === 'both' };
  }
}
