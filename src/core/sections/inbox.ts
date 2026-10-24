// Settings → Agents → the decision inbox (lane L2): the shortcuts that start a round and pause cards. Pure.
import { VK } from '../hotkeys';
import type { Binding } from '../types';
import { binding, obj } from './fields';

export interface InboxSettings {
  /** Starts a decision round over the waiting cards; null turns it off. */
  roundKey: Binding | null;
  /** Pauses cards for 30 min; pressed again soon after, 1 h, then until resumed; pressed later, resumes. Null: off. */
  pauseKey: Binding | null;
}

/** Ctrl+Alt+P: P for pause. */
export const DEFAULT_INBOX: InboxSettings = { roundKey: { keys: ['ctrl', 'alt', VK.Space] }, pauseKey: { keys: ['ctrl', 'alt', 0x50] } };

export function parseInbox(x: unknown, d: InboxSettings = DEFAULT_INBOX): InboxSettings {
  const a = obj(x);
  return { roundKey: 'roundKey' in a ? binding(a.roundKey, d.roundKey) : d.roundKey, pauseKey: 'pauseKey' in a ? binding(a.pauseKey, d.pauseKey) : d.pauseKey };
}
