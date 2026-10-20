// Point and say (L6): the rules between the pointer, the element UI Automation found under it, the crop, and what is
// sent. Screen coordinates are physical pixels throughout, as the helper and the capture both see them. Pure.
import { REDACTED, redact } from './historyaccess';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the native helper read under the pointer: never trusted as anything but text. */
export interface UiaElement {
  name: string;
  /** UI Automation's localized control type: "button", "dialog", "edit". */
  role: string;
  rect: Rect;
  text: string;
  pid: number;
  /** The process's file name, e.g. "KeePassXC.exe". */
  process: string;
  /** The top-level window's title. */
  window: string;
}

/** What the person is pointing at: an element, a dragged region, or (no element read) the area around the pointer. */
export type Target = { kind: 'element'; el: UiaElement } | { kind: 'region'; rect: Rect } | { kind: 'around'; rect: Rect };

/** A drag shorter than this (physical pixels, either way) is still pointing. */
export const MIN_DRAG = 12;
/** The area sent when nothing could be read under the pointer. */
export const AROUND = { width: 640, height: 400 };
/** Text read under the pointer is cut here, before it is shown or sent. */
export const MAX_TEXT = 4000;
/** Longer messages go as a file the orchestrator reads (runpane agents send --as-file-pointer). */
export const FILE_POINTER_CHARS = 1200;
/** The review card sends after this long on screen, unless the pointer is over it. */
export const REVIEW_MS = 3000;
/** Captures are deleted this long after they were taken. */
export const CAPTURE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const CAPTURE_PREFIX = 'point-';

const str = (x: unknown, max: number) => (typeof x === 'string' ? x.slice(0, max) : '');
const int = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x) : Number.NaN);

/** The helper's element, checked: null for anything malformed or without a usable rectangle. */
export function parseElement(x: unknown): UiaElement | null {
  if (!x || typeof x !== 'object') return null;
  const e = x as Record<string, unknown>;
  const r = (e.rect ?? {}) as Record<string, unknown>;
  const rect = { x: int(r.x), y: int(r.y), width: int(r.width), height: int(r.height) };
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null;
  return { name: str(e.name, 300), role: str(e.role, 60), rect, text: str(e.text, MAX_TEXT * 2), pid: Number.isFinite(int(e.pid)) ? int(e.pid) : 0, process: str(e.process, 260), window: str(e.window, 300) };
}

/** Excluded apps are matched by process file name, ignoring case and a missing ".exe". */
export function isExcluded(process: string, excluded: string[]): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\.exe$/, '');
  const p = norm(process);
  return !!p && excluded.some((e) => norm(e) === p);
}

/** The rectangle between where the drag started and where the pointer is now; null while it is still a point. */
export function regionFrom(a: Point, b: Point): Rect | null {
  const width = Math.abs(b.x - a.x);
  const height = Math.abs(b.y - a.y);
  if (width < MIN_DRAG && height < MIN_DRAG) return null;
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.max(1, width), height: Math.max(1, height) };
}

/** The part of `r` inside `bounds`; null when they don't overlap. */
export function intersect(r: Rect, bounds: Rect): Rect | null {
  const x = Math.max(r.x, bounds.x);
  const y = Math.max(r.y, bounds.y);
  const right = Math.min(r.x + r.width, bounds.x + bounds.width);
  const bottom = Math.min(r.y + r.height, bounds.y + bounds.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

export function around(p: Point): Rect {
  return { x: Math.round(p.x - AROUND.width / 2), y: Math.round(p.y - AROUND.height / 2), ...AROUND };
}

/** The screen rectangle the crop is cut from: the element with a few pixels to spare, the region as dragged. */
export function targetRect(t: Target): Rect {
  if (t.kind !== 'element') return t.rect;
  const pad = 4;
  const r = t.el.rect;
  return { x: r.x - pad, y: r.y - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "Button · Pay now", "Region · 412 × 236", "Area around the pointer": the outline's tag and the card's caption. */
export function targetLabel(t: Target): string {
  if (t.kind === 'region') return `Region · ${t.rect.width} × ${t.rect.height}`;
  if (t.kind === 'around') return 'Area around the pointer';
  const role = cap(t.el.role) || 'Element';
  const name = t.el.name.replace(/\s+/g, ' ').trim();
  return name ? `${role} · ${name.length > 60 ? `${name.slice(0, 59)}…` : name}` : role;
}

export const MASK = '••••••';
/** Keys whose prefix says what they are keep it ("sk-live-••••••"), so the person can tell what was hidden. */
const PREFIXED = /\b(sk-(?:live|test|proj|ant)-|rk_(?:live|test)_|sk_(?:live|test)_)[A-Za-z0-9_-]{8,}/g;

/** The read text, made safe to show and send: secrets masked (history's redact() plus prefixed keys), blank runs squeezed, cut at MAX_TEXT. */
export function prepareText(text: string): { text: string; secrets: number; truncated: boolean } {
  const squeezed = text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  let prefixed = 0;
  const kept = squeezed.replace(PREFIXED, (_m, p: string) => {
    prefixed++;
    return `${p}${MASK}`;
  });
  const r = redact(kept);
  const masked = r.text.replaceAll(REDACTED, MASK);
  const truncated = masked.length > MAX_TEXT;
  return { text: truncated ? `${masked.slice(0, MAX_TEXT - 1)}…` : masked, secrets: prefixed + r.count, truncated };
}

export interface PointMessage {
  words: string;
  label: string;
  /** The app and window the element is in; empty for a region. */
  app: string;
  window: string;
  /** Already prepared (secrets masked). */
  text: string;
  file: string;
  size: { width: number; height: number };
}

/** What the orchestrator receives: the person's words first, then what they pointed at, the text read there and the crop. */
export function pointMessage(m: PointMessage): string {
  const where = [m.app, m.window && `"${m.window}"`].filter(Boolean).join(', ');
  const lines = [m.words.trim(), '', `Pointed at: ${m.label}${where ? ` in ${where}` : ''}`];
  if (m.text) lines.push('Text read there (secrets masked):', '"""', m.text, '"""');
  lines.push(`Screenshot (${m.size.width} × ${m.size.height}): ${m.file}`);
  return lines.join('\n');
}

/** How much of the review countdown is left after `dtMs`: it runs only while the card is on screen and not pointed at. */
export function countdown(remainingMs: number, dtMs: number, running: boolean): number {
  return running ? Math.max(0, remainingMs - dtMs) : remainingMs;
}

/** Spoken words on the review card: send it, or cancel it; anything else changes nothing. */
export function reviewCommand(words: string): 'send' | 'cancel' | null {
  const w = words.toLowerCase().replace(/[^\p{L}\s]+/gu, ' ').trim();
  if (/^(send( it)?|yes|go( ahead)?|ok(ay)?)( now| please)?$/.test(w)) return 'send';
  if (/^(cancel( it)?|no|stop|don t send( it)?)( please)?$/.test(w)) return 'cancel';
  return null;
}

/** The capture files to delete: point and say's own, older than CAPTURE_MAX_AGE_MS. */
export function staleCaptures(files: { name: string; mtimeMs: number }[], now: number): string[] {
  return files.filter((f) => f.name.startsWith(CAPTURE_PREFIX) && f.name.endsWith('.png') && now - f.mtimeMs > CAPTURE_MAX_AGE_MS).map((f) => f.name);
}

/** A capture's file name: sortable by time, never anything read from the screen. */
export function captureName(now: number, id: number): string {
  return `${CAPTURE_PREFIX}${new Date(now).toISOString().replace(/[:.]/g, '-')}-${id}.png`;
}
