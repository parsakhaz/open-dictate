// Talk to agents (L3): the agent key, and which Pane Session hears it (settings.voice, and the feature's state).
import { dictate, h } from '../bridge';
import type { State } from '../settingsstate';
import { card, keyRecorder } from '../settingsui';
import type { Section } from './types';

interface VoiceState {
  installed: boolean;
  session: { id: string; name: string } | null;
  last: { at: number; result: { delivered: boolean; state?: string; blocked?: string; message?: string } } | null;
}

function lastLine(last: VoiceState['last']): string {
  if (!last) return '';
  const r = last.result;
  const when = new Date(last.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (r.delivered) return ` Last sent at ${when}.`;
  return ` The last try at ${when} wasn’t sent${r.blocked === 'draft' ? ': its chat had a draft' : r.message ? `: ${r.message}` : ''}.`;
}

export const voice: Section = ({ st, set, refresh }) => {
  const v = st.settings.voice;
  const state = st.surfaces?.voice as VoiceState | undefined;
  const sessionDesc = !state?.installed
    ? 'Needs Pane. Once Pane is installed, the agent key talks to a Pane Session named Voice.'
    : state.session
      ? `Your words go to the Pane Session “${state.session.name}”. Its orchestrator works out which tab should do it, and answers on the pill.${lastLine(state.last)}`
      : 'Dictate creates a Pane Session named Voice the first time you use the agent key. Its orchestrator works out which tab should do it, and answers on the pill.';
  return [
    h('h2', {}, 'Talk to agents'),
    card(
      'Agent key',
      'Hold it and say what you want done, in plain words; release to send. Your words show for 2 s first (Esc cancels), then go to the Voice orchestrator instead of being typed.',
      keyRecorder(v.key, (key) => set({ voice: { ...v, key } }), () => set({ voice: { ...v, key: null } })),
    ),
    card(
      'Voice orchestrator',
      sessionDesc,
      state?.session ? h('button.button.subtle', { onclick: () => refresh(dictate.invoke('dictate:voice:forget').then(() => dictate.invoke<State>('dictate:get-state'))) }, 'Start over') : null,
    ),
  ];
};
