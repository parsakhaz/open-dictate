// The decision round, right above the pill: the progress bar and "2 of 5", the queue chips (click one to jump to it),
// one card with its choices as numbered tiles (a decision's questions each with theirs, an approval's plan), the line
// on holding the dictation key, and the key legend. Keys: 1–4 choose (on a decision, for the first question without a
// pick), Enter does what its button names, S snooze, → skip, Esc ends the round. Everything is plain text in elements.
import { cutWords } from '../../core/agenttext';
import { CAPS } from '../../core/agenttools';
import { fitMessage, plainTitle } from '../../core/cardtext';
import { dictate, h } from '../bridge';
import type { SheetPage } from './types';

interface Payload {
  position: { n: number; of: number };
  chips: { id: string; state: 'done' | 'now' | 'next'; label: string }[];
  card: {
    id: string;
    kind: string;
    source: string;
    age: number;
    title: string;
    message: string;
    choices: string[];
    questions?: { header: string; question: string; multi: boolean; options: string[]; picked: string[]; other: string }[];
    plan?: { summary: string[]; risk: string | null };
    /** What Enter sends or does, as its button reads; null when the card needs a pick first. */
    enter: string | null;
  };
  lengths: number[];
  listening: boolean;
  heard: string;
  note: string;
}

const send = (name: string, ...args: unknown[]) => void dictate.invoke(`dictate:inbox:${name}`, ...args);
const kbd = (k: string) => h('kbd', {}, k);
const tile = (n: number, label: string, cls: string, onclick: () => void) => h(`button.rtile${cls}`, { onclick }, h('span.num', {}, String(n)), h('span.lab', {}, cutWords(label, CAPS.choice).text));

/** A decision's questions, each with its options; picked tiles are lit, and the first question without a pick takes the number keys. */
function questions(qs: NonNullable<Payload['card']['questions']>): HTMLElement {
  const open = qs.findIndex((q) => !q.picked.length && !q.other);
  return h(
    'div.rqs',
    {},
    ...qs.map((q, i) =>
      h(
        `div.rq${i === open ? '.open' : ''}`,
        {},
        h('div.rqq', {}, h('span.rqh', {}, q.header), q.question, q.multi ? h('span.rqm', {}, ' · pick any') : null),
        h('div.rtiles', {}, ...q.options.map((label, k) => tile(k + 1, label, q.picked.includes(label) ? '.picked' : '', () => void dictate.invoke('dictate:inbox:pick', i, label)))),
        q.other ? h('div.rqo', {}, `“${q.other}”`) : null,
      ),
    ),
  );
}

/** What the person can say at this card. */
function sayable(p: Payload): (string | HTMLElement)[] {
  const c = p.card;
  const b = (t: string) => h('b', {}, t);
  const words: (string | HTMLElement)[] = c.questions
    ? ['your answers']
    : c.kind === 'approve'
      ? [b('“approve”'), 'what to change']
      : c.choices.length > 1
        ? ['a number', 'your answer']
        : c.enter && c.enter !== 'Open'
          ? [b('“approve”'), 'your answer']
          : ['your answer'];
  if (p.listening) words.push(b(`“snooze ${p.lengths[p.lengths.length - 1] ?? 10}”`));
  words.push(b('“next”'));
  return words.flatMap((w, i) => (i === 0 ? [w] : [i === words.length - 1 ? ' or ' : ', ', w]));
}

function message(md: string): HTMLElement {
  const el = h('div.msg');
  fitMessage(md, CAPS.message).lines.forEach((line, i) => {
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
    // A lone choice is what Enter sends, so it is lit; with several, none is.
    const tiles = c.questions
      ? questions(c.questions)
      : c.choices.length
        ? h('div.rtiles', {}, ...c.choices.map((label, i) => tile(i + 1, label, c.choices.length === 1 ? '.first' : '', () => send('key', String(i + 1)))))
        : null;
    const plan = c.plan ? h('div.rplan', {}, c.plan.risk ? h(`span.rrisk.${c.plan.risk}`, {}, `${c.plan.risk} risk`) : null, ...c.plan.summary.map((l) => h('div', {}, l))) : null;
    const ready = !c.questions || c.questions.every((q) => q.picked.length || q.other);
    root.replaceChildren(
      h('div.rhead', {}, h('span.ttl', {}, 'Decision round'), bar, h('span.pos', {}, `${p.position.n} of ${p.position.of}`), h('span.leave', {}, kbd('Esc'), 'leave')),
      chips(p),
      h('div.rcard', {}, h('div.src', {}, `${c.source} · asked ${age}`), h('div.rtitle', {}, plainTitle(c.title)), c.message ? message(c.message) : null, plan, tiles),
      h(`div.rlisten${p.listening ? '.on' : ''}`, {}, h('span.mic', {}, '●'), h('span', {}, p.listening ? 'Say ' : 'Hold your dictation key and say ', ...sayable(p)), p.heard ? h('span.heard', {}, `Heard “${p.heard}”`) : null),
      h(
        'div.rfoot',
        {},
        h('button.rbtn', { onclick: () => send('key', 's') }, 'Snooze', kbd('S')),
        h('button.rbtn', { onclick: () => send('key', 'ArrowRight') }, 'Skip', kbd('→')),
        h('span.grow'),
        p.note ? h('span.rnote', {}, p.note) : null,
        c.enter ? h(`button.rbtn.primary${ready ? '' : '.off'}`, { onclick: () => send('key', 'Enter') }, c.enter, kbd('Enter')) : null,
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
