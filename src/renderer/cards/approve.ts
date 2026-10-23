// The approval card: the plan in bullets, the risk line, Approve, Open plan and Hold to change (L1). Once the person
// lets go of the key, the plan folds to one line and their words show as a quote under "You asked for a change",
// with main's 2 s preview as the countdown (Esc keeps the card as it was). At high risk the ring turns amber and
// only a click approves. Every word is a text node; never HTML.
import { plainTitle } from '../../core/cardtext';
import { isApproval } from '../../core/decidematch';
import { h } from '../bridge';
import { countdown, saidSlot } from './decide';
import { standard } from './standard';
import type { CardBody } from './types';

export interface ApproveView {
  summary: string[];
  risk: 'low' | 'medium' | 'high' | null;
  link: string | null;
}

const isView = (x: unknown): x is ApproveView => !!x && typeof x === 'object' && Array.isArray((x as ApproveView).summary);

const RISK = { medium: ['Medium risk', 'Read the plan before you approve.'], high: ['High risk', 'Only a click approves.'] } as const;

export const approve: CardBody = {
  parts(c, ctx) {
    const d = c.data;
    if (!isView(d)) return standard.parts(c, ctx);
    const risk = d.risk === 'medium' || d.risk === 'high' ? d.risk : null;
    const n = d.summary.length;
    const fold = `${n ? `${n}-step plan · ` : ''}${d.summary.join(' · ')}`;
    const parts: HTMLElement[] = [
      h('div.title', {}, plainTitle(c.title)),
      ...(c.message ? [h('div.msg', {}, c.message)] : []),
      n ? h('ul.aplan', {}, ...d.summary.map((l) => h('li', {}, l))) : h('div.aplan'),
      h('div.afold', {}, risk ? h(`span.dtag.${risk === 'high' ? 'red' : 'amb'}`, {}, RISK[risk][0]) : null, h('span', {}, fold)),
      risk ? h('div.arisk', { 'data-risk': risk }, h(`span.dtag.${risk === 'high' ? 'red' : 'amb'}`, {}, RISK[risk][0]), h('span', {}, RISK[risk][1])) : h('div.arisk', { 'data-risk': 'low', hidden: true }),
    ];
    if (ctx.replying) {
      parts.push(
        saidSlot(c.id, (el, s) => {
          // The card folds once the words are back, and opens again if the preview is cancelled.
          el.dataset.change = String(s.preview && !isApproval(s.words));
          if (!s.preview) {
            el.replaceChildren(h('div.creply', {}, h('span.rdot'), 'Listening · say a change or “approve”'), ...(s.words ? [h('div.dquote', {}, `“${s.words}”`)] : []));
          } else if (isApproval(s.words)) {
            el.replaceChildren(h('div.creply', {}, h('span.rdot'), risk === 'high' ? 'High risk · only a click approves' : 'Approving in 2 s · Esc cancels'));
          } else {
            el.replaceChildren(h('div.aask', {}, 'You asked for a change:'), h('div.dquote', {}, `“${s.words}”`), countdown(s.to));
          }
        }),
      );
      return parts;
    }
    parts.push(
      h(
        'div.crow.afoot',
        {},
        ctx.button('Approve', { id: c.id, action: 'kind', name: 'approve' }, '.primary'),
        d.link || c.canOpen ? ctx.button('Open plan', { id: c.id, action: 'kind', name: 'plan' }) : null,
        ctx.button(ctx.armed ? 'Hold your key to change' : 'Hold to change', { id: c.id, action: 'arm-reply' }, '.armed'),
      ),
    );
    return parts;
  },
};
