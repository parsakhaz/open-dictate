// The little Markdown agents write, read for the pill. Titles are plain; messages keep bold, italic and inline code
// as styled runs and lose every other mark. The result is text and styles only: the pill builds it as DOM text nodes,
// never as HTML, so a tag in the input is shown as the characters it is. Cuts to fit happen after the marks are read,
// so a cut never leaves a raw mark behind. Pure.
import { type Clean, cleanText, cutWords } from './agenttext';

export interface Run {
  text: string;
  style?: 'b' | 'i' | 'code';
}

const FENCE = /^\s*(```|~~~)/;
/** A heading, list marker or quote at the start of a line. */
const LINE_MARK = /^\s*(?:#{1,6}\s+|[-*+]\s+|\d{1,3}[.)]\s+|>\s?)+/;
/** [text](url) and ![alt](url): just the words. */
const LINK = /!?\[([^\]\n]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g;
/** Inline code, bold (** or __), italic (* or _). Underscores only at word edges, so snake_case stays. */
const INLINE = /`([^`\n]+)`|\*\*(?=\S)(.+?)(?<=\S)\*\*|(?<![\p{L}\p{N}_])__(?=\S)(.+?)(?<=\S)__(?![\p{L}\p{N}_])|\*(?=[^\s*])(.+?)(?<=[^\s*])\*|(?<![\p{L}\p{N}_])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![\p{L}\p{N}_])/gu;

/** One line's text, its emphasis and code marks turned into runs; marks inside code stay as typed. */
function runs(line: string): Run[] {
  const out: Run[] = [];
  const push = (text: string, style?: Run['style']) => {
    if (!text) return;
    const last = out.at(-1);
    if (last && last.style === style) last.text += text;
    else out.push(style ? { text, style } : { text });
  };
  let at = 0;
  for (const m of line.matchAll(INLINE)) {
    push(line.slice(at, m.index));
    if (m[1] !== undefined) push(m[1], 'code');
    else if (m[2] !== undefined || m[3] !== undefined) push(plainInline(m[2] ?? m[3]), 'b');
    else push(plainInline(m[4] ?? m[5]), 'i');
    at = m.index + m[0].length;
  }
  push(line.slice(at));
  return out;
}

/** Emphasis and code marks dropped, keeping the words. */
function plainInline(s: string): string {
  return runs(s)
    .map((r) => r.text)
    .join('');
}

/** The message as lines of styled runs. Headings, list markers and quotes become plain lines; fences go. */
export function messageLines(md: string): Run[][] {
  const lines: Run[][] = [];
  let inCode = false;
  for (const raw of md.split(/\r?\n/)) {
    if (FENCE.test(raw)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      lines.push(raw.trim() ? [{ text: raw.trimEnd(), style: 'code' }] : []);
      continue;
    }
    const line = raw.replace(LINE_MARK, '').replace(LINK, '$1').trim();
    // One empty line between paragraphs at most.
    if (!line && (lines.length === 0 || lines.at(-1)?.length === 0)) continue;
    lines.push(line ? runs(line) : []);
  }
  while (lines.at(-1)?.length === 0) lines.pop();
  return lines;
}

/** The title with every Markdown mark removed. */
export function plainTitle(md: string): string {
  return md
    .split(/\r?\n/)
    .map((l) => plainInline(l.replace(LINE_MARK, '').replace(LINK, '$1')).trim())
    .filter(Boolean)
    .join(' ');
}

/** An agent's title, or any text shown on one line: cleaned and plain, cut on a word at `cap` characters. */
export function fitPlain(input: unknown, cap: number): Clean {
  return cutWords(plainTitle(cleanText(input, Number.POSITIVE_INFINITY).text), cap);
}

/** The message as styled lines, cut on a word at `cap` characters of shown text, its styles kept up to the cut. */
export function fitMessage(md: string, cap: number): { lines: Run[][]; truncated: boolean } {
  const lines = messageLines(md);
  const cut = cutWords(lines.map((l) => l.map((r) => r.text).join('')).join('\n'), cap);
  if (!cut.truncated) return { lines, truncated: false };
  let left = [...cut.text].length - 1;
  const out: Run[][] = [];
  for (const line of lines) {
    const kept: Run[] = [];
    for (const r of line) {
      const chars = [...r.text];
      if (left <= 0) break;
      kept.push({ ...r, text: chars.slice(0, left).join('') });
      left -= chars.length;
    }
    out.push(kept);
    if (left <= 0) break;
    left -= 1;
  }
  const last = out.at(-1) as Run[];
  const end = last.at(-1);
  if (end && !end.style) end.text += '…';
  else last.push({ text: '…' });
  return { lines: out, truncated: true };
}
