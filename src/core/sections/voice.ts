// Settings → Agents → Talk to agents (lane L3): the agent key, and the Pane Session that hears it. Pure.
import type { Binding } from '../types';
import { binding, obj } from './fields';

export interface VoiceSettings {
  /** Held like the dictation key; what is said goes to the Voice orchestrator. Null: off. */
  key: Binding | null;
  /** The Pane Session Dictate created ("Voice") or the one chosen in Settings; null until first use. */
  sessionId: string | null;
}

/** Ctrl+Win, either side: never Right Ctrl alone, the dictation key. */
export const DEFAULT_VOICE: VoiceSettings = { key: { keys: ['ctrl', 'meta'] }, sessionId: null };

export function parseVoice(x: unknown, d: VoiceSettings = DEFAULT_VOICE): VoiceSettings {
  const a = obj(x);
  const id = typeof a.sessionId === 'string' && /^[\w.:-]{1,200}$/.test(a.sessionId) ? a.sessionId : a.sessionId === null ? null : d.sessionId;
  return { key: 'key' in a ? binding(a.key, d.key) : d.key, sessionId: id };
}
