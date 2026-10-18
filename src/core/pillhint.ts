// What the pill's hint says, and when it shows. Pure.
import type { RecordMode } from './hotkeys';

/** How finishing works in this recording: release, tap the dictation key, or press the combo that started it. */
export function finishHint(mode: RecordMode, via: 'combo' | undefined, labels: { hotkey: string; toggle: string }): string {
  if (mode === 'push-to-talk') return 'Release to finish';
  if (via === 'combo') return `${labels.toggle} to finish`;
  return `Tap ${labels.hotkey} to finish`;
}

/** The hint teaches: the first few recordings only, and only their first seconds. */
export const HINT_SESSIONS = 3;
export const HINT_MS = 3000;

export function hintVisible(sessionsBefore: number, msSinceStart: number): boolean {
  return sessionsBefore < HINT_SESSIONS && msSinceStart < HINT_MS;
}
