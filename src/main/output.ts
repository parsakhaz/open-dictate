// Wires the paste rules (paste.ts) to the real clipboard, SendInput and the foreground window.
import { ClipboardItem, clipboard } from 'electron';
import { caretRect, foregroundWindow, looksLikeNoTextTarget, sendCtrlV, typeText, windowPid } from '../native/win32';
import { type ClipboardPort, PasteSink } from './paste';

/** Clipboard calls that take longer than this are treated as failed: another app has it locked. */
const CLIPBOARD_MS = 800;

function within<T>(p: Promise<T>, ms = CLIPBOARD_MS): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((_, reject) => (t = setTimeout(() => reject(new Error('clipboard busy')), ms)))]).finally(() => clearTimeout(t));
}

type Snapshot = Record<string, unknown>[];

const electronClipboard: ClipboardPort = {
  /** Every entry and format on the clipboard, read out in full so it survives our own write. */
  async snapshot(): Promise<Snapshot> {
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
  },
  async restore(s: unknown): Promise<void> {
    const snap = s as Snapshot;
    if (!snap.length) return clipboard.clear();
    await within(clipboard.write(snap.map((r) => new ClipboardItem(r as never))));
  },
  writeText: (text) => within(clipboard.writeText(text)),
  readText: () => within(clipboard.readText()),
};

export function realPasteSink(opts: { modifiersDown: () => boolean; ownPid: number; log: (level: 'info' | 'warn' | 'error', msg: string) => void }): PasteSink {
  return new PasteSink({
    clipboard: electronClipboard,
    input: { sendCtrlV, typeText },
    target: {
      foreground: foregroundWindow,
      noTextField: (hwnd) => looksLikeNoTextTarget(hwnd) || windowPid(hwnd) === opts.ownPid,
      hasCaret: (hwnd) => hwnd === foregroundWindow() && caretRect() !== null,
    },
    modifiersDown: opts.modifiersDown,
    log: opts.log,
  });
}
