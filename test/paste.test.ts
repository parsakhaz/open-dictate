import { describe, expect, it } from 'vitest';
import { HistoryStore } from '../src/core/history';
import { type ClipboardPort, PasteSink } from '../src/main/paste';
import { finishDictation, type OutputSink, withTrailingSpace } from '../src/main/pipeline';

function setup(opts: { snapshotFails?: boolean; writeFails?: boolean; caret?: boolean; noTextField?: boolean; sent?: number } = {}) {
  let board = 'OLD';
  const calls: string[] = [];
  const writes: string[] = [];
  const clipboard: ClipboardPort = {
    snapshot: async () => {
      calls.push('snapshot');
      if (opts.snapshotFails) throw new Error('clipboard busy');
      return board;
    },
    restore: async (s) => {
      calls.push('restore');
      board = s as string;
    },
    writeText: async (t, transient) => {
      calls.push('write');
      writes.push(transient ? 'transient' : 'kept');
      if (opts.writeFails) throw new Error('clipboard busy');
      board = t;
    },
    readText: async () => board,
  };
  const sink = new PasteSink({
    clipboard,
    input: {
      sendCtrlV: () => {
        calls.push('ctrl+v');
        return opts.sent ?? 4;
      },
      typeText: (t) => {
        calls.push(`type:${t}`);
        return true;
      },
    },
    target: { foreground: () => 42, noTextField: () => !!opts.noTextField, hasCaret: () => opts.caret ?? true },
    modifiersDown: () => false,
    log: () => undefined,
    sleep: async () => undefined,
  });
  return { sink, calls, writes, board: () => board };
}

describe('PasteSink', () => {
  it('pastes into a text field and puts the old clipboard back', async () => {
    const t = setup();
    expect(await t.sink.deliver('hello', 'paste')).toEqual({ pasted: true, copied: false, confirmed: true });
    expect(t.calls).toEqual(['snapshot', 'write', 'ctrl+v', 'restore']);
    expect(t.board()).toBe('OLD');
  });

  it('never overwrites a clipboard it could not save: it types instead (M3)', async () => {
    const t = setup({ snapshotFails: true });
    const d = await t.sink.deliver('hello', 'paste');
    expect(d).toMatchObject({ pasted: true, copied: false });
    expect(t.calls).toEqual(['snapshot', 'type:hello']);
    expect(t.board()).toBe('OLD');
  });

  it('types when the clipboard cannot be written', async () => {
    const t = setup({ writeFails: true });
    expect((await t.sink.deliver('hello', 'paste')).reason).toMatch(/typed/);
    expect(t.board()).toBe('OLD');
  });

  it('keeps the text on the clipboard when the target shows no caret (S3)', async () => {
    const t = setup({ caret: false });
    const d = await t.sink.deliver('hello', 'paste');
    expect(d).toMatchObject({ pasted: true, copied: true, confirmed: false });
    expect(t.calls).not.toContain('restore');
    expect(t.board()).toBe('hello');
  });

  it('copies, without pasting, when nothing in focus takes text', async () => {
    const t = setup({ noTextField: true });
    expect(await t.sink.deliver('hello', 'paste')).toMatchObject({ pasted: false, copied: true });
    expect(t.calls).toEqual(['write']);
  });

  it('leaves the text on the clipboard when Windows blocks the paste', async () => {
    const t = setup({ sent: 0 });
    expect(await t.sink.deliver('hello', 'paste')).toMatchObject({ pasted: false, copied: true });
    expect(t.board()).toBe('hello');
  });

  it('keeps the text on the clipboard in "both" mode, and only copies in clipboard mode', async () => {
    const both = setup();
    expect(await both.sink.deliver('hello', 'both')).toMatchObject({ pasted: true, copied: true });
    expect(both.board()).toBe('hello');
    const clip = setup();
    expect(await clip.sink.deliver('hello', 'clipboard')).toEqual({ pasted: false, copied: true });
    expect(clip.calls).toEqual(['write']);
  });
});

describe('PasteSink keeps dictations out of clipboard history and the cloud (B1)', () => {
  it('marks the text of a paste-and-restore as transient', async () => {
    const t = setup();
    await t.sink.deliver('hello', 'paste');
    expect(t.writes).toEqual(['transient']);
  });

  it('writes text the person keeps on the clipboard as kept: clipboard mode, both mode, no text field', async () => {
    for (const [mode, opts] of [['clipboard', {}], ['both', {}], ['paste', { noTextField: true }]] as const) {
      const t = setup(opts);
      await t.sink.deliver('hello', mode);
      expect(t.writes).toEqual(['kept']);
    }
  });
});

describe('withTrailingSpace', () => {
  it('ends every dictation with one space, so the next one does not run into it', () => {
    expect(withTrailingSpace('Deploy it.')).toBe('Deploy it. ');
    expect(withTrailingSpace('hello')).toBe('hello ');
  });

  it('adds nothing when the text already ends in whitespace or a line break', () => {
    expect(withTrailingSpace('Deploy it. ')).toBe('Deploy it. ');
    expect(withTrailingSpace('a list:\n')).toBe('a list:\n');
  });

  it('adds nothing after an opening bracket or quote, or to empty text', () => {
    expect(withTrailingSpace('see (')).toBe('see (');
    expect(withTrailingSpace('he said “')).toBe('he said “');
    expect(withTrailingSpace('')).toBe('');
  });
});

describe('finishDictation', () => {
  it('delivers the text with a trailing space but keeps it out of the history', async () => {
    const delivered: string[] = [];
    const history = new HistoryStore();
    await finishDictation('hello there.', [], 'paste', performance.now(), {
      chain: { ready: async () => true, complete: async () => '' },
      sink: {
        deliver: async (t) => {
          delivered.push(t);
          return { pasted: true, copied: false };
        },
      },
      history,
      saveHistory: () => undefined,
      log: () => undefined,
    });
    expect(delivered).toEqual(['hello there. ']);
    expect(history.list()[0].text).toBe('hello there.');
  });

  it('saves the entry to disk before delivering it (M5)', async () => {
    const order: string[] = [];
    const history = new HistoryStore();
    const sink: OutputSink = {
      deliver: async (text) => {
        order.push(`deliver:${text}`);
        return { pasted: true, copied: false };
      },
    };
    await finishDictation('hello there', [], 'paste', performance.now(), {
      chain: { ready: async () => true, complete: async () => '' },
      sink,
      history,
      saveHistory: () => order.push(`save:${history.list().length}`),
      log: () => undefined,
    });
    expect(order).toEqual(['save:1', 'deliver:hello there ', 'save:1']);
  });

  it('still delivers when history cannot be saved', async () => {
    const sink: OutputSink = { deliver: async () => ({ pasted: true, copied: false }) };
    const logs: string[] = [];
    const r = await finishDictation('hello there', [], 'paste', performance.now(), {
      chain: { ready: async () => true, complete: async () => '' },
      sink,
      history: new HistoryStore(),
      saveHistory: () => {
        throw new Error('disk full');
      },
      log: (_l, m) => logs.push(m),
    });
    expect(r.delivery?.pasted).toBe(true);
    expect(logs.some((m) => m.includes('disk full'))).toBe(true);
  });
});
