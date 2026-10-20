// Settings → Agents → Point and say (lane L6, Windows): the point key, the review before sending, the apps where it
// never captures, and where it sends. Pure.
import type { Binding } from '../types';
import { binding, obj, oneOf, strings } from './fields';

export interface PointSettings {
  /** Held over anything to point at it and talk. Unset by default, so nothing captures until the person picks a key. */
  key: Binding | null;
  /** The review card sends after 3 s (pointing pauses it), or waits for Send every time. */
  review: 'countdown' | 'wait';
  /** Process names (e.g. "KeePassXC.exe") where the point key does nothing. */
  excludedApps: string[];
  /** The Voice orchestrator, or the tab of the last card the person answered. */
  target: 'voice' | 'last-answered';
}

export const DEFAULT_POINT: PointSettings = { key: null, review: 'countdown', excludedApps: ['1Password.exe', 'Bitwarden.exe', 'KeePass.exe', 'KeePassXC.exe'], target: 'voice' };

export function parsePoint(x: unknown, d: PointSettings = DEFAULT_POINT): PointSettings {
  const a = obj(x);
  return {
    key: 'key' in a ? binding(a.key, d.key) : d.key,
    review: oneOf(a.review, ['countdown', 'wait'] as const, d.review),
    excludedApps: strings(a.excludedApps, d.excludedApps, 100, (s) => s.length <= 260 && !/[\\/]/.test(s)),
    target: oneOf(a.target, ['voice', 'last-answered'] as const, d.target),
  };
}
