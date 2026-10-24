// Text that agents send for the pill: untrusted, shown as plain text only. Pure.

// Escape sequences: CSI (ESC [ … final), OSC (ESC ] … BEL or ESC \), and two-character ESC sequences.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;
const TAG = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi;

export interface Clean {
  text: string;
  /** Longer than its cap: cut, with "…" at the end. */
  truncated: boolean;
}

/** Escape codes, control and bidi characters and HTML tags removed, whitespace collapsed, cut on a word at `cap` characters. */
export function cleanText(input: unknown, cap: number): Clean {
  if (typeof input !== 'string') return { text: '', truncated: false };
  return cutWords(input.replace(ANSI, '').replace(TAG, ' ').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim(), cap);
}

/** Cut at `cap` characters, "…" included, at the last space when that keeps at least half of it. */
export function cutWords(s: string, cap: number): Clean {
  const chars = [...s];
  if (chars.length <= cap) return { text: s, truncated: false };
  const head = chars.slice(0, cap - 1).join('');
  const space = Math.max(head.lastIndexOf(' '), head.lastIndexOf('\n'));
  const kept = space >= head.length / 2 ? head.slice(0, space) : head;
  return { text: `${kept.trimEnd()}…`, truncated: true };
}

/**
 * cleanText for a card's message, but line breaks stay (at most one blank line in a row) and tags are kept as the
 * characters they are: the pill shows a message only as text nodes, and agents write code like `Vec<String>`.
 */
export function cleanMessage(input: unknown, cap: number): Clean {
  if (typeof input !== 'string') return { text: '', truncated: false };
  const lines = input
    .replace(ANSI, '')
    .split(/\r\n|\r|\n/)
    .map((l) => l.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim());
  return cutWords(lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), cap);
}

/** A link a card may offer: https only, shown by its host name, opened only on a click. */
export function safeLink(input: unknown): { url: string; host: string } | null {
  if (typeof input !== 'string' || input.length > 2000) return null;
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null;
  return { url: u.toString(), host: u.hostname };
}
