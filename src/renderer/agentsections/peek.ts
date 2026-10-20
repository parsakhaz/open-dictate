// Peek (L5): the https hosts a peek may show, added only by the person (settings.peek), and forgetting the sign-ins
// peek pages keep.
import { parsePeek } from '../../core/sections/peek';
import { dictate, h } from '../bridge';
import { card } from '../settingsui';
import type { Section } from './types';

/** What the person typed, as a host: "https://app.rungrain.com/doc/1" becomes "app.rungrain.com". */
export function hostFrom(input: string): string | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  let host = s;
  try {
    host = new URL(/^[a-z]+:\/\//.test(s) ? s : `https://${s}`).hostname;
  } catch {
    return null;
  }
  const parsed = parsePeek({ hosts: [host] }, { hosts: [] }).hosts;
  return parsed[0] ?? null;
}

/** The settings stylesheet is shared; this section's few layout rules stay with it. */
const ROW = { display: 'flex', alignItems: 'center', gap: '8px' };

export const peek: Section = ({ st, set }) => {
  const hosts = st.settings.peek.hosts;
  const save = (next: string[]) => set({ peek: { ...st.settings.peek, hosts: next } });
  const input = h('input.textbox', { placeholder: 'e.g. rungrain.com', 'data-setting': 'peek-host', 'aria-label': 'Host to allow' });
  const note = h('div.carddesc.peeknote', {});
  const add = () => {
    const host = hostFrom((input as HTMLInputElement).value);
    if (!host) {
      note.textContent = 'That isn’t a host name, like rungrain.com.';
      return;
    }
    if (hosts.includes(host)) {
      note.textContent = `${host} is already on the list.`;
      return;
    }
    void save([...hosts, host]);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') add();
  });
  const list = h(
    'div.peekhosts',
    { style: { display: 'grid', gap: '6px' } },
    ...(hosts.length
      ? hosts.map((host) => h('div.peekhost', { style: ROW }, h('code', {}, host), h('button.button.subtle', { onclick: () => void save(hosts.filter((x) => x !== host)), 'aria-label': `Remove ${host}` }, 'Remove')))
      : [h('div.muted.small', {}, 'No https hosts. Only localhost pages and local files can be shown.')]),
  );
  return [
    h('h2', {}, 'Peek'),
    h('p.muted.small', {}, 'Agents can show you a page on the pill and hear what you say about it. Pages on this computer (localhost) and HTML files inside the agent’s own folder always work. Any other site loads over https only, and only from hosts you add here; agents can’t add any.'),
    card('Sites a peek may show', h('span', {}, 'A host covers its subdomains: rungrain.com allows app.rungrain.com.'), null, h('div.peekedit', { style: { display: 'grid', gap: '10px', marginTop: '10px' } }, list, h('div.peekadd', { style: ROW }, input, h('button.button', { onclick: add }, 'Add')), note)),
    card(
      'Forget peek sign-ins',
      'Peek keeps its own cookies (separate from your browser) so a sign-in lasts. This clears them.',
      h('button.button', {
        onclick: async (e: Event) => {
          const b = e.currentTarget as HTMLButtonElement;
          b.disabled = true;
          await dictate.invoke('dictate:peek:forget');
          b.textContent = 'Forgotten';
        },
      }, 'Forget'),
    ),
  ];
};
