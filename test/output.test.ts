// The real paste adapter (output.ts) with Electron's clipboard and the Win32 calls replaced by fakes.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const board = vi.hoisted(() => ({
  items: [] as { types: string[]; data: Record<string, unknown>; failing?: string }[],
  text: '',
  writes: [] as string[],
  typed: [] as string[],
  cleared: 0,
  caret: true,
  cls: 'Notepad',
}));

vi.mock('electron', () => {
  class ClipboardItem {
    constructor(readonly data: Record<string, unknown>) {}
    get types() {
      return Object.keys(this.data);
    }
  }
  return {
    ClipboardItem,
    clipboard: {
      read: async () =>
        board.items.map((it) => ({
          types: it.types,
          getType: async (t: string) => {
            if (t === it.failing) throw new Error('format unavailable');
            return it.data[t];
          },
        })),
      write: async (items: { data: Record<string, unknown> }[]) => {
        board.items = items.map((i) => ({ types: Object.keys(i.data), data: i.data }));
        board.text = String(items[0]?.data['text/plain'] ?? '');
        board.writes.push(`write:${board.text}`);
      },
      writeText: async (t: string) => {
        board.items = [{ types: ['text/plain'], data: { 'text/plain': t } }];
        board.text = t;
        board.writes.push(`text:${t}`);
      },
      readText: async () => board.text,
      clear: async () => {
        board.cleared++;
        board.items = [];
        board.text = '';
      },
    },
  };
});

vi.mock('../src/native/win32', () => ({
  caretRect: () => (board.caret ? { x: 0, y: 0, width: 1, height: 10 } : null),
  windowClass: () => board.cls,
  foregroundWindow: () => 42,
  looksLikeNoTextTarget: () => false,
  windowPid: () => 1,
  sendCtrlV: () => 4,
  sendEnter: () => true,
  typeText: (t: string) => {
    board.typed.push(t);
    return true;
  },
  writeClipboardText: async (t: string, o: { history: boolean }) => {
    board.items = [{ types: ['text/plain'], data: { 'text/plain': t } }];
    board.text = t;
    board.writes.push(`text:${t}${o.history ? '' : ' (no history)'}`);
  },
}));

const { realPasteSink } = await import('../src/main/output');

function sink() {
  return realPasteSink({ modifiersDown: () => false, ownPid: 999, log: () => undefined });
}

beforeEach(() => {
  board.items = [{ types: ['text/plain', 'text/html'], data: { 'text/plain': 'OLD', 'text/html': '<b>OLD</b>' } }];
  board.text = 'OLD';
  board.writes = [];
  board.typed = [];
  board.cleared = 0;
  board.caret = true;
  board.cls = 'Notepad';
});

describe('realPasteSink', () => {
  it('restores every format after pasting', async () => {
    const d = await sink().deliver('hello', 'paste');
    expect(d).toMatchObject({ pasted: true, confirmed: true });
    expect(board.items[0].data).toEqual({ 'text/plain': 'OLD', 'text/html': '<b>OLD</b>' });
  });

  it('writes the pasted text with the privacy formats that keep it out of Win+V history (B1)', async () => {
    await sink().deliver('hello', 'paste');
    expect(board.writes[0]).toBe('text:hello (no history)');
  });

  it('leaves the clipboard untouched and types when one format cannot be read (M3)', async () => {
    board.items[0].failing = 'text/plain';
    const d = await sink().deliver('hello', 'paste');
    expect(d).toMatchObject({ pasted: true, copied: false });
    expect(board.typed).toEqual(['hello']);
    expect(board.writes).toEqual([]);
    expect(board.cleared).toBe(0);
    expect(board.text).toBe('OLD');
  });
});

describe('realPasteSink and the caret', () => {
  it('keeps the text on the clipboard when a Win32 app shows no caret', async () => {
    board.caret = false;
    const d = await sink().deliver('hello', 'paste');
    expect(d).toMatchObject({ pasted: true, copied: true, confirmed: false });
    expect(board.text).toBe('hello');
  });

  it.each(['Chrome_WidgetWin_1', 'MozillaWindowClass', 'CASCADIA_HOSTING_WINDOW_CLASS', 'ConsoleWindowClass'])(
    'restores the clipboard in %s, whose text fields never show a Win32 caret (desktop QA: an Edge textarea)',
    async (cls) => {
      board.caret = false;
      board.cls = cls;
      const d = await sink().deliver('hello', 'paste');
      expect(d).toMatchObject({ pasted: true, confirmed: true });
      expect(board.text).toBe('OLD');
    },
  );
});

describe('realPasteSink with an empty clipboard', () => {
  it('pastes and leaves the clipboard empty again', async () => {
    board.items = [{ types: [], data: {} }];
    board.text = '';
    const d = await sink().deliver('hello', 'paste');
    expect(d).toMatchObject({ pasted: true, confirmed: true });
    expect(board.cleared).toBe(1);
  });
});
