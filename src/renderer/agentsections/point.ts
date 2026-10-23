// Point and say (L6, Windows): the point key, how the review sends, the apps where it never captures, and where it
// sends (settings.point). On macOS and Linux it says it is Windows-only and offers nothing to change.
import { h } from '../bridge';
import { card, keyRecorder, radios } from '../settingsui';
import type { Section } from './types';

const row = { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', borderTop: '1px solid var(--stroke)' };

export const point: Section = ({ st, set }) => {
  const p = st.settings.point;
  const state = st.surfaces?.point as { supported?: boolean; helper?: string } | undefined;
  const heading = h('h2', {}, 'Point and say');
  const intro = h('p.muted.small', {}, 'Hold the point key over anything and say what you want. Dictate sends a crop, the text it reads there and your words to the Voice orchestrator. Nothing is captured until you hold the key, the screen edge glows while you do, and you see what goes before it is sent.');
  if (!state?.supported) return [heading, card('Windows only for now', 'Point and say reads the screen through Windows UI Automation. It is off on this system.')];
  const save = (patch: Partial<typeof p>) => void set({ point: { ...p, ...patch } });

  const appInput = h('input.textbox', { placeholder: 'App.exe', 'aria-label': 'App to never capture' });
  const add = () => {
    const name = appInput.value.trim();
    if (!name || /[\\/]/.test(name) || p.excludedApps.some((a) => a.toLowerCase() === name.toLowerCase())) return;
    save({ excludedApps: [...p.excludedApps, /\.exe$/i.test(name) ? name : `${name}.exe`] });
  };
  appInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') add();
  });
  const apps = h(
    'div',
    { style: { marginTop: '8px' } },
    ...p.excludedApps.map((a) => h('div', { style: row }, h('span', { style: { flex: '1' } }, a), h('button.button.subtle', { onclick: () => save({ excludedApps: p.excludedApps.filter((x) => x !== a) }) }, 'Remove'))),
    p.excludedApps.length ? null : h('p.muted.small', {}, 'None: the key works over every app.'),
  );

  return [
    heading,
    intro,
    card('Point key', 'Hold over an element, or hold and drag a box with the left button. Off until you choose one, so nothing captures by accident.', keyRecorder(p.key, (key) => save({ key }), () => save({ key: null }))),
    card(
      'Review before sending',
      'The card shows the crop, the text read there with secrets hidden, your words and where it goes.',
      null,
      radios('point-review', p.review, [
        ['countdown', 'Send after 3 s unless I stop it', 'Pointing at the card pauses it; Enter sends now, Esc cancels'],
        ['wait', 'Wait for Send every time', 'Nothing goes until you click Send'],
      ], (review) => save({ review })),
    ),
    card('Hide secrets', 'Always on. API keys, tokens, passwords and card numbers in the text read there become ••••••. The crop itself is not changed, so check it on the card.'),
    card('Never capture these apps', 'Over these apps the key does nothing: no glow, no crop, no text read. Matched by program name.', h('div.bindingrow', {}, appInput, h('button.button', { onclick: add }, 'Add app')), apps),
    card('Sends to', 'The Voice orchestrator, which passes it to the right agent. Set it up under Talk to agents.', h('span.muted', {}, 'Voice orchestrator')),
    state.helper === 'failed' ? card('The screen reader helper didn’t start', 'Without it Dictate can’t tell which app is under the pointer, so the point key captures nothing. The log in Advanced → Diagnostics says why.') : null,
  ];
};
