import { describe, expect, it } from 'vitest';
import { cleanText, safeLink } from '../src/core/agenttext';
import { parseAsk, parseHistoryRequest, parseNotify, ToolInputError } from '../src/core/agenttools';

describe('cleanText', () => {
  it('cuts long text with an ellipsis and says so', () => {
    const r = cleanText('x'.repeat(2000), 280);
    expect([...r.text]).toHaveLength(280);
    expect(r.text.endsWith('…')).toBe(true);
    expect(r.truncated).toBe(true);
    expect(cleanText('short', 280)).toEqual({ text: 'short', truncated: false });
  });

  it('removes escape codes, control characters, bidi overrides and tags, and collapses whitespace', () => {
    expect(cleanText('\u001b[31mred\u001b[0m and\n\n\tbold <b>text</b><script>alert(1)</script>', 280).text).toBe('red and bold text alert(1)');
    expect(cleanText('\u001b]8;;https://evil\u0007click\u001b]8;;\u0007', 280).text).toBe('click');
    expect(cleanText('safe\u202Etxt.exe', 280).text).toBe('safe txt.exe');
  });

  it('shows Markdown as plain characters', () => {
    expect(cleanText('**bold** [link](javascript:alert(1))', 280).text).toBe('**bold** [link](javascript:alert(1))');
  });

  it('treats a non-string as empty', () => {
    expect(cleanText({ toString: () => 'x' }, 10).text).toBe('');
  });
});

describe('safeLink', () => {
  it('accepts https only, and names the host', () => {
    expect(safeLink('https://github.com/parsakhaz/open-dictate/pull/6')).toEqual({ url: 'https://github.com/parsakhaz/open-dictate/pull/6', host: 'github.com' });
    for (const bad of ['javascript:alert(1)', 'http://example.com', 'file:///C:/x', 'pane://open?pane=1', 'https://user:pw@example.com', 'not a url']) expect(safeLink(bad)).toBeNull();
  });
});

describe('notify arguments', () => {
  it('cuts a 200-character title at 60 and reports truncation', () => {
    const a = parseNotify({ title: 't'.repeat(200), message: 'm' });
    expect([...a.title]).toHaveLength(60);
    expect(a.truncated).toBe(true);
  });

  it('defaults to info and keeps at most four distinct choices', () => {
    const a = parseNotify({ title: 'Pick', choices: ['A', 'a', 'B', 'C', 'D', 'E'] });
    expect(a.urgency).toBe('info');
    expect(a.choices).toEqual(['A', 'B', 'C', 'D']);
  });

  it('rejects a missing title and a link that is not https', () => {
    expect(() => parseNotify({ message: 'x' })).toThrow(ToolInputError);
    expect(() => parseNotify({ title: 'x', link: 'javascript:alert(1)' })).toThrow(/https/);
  });
});

describe('ask arguments', () => {
  it('defaults the wait to 120 s and caps it at 600 s', () => {
    expect(parseAsk({ question: 'Staging or prod?' }).timeoutS).toBe(120);
    expect(parseAsk({ question: 'q', timeout_s: 9999 }).timeoutS).toBe(600);
    expect(parseAsk({ question: 'q'.repeat(300) }).question).toHaveLength(120);
  });
});

describe('read_history arguments', () => {
  it('defaults to 5 entries from the last 24 h', () => {
    expect(parseHistoryRequest({})).toEqual({ query: '', hours: 24, limit: 5, includeRaw: false, clamped: false });
  });

  it('clamps more than 20 entries or more than 7 days', () => {
    expect(parseHistoryRequest({ limit: 500, since_hours: 1000, include_raw: true })).toEqual({ query: '', hours: 168, limit: 20, includeRaw: true, clamped: true });
  });
});
