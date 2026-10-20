// The flow guard: whether the person is in the middle of something, so a new card waits. They are dictating, typed
// in the last few seconds (only the time of the last key-down is known, never which key), or Windows says they are
// busy (a full-screen app, presenting). Pure.

/** A card that arrives this soon after the last key-down waits. */
export const TYPING_MS = 6000;

/** How often main asks Windows whether the person is busy. */
export const BUSY_POLL_MS = 2000;

/** What status reports: free, dictating, or focused (typing, or busy). */
export type Focus = 'free' | 'dictating' | 'focused';

/** Why cards are held right now, for the pill: "Held while you talk" or "3 waiting". */
export type HeldReason = 'paused' | 'talking' | 'typing' | 'busy' | 'round';

/**
 * SHQueryUserNotificationState's answer: QUNS_BUSY (2, a full-screen app), QUNS_RUNNING_D3D_FULL_SCREEN (3, a
 * game), QUNS_PRESENTATION_MODE (4) and QUNS_APP (7, a full-screen Store app) mean busy. Not present (1), accepts
 * notifications (5) and quiet time (6, the first hour after setting up Windows) don't.
 */
export function isBusyState(quns: number): boolean {
  return quns === 2 || quns === 3 || quns === 4 || quns === 7;
}

export function typingAt(typedAt: number, now: number): boolean {
  return now - typedAt < TYPING_MS;
}
