// The inbox and snooze (L2): the round shortcut, the snooze shortcut and lengths, where a card returns (settings.inbox, settings.snooze).
import { h } from '../bridge';
import { card, keyRecorder, radios } from '../settingsui';
import type { Section } from './types';

export const snooze: Section = ({ st, set }) => {
  const s = st.settings.snooze;
  const inbox = st.settings.inbox;
  const setLengths = (minutes: number[]) => void set({ snooze: { ...s, minutes } });

  const add = h('input.textbox', {
    type: 'number',
    min: '1',
    max: '120',
    placeholder: 'min',
    'aria-label': 'Add a length in minutes',
    style: { width: '64px' },
    onkeydown: (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      const m = Math.round(Number((e.target as HTMLInputElement).value));
      if (m >= 1 && m <= 120 && !s.minutes.includes(m)) setLengths([...s.minutes, m]);
    },
  });
  const lengths = h(
    'div.presets',
    { 'data-setting': 'snooze.minutes' },
    ...s.minutes.map((m, i) =>
      h('span.chip', { 'data-active': String(i === 0), title: i === 0 ? 'The first press, and the round’s S' : '' }, `${m} min`, s.minutes.length > 1 ? h('button.chip', { 'aria-label': `Remove ${m} min`, style: { marginLeft: '6px', padding: '0 6px', border: '0' }, onclick: () => setLengths(s.minutes.filter((x) => x !== m)) }, '✕') : null),
    ),
    s.minutes.length < 3 ? add : null,
  );

  return [
    h('h2', {}, 'Inbox and snooze'),
    card('Decision round', 'Clears the waiting cards one by one, right above the pill, by keys or by saying “approve”, “next” or your answer.', keyRecorder(inbox.roundKey, (b) => void set({ inbox: { ...inbox, roundKey: b } }), () => void set({ inbox: { ...inbox, roundKey: null } }))),
    card('Snooze shortcut', 'Snoozes the card on top while one is up. Press again to snooze longer.', keyRecorder(s.key, (b) => void set({ snooze: { ...s, key: b } }), () => void set({ snooze: { ...s, key: null } }))),
    card('Snooze lengths', 'One to three, 1–120 minutes. Each press steps to the next; the first is the one-press default. Type a number and press Enter to add one.', null, lengths),
    card(
      'Snooze returns',
      'Where a card goes when its time is up.',
      null,
      radios('snooze-return', s.returnTo, [
        ['top', 'On top', 'back above the pill, where you’ll see it'],
        ['inbox', 'To the inbox', 'quietly, with a count on the pill'],
      ], (returnTo) => void set({ snooze: { ...s, returnTo } })),
    ),
  ];
};
