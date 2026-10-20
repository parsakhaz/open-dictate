// Settings → Agents → the decision inbox (lane L2): the shortcut that starts a round. Pure.
import { VK } from '../hotkeys';
import type { Binding } from '../types';
import { binding, obj } from './fields';

export interface InboxSettings {
  /** Starts a decision round over the waiting cards; null turns it off. */
  roundKey: Binding | null;
}

export const DEFAULT_INBOX: InboxSettings = { roundKey: { keys: ['ctrl', 'alt', VK.Space] } };

export function parseInbox(x: unknown, d: InboxSettings = DEFAULT_INBOX): InboxSettings {
  const a = obj(x);
  return { roundKey: 'roundKey' in a ? binding(a.roundKey, d.roundKey) : d.roundKey };
}
