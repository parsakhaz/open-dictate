// The grown decision card: every question stacked with its choice chips, "2 of 3 answered", Send, and Expand, which
// opens the card in the sheet from now on (L1). A chip
// filled by voice flashes and its question says "by voice". While the person answers by voice, their words show in
// the card as they come, then through the usual 2 s preview. Every word is a text node; never HTML.
import { plainTitle } from '../../core/cardtext';
import { answeredCount, complete, type DecideData, isAnswered } from '../../core/decidecard';
import { dictate, h } from '../bridge';
import { message, standard } from './standard';
import type { BodyContext, CardBody, CardDto } from './types';

/** How long chips a sentence filled stay lit. */
const FLASH_MS = 700;

// ---------- the person's words for a card, shared with the approval card ----------

/** The words being said to a card, then previewed before they go: drawn into the replying card's slot. */
const said = { card: null as string | null, words: '', to: '', preview: false };
let slot: { el: HTMLElement; draw: (el: HTMLElement, s: typeof said) => void } | null = null;

function redrawSlot(): void {
  if (slot?.el.isConnected) slot.draw(slot.el, said);
}

dictate.on('dictate:partial', (text: string) => {
  if (!said.card || said.preview) return;
  said.words = text;
  redrawSlot();
});
dictate.on('dictate:pill', (m: { kind?: string; message?: string; to?: string }) => {
  if (m?.kind === 'reply-preview') {
    said.words = m.message ?? '';
    said.to = m.to ?? '';
    said.preview = true;
    redrawSlot();
  } else if (m?.kind && ['done', 'copied', 'info', 'error', 'idle'].includes(m.kind)) {
    said.card = null;
    said.words = '';
    said.preview = false;
  }
});

/** The element a replying card shows the person's words in; `draw` fills it whenever they change. */
export function saidSlot(cardId: string, draw: (el: HTMLElement, s: typeof said) => void): HTMLElement {
  if (said.card !== cardId) Object.assign(said, { card: cardId, words: '', to: '', preview: false });
  const el = h('div.dsaid');
  slot = { el, draw };
  draw(el, said);
  return el;
}

/** "Sending to billing-retry in 2 s · Esc to cancel", and a bar that runs down with main's preview timer. */
export function countdown(to: string): HTMLElement {
  return h(
    'div.dcount',
    {},
    h('div.creply', {}, h('span.rdot'), `Sending to ${to || 'the agent'} in 2 s`, h('span.desc', {}, ' · '), h('kbd', {}, 'Esc'), h('span.desc', {}, ' to cancel')),
    h('div.dbar', {}, h('i')),
  );
}

// ---------- the card ----------

const isData = (x: unknown): x is DecideData => !!x && typeof x === 'object' && Array.isArray((x as DecideData).questions) && Array.isArray((x as DecideData).answers);

function chip(c: CardDto, ctx: BodyContext, q: number, label: string, n: number, on: boolean, flash: boolean): HTMLElement {
  return h(
    `button.dchip${on ? '.sel' : ''}${flash ? '.flash' : ''}`,
    {
      'data-n': on ? '' : String(n),
      'aria-pressed': String(on),
      onclick: (e: Event) => {
        e.stopPropagation();
        ctx.act({ id: c.id, action: 'kind', name: 'pick', value: { q, label } });
      },
    },
    label,
  );
}

function question(c: CardDto, ctx: BodyContext, d: DecideData, i: number, flashing: Set<number>): HTMLElement {
  const q = d.questions[i];
  const a = d.answers[i];
  const done = isAnswered(a);
  const state = [
    done && a.via === 'voice' ? h('span.dheard', {}, h('span.rdot'), 'by voice') : null,
    done ? h('span.dok', { title: 'Answered' }, '✓') : q.multi ? h('span.dtag', {}, 'pick any') : null,
  ];
  const chosen = !q.multi && a.picked.length ? q.options.find((o) => o.label === a.picked[0]) : undefined;
  return h(
    `div.dq${done ? '' : '.pending'}`,
    { 'data-multi': String(q.multi) },
    h('div.dqh', {}, h(`span.dhead${done ? '.done' : '.acc'}`, {}, q.header), h('span.dqt', {}, q.question), ...state),
    h('div.dchips', {}, ...q.options.map((o, n) => chip(c, ctx, i, o.label, n + 1, a.picked.includes(o.label), flashing.has(i) && a.picked.includes(o.label)))),
    a.other ? h('div.dother', {}, `“${a.other}”`) : chosen?.description ? h('div.ddesc', {}, chosen.description) : null,
  );
}

export const decide: CardBody = {
  parts(c, ctx) {
    const d = c.data;
    if (!isData(d)) return standard.parts(c, ctx);
    const n = d.questions.length;
    const got = answeredCount(d);
    const flashing = new Set(d.flash && Date.now() - d.flash.at < FLASH_MS ? d.flash.qs : []);
    const expand = h(
      'button.dexpand',
      {
        title: 'Open every question larger, now and for later cards',
        onclick: (e: Event) => {
          e.stopPropagation();
          ctx.act({ id: c.id, action: 'kind', name: 'expand' });
        },
      },
      'Expand',
    );
    const parts: HTMLElement[] = [
      h('div.dtop', {}, h('div.title', {}, plainTitle(c.title)), n > 1 ? h(`span.dtag${got ? '.acc' : ''}`, {}, `${got} of ${n} answered`) : null, expand),
      message(c.message || (n > 1 ? 'Pick one per question, or hold your key and say them all at once.' : 'Pick one, or hold your key and say it.')),
      ...d.questions.map((_, i) => question(c, ctx, d, i, flashing)),
    ];
    if (ctx.replying) {
      parts.push(
        saidSlot(c.id, (el, s) => {
          el.replaceChildren(
            s.preview ? countdown(s.to) : h('div.creply', {}, h('span.rdot'), n > 1 ? 'Listening · say them all at once' : 'Listening'),
            ...(s.words ? [h('div.dquote', {}, `“${s.words}”`)] : []),
          );
        }),
      );
      return parts;
    }
    const left = n - got;
    parts.push(
      h(
        'div.dfoot',
        {},
        ctx.button('Send answers', { id: c.id, action: 'kind', name: 'send' }, complete(d) ? '.primary' : got ? '' : '.ghost'),
        ctx.button(ctx.armed ? 'Hold your key to answer' : 'Hold to answer', { id: c.id, action: 'arm-reply' }, '.armed'),
        h('span.dleft', {}, left ? `${left} left` : 'All answered'),
      ),
    );
    return parts;
  },
};
