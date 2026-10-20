// Field checks shared by settings.ts and the surfaces' settings sections: each takes what the file holds and a
// fallback, and never throws. Pure.
import type { Binding, KeySpec } from '../types';

const GENERIC = ['ctrl', 'shift', 'alt', 'meta'];

export function isKeySpec(x: unknown): x is KeySpec {
  return (typeof x === 'number' && Number.isInteger(x) && x > 0) || (typeof x === 'string' && GENERIC.includes(x));
}

/** `{ "keys": [165] }`, or the shorthand `[165]` people write by hand; null turns the key off. */
export function binding(x: unknown, fallback: Binding | null): Binding | null {
  if (x === null) return null;
  const keys = Array.isArray(x) ? x : (x as { keys?: unknown })?.keys;
  return Array.isArray(keys) && keys.length > 0 && keys.every(isKeySpec) ? { keys } : fallback;
}

export const str = (x: unknown, d: string) => (typeof x === 'string' && x.trim() ? x : d);
export const bool = (x: unknown, d: boolean) => (typeof x === 'boolean' ? x : d);
export const num = (x: unknown, d: number, lo: number, hi: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d);
export const oneOf = <T extends string>(x: unknown, options: readonly T[], d: T): T => options.find((o) => o === x) ?? d;
export const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {});

/** The strings that pass `ok`, trimmed, without repeats, at most `max`; the fallback when the field isn't a list. */
export function strings(x: unknown, fallback: string[], max: number, ok: (s: string) => boolean = () => true): string[] {
  if (!Array.isArray(x)) return fallback;
  const out: string[] = [];
  for (const v of x) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (s && ok(s) && !out.includes(s)) out.push(s);
    if (out.length === max) break;
  }
  return out;
}
