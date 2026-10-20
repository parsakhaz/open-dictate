// Today's card body, used by every kind until its lane gives it its own: the whole title and message at a glance,
// Dictate's own buttons on hover (consent always), and a note while it is answered by voice.
import { messageLines, plainTitle } from '../../core/cardtext';
import { h } from '../bridge';
import type { BodyContext, CardBody, CardDto } from './types';

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
  for (const choice of c.choices) row.append(button(choice, { id: c.id, action: 'choose', value: choice }));
  if (c.canReply) row.append(button(ctx.armed ? 'Hold your key to reply' : 'Hold to reply', { id: c.id, action: 'arm-reply' }, ctx.armed ? '.armed' : ''));
  if (c.linkHost) row.append(button(`Open link (${c.linkHost})`, { id: c.id, action: 'link' }, '.ghost'));
  return row;
}

/** Bold, italic and inline code as elements holding text nodes; everything else is plain text. Never HTML. */
export function message(md: string): HTMLElement {
  const el = h('div.msg');
  messageLines(md).forEach((line, i) => {
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
    else if (ctx.expanded || c.kind === 'consent') parts.push(buttons(c, ctx));
    return parts;
  },
};
