// Settings → Agents → Snooze (lane L2): the shortcut, the lengths it steps through, and where a card comes back.
// Pure.
import type { Binding } from '../types';
import { binding, obj, oneOf } from './fields';

export interface SnoozeSettings {
  /** Snoozes the card on screen for the first length; pressed again while the toast shows, the next. Null: off. */
  key: Binding | null;
  /** One to three lengths in minutes, each 1–120. */
  minutes: number[];
  /** A returning card goes back on top, or waits in the inbox. */
  returnTo: 'top' | 'inbox';
}

/** Ctrl+Alt+Z: Z for zzz (Ctrl+Alt+S is Settings in JetBrains IDEs). */
export const DEFAULT_SNOOZE: SnoozeSettings = { key: { keys: ['ctrl', 'alt', 0x5a] }, minutes: [3, 5, 10], returnTo: 'top' };

function lengths(x: unknown, d: number[]): number[] {
  if (!Array.isArray(x)) return d;
  const out = [...new Set(x.filter((m): m is number => typeof m === 'number' && Number.isFinite(m)).map((m) => Math.round(Math.min(120, Math.max(1, m)))))].slice(0, 3);
  return out.length ? out : d;
}

export function parseSnooze(x: unknown, d: SnoozeSettings = DEFAULT_SNOOZE): SnoozeSettings {
  const a = obj(x);
  return {
    key: 'key' in a ? binding(a.key, d.key) : d.key,
    minutes: lengths(a.minutes, d.minutes),
    returnTo: oneOf(a.returnTo, ['top', 'inbox'] as const, d.returnTo),
  };
}
