// The decision round, right above the pill: the progress bar and "2 of 5", the queue chips (click one to jump to it),
// one decision with its choices as numbered tiles, the line on holding the dictation key, and the key legend. Keys:
// 1–4 choose, Enter approve (or open), S snooze, → skip, Esc ends the round. Everything is plain text in elements.
import { messageLines, plainTitle } from '../../core/cardtext';
import { dictate, h } from '../bridge';
import type { SheetPage } from './types';

interface Payload {
  position: { n: number; of: number };
  chips: { id: string; state: 'done' | 'now' | 'next'; label: string }[];
  card: { id: string; kind: string; source: string; age: number; title: string; message: string; choices: string[]; canOpen: boolean };
  lengths: number[];
  listening: boolean;
  heard: string;
}

const send = (name: string, ...args: unknown[]) => void dictate.invoke(`dictate:inbox:${name}`, ...args);
const kbd = (k: string) => h('kbd', {}, k);

function message(md: string): HTMLElement {
  const el = h('div.msg');
  messageLines(md).forEach((line, i) => {
    if (i) el.append('\n');
    for (const r of line) el.append(r.style === 'b' ? h('strong', {}, r.text) : r.style === 'i' ? h('em', {}, r.text) : r.style === 'code' ? h('code', {}, r.text) : r.text);
  });
  return el;
}

/** At most five chips: the done ones before "now" fold into the count when there are many. */
function chips(p: Payload): HTMLElement {
  const shown = p.chips.slice(0, 4);
  const rest = p.chips.length - shown.length;
  return h(
    'div.rchips',
    {},
    ...shown.map((c) => h(`button.rchip.${c.state}`, { onclick: () => c.state === 'next' && send('jump', c.id) }, c.state === 'done' ? h('span.tick', {}, '✓') : h('span.cdot'), c.label)),
    rest > 0 ? h('span.rchip.more', {}, h('span.cdot'), `+${rest}`) : null,
  );
}

export const round: SheetPage = {
  show(root, payload) {
    const p = payload as Payload;
    if (!p?.card) return;
    const c = p.card;
    const age = c.age < 1 ? 'just now' : `${c.age} min ago`;
    const bar = h('div.rbar', {}, ...Array.from({ length: p.position.of }, (_, i) => h(`span.seg${i < p.position.n - 1 ? '.done' : i === p.position.n - 1 ? '.now' : ''}`)));
    const tiles = c.choices.length
      ? h('div.rtiles', {}, ...c.choices.map((label, i) => h(`button.rtile${i === 0 ? '.first' : ''}`, { onclick: () => send('key', String(i + 1)) }, h('span.num', {}, String(i + 1)), h('span.lab', {}, label))))
      : null;
    const approve = c.choices.length ? `Approve 1` : c.canOpen ? 'Open' : null;
    root.replaceChildren(
      h('div.rhead', {}, h('span.ttl', {}, 'Decision round'), bar, h('span.pos', {}, `${p.position.n} of ${p.position.of}`), h('span.leave', {}, kbd('Esc'), 'leave')),
      chips(p),
      h('div.rcard', {}, h('div.src', {}, `${c.source} · asked ${age}`), h('div.rtitle', {}, plainTitle(c.title)), c.message ? message(c.message) : null, tiles),
      h(
        `div.rlisten${p.listening ? '.on' : ''}`,
        {},
        h('span.mic', {}, '●'),
        p.listening
          ? h('span', {}, 'Say ', h('b', {}, '“approve”'), ', ', h('b', {}, '“next”'), ', ', h('b', {}, `“snooze ${p.lengths[p.lengths.length - 1] ?? 10}”`), ' or your answer')
          : h('span', {}, 'Hold your dictation key and say your answer, ', h('b', {}, '“approve”'), ' or ', h('b', {}, '“next”')),
        p.heard ? h('span.heard', {}, `Heard “${p.heard}”`) : null,
      ),
      h(
        'div.rfoot',
        {},
        h('button.rbtn', { onclick: () => send('key', 's') }, 'Snooze', kbd('S')),
        h('button.rbtn', { onclick: () => send('key', 'ArrowRight') }, 'Skip', kbd('→')),
        h('span.grow'),
        approve ? h('button.rbtn.primary', { onclick: () => send('key', 'Enter') }, approve, kbd('Enter')) : null,
      ),
    );
  },
  key(e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return false;
    if (['1', '2', '3', '4', 'Enter', 's', 'S', 'ArrowRight', 'o', 'O'].includes(e.key)) {
      send('key', e.key);
      return true;
    }
    return false;
  },
};
