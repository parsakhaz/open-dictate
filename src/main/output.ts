// Wires the paste rules (paste.ts) to the real clipboard, SendInput and the foreground window.
import { ClipboardItem, clipboard } from 'electron';
import { caretRect, foregroundWindow, hasTextCaret, looksLikeNoTextTarget, sendCtrlV, sendEnter, typeText, windowClass, windowPid, writeClipboardText } from '../native/platform';
import { type ClipboardPort, PasteSink } from './paste';

/** Clipboard calls that take longer than this are treated as failed: another app has it locked. */
const CLIPBOARD_MS = 800;

function within<T>(p: Promise<T>, ms = CLIPBOARD_MS): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((_, reject) => (t = setTimeout(() => reject(new Error('clipboard busy')), ms)))]).finally(() => clearTimeout(t));
}

type Snapshot = Record<string, unknown>[];

const electronClipboard: ClipboardPort = {
  /**
   * Every entry and format on the clipboard, read out in full so it survives our own write. If any advertised
   * format cannot be read, the snapshot fails as a whole: a partial copy would lose that data on restore, so the
   * sink types the text instead and leaves the clipboard alone.
   */
  async snapshot(): Promise<Snapshot> {
    const items = await within(clipboard.read());
    const out: Snapshot = [];
    for (const it of items) {
      const rec: Record<string, unknown> = {};
      for (const t of it.types) {
        try {
          rec[t] = await within(it.getType(t));
        } catch (err) {
          throw new Error(`cannot read clipboard format ${t}: ${(err as Error).message}`);
        }
      }
      // An empty clipboard reads as one entry with no formats; there is nothing in it to keep.
      if (it.types.length) out.push(rec);
    }
    return out;
  },
  async restore(s: unknown): Promise<void> {
    const snap = s as Snapshot;
    if (!snap.length) return clipboard.clear();
    await within(clipboard.write(snap.map((r) => new ClipboardItem(r as never))));
  },
  writeText: (text, transient) => within(writeClipboardText(text, { history: !transient })),
  readText: () => within(clipboard.readText()),
};

/**
 * Apps whose text fields never show a Win32 caret, so a missing caret says nothing about them: Chromium and
 * Electron (desktop QA: an Edge textarea shows none, just like a page body), Firefox, and terminals. There the
 * paste is trusted and the clipboard restored; the no-caret rule only applies where a caret is a real signal.
 */
const NO_WIN32_CARET = /^(Chrome_WidgetWin_\d+|MozillaWindowClass|CASCADIA_HOSTING_WINDOW_CLASS|ConsoleWindowClass)$/;
const hidesCaret = (hwnd: number) => NO_WIN32_CARET.test(windowClass(hwnd));

export function realPasteSink(opts: { modifiersDown: () => boolean; ownPid: number; log: (level: 'info' | 'warn' | 'error', msg: string) => void }): PasteSink {
  return new PasteSink({
    clipboard: electronClipboard,
    input: { sendCtrlV, typeText, sendEnter },
    target: {
      foreground: foregroundWindow,
      noTextField: (hwnd) => looksLikeNoTextTarget(hwnd) || windowPid(hwnd) === opts.ownPid,
      hasCaret: (hwnd) => process.platform === 'win32'
        ? (hwnd === foregroundWindow() && caretRect() !== null) || hidesCaret(hwnd)
        : hasTextCaret(hwnd),
    },
    modifiersDown: opts.modifiersDown,
    log: opts.log,
  });
}
