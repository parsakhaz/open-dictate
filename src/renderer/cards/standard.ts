// Today's card body, used by every kind until its lane gives it its own: the title and message at a glance, an ask's
// choices always, Dictate's own buttons on hover (consent always), and a note while it is answered by voice.
import { cutWords } from '../../core/agenttext';
import { CAPS } from '../../core/agenttools';
import { fitMessage, plainTitle } from '../../core/cardtext';
import { h } from '../bridge';
import type { BodyContext, CardBody, CardDto } from './types';

function choice(c: CardDto, ctx: BodyContext, value: string): HTMLElement {
  return ctx.button(cutWords(value, CAPS.choice).text, { id: c.id, action: 'choose', value });
}

/** An ask's choices show at rest; hovering adds Open, Hold to reply and Snooze above them (base.css). */
const choicesAtRest = (c: CardDto) => c.kind === 'ask' && c.choices.length > 0;

function buttons(c: CardDto, ctx: BodyContext): HTMLElement {
  const row = h('div.crow');
  const { button } = ctx;
  if (c.kind === 'consent') {
    row.append(button('Allow once', { id: c.id, action: 'consent', value: 'once' }), button('Allow for this session', { id: c.id, action: 'consent', value: 'session' }), button('Deny', { id: c.id, action: 'consent', value: 'deny' }, '.warn'));
    return row;
  }
  if (c.kind === 'vocab') {
    row.append(button('Review', { id: c.id, action: 'review' }, '.primary'));
    return row;
  }
  if (c.canOpen) row.append(button('Open', { id: c.id, action: 'open' }, '.primary'));
  if (!choicesAtRest(c)) for (const value of c.choices) row.append(choice(c, ctx, value));
  if (c.canReply) row.append(button(ctx.armed ? 'Hold your key to reply' : 'Hold to reply', { id: c.id, action: 'arm-reply' }, ctx.armed ? '.armed' : ''));
  if (c.linkHost) row.append(button(`Open link (${c.linkHost})`, { id: c.id, action: 'link' }, '.ghost'));
  return row;
}

/** Bold, italic and inline code as elements holding text nodes; everything else is plain text. Never HTML. */
export function message(md: string): HTMLElement {
  const el = h('div.msg');
  fitMessage(md, CAPS.message).lines.forEach((line, i) => {
    if (i) el.append('\n');
    for (const r of line) el.append(r.style === 'b' ? h('strong', {}, r.text) : r.style === 'i' ? h('em', {}, r.text) : r.style === 'code' ? h('code', {}, r.text) : r.text);
  });
  return el;
}

export const standard: CardBody = {
  parts(c, ctx) {
    const parts: HTMLElement[] = [h('div.title', {}, plainTitle(c.title))];
    if (c.message) parts.push(message(c.message));
    if (ctx.replying) parts.push(h('div.creply', {}, h('span.rdot'), 'Replying by voice…'));
    else {
      if (choicesAtRest(c)) parts.push(h('div.crow.chips', {}, ...c.choices.map((value) => choice(c, ctx, value))));
      const row = ctx.expanded || c.kind === 'consent' ? buttons(c, ctx) : null;
      if (row?.childElementCount) parts.push(row);
    }
    return parts;
  },
};
