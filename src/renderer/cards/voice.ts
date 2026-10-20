// "Voice has a draft · Open": the orchestrator's composer had text, so nothing was sent (L3). The words that weren't
// sent are quoted; Open shows the Session's chat in Pane, Try again sends them once the draft is gone, and holding the
// key over the card sends new words instead.
import { plainTitle } from '../../core/cardtext';
import { h } from '../bridge';
import { message } from './standard';
import type { CardBody } from './types';

export const voiceDraft: CardBody = {
  parts(c, ctx) {
    const said = (c.data as { text?: unknown } | undefined)?.text;
    const parts: HTMLElement[] = [h('div.title', {}, plainTitle(c.title))];
    if (c.message) parts.push(message(c.message));
    if (typeof said === 'string' && said) parts.push(h('div.vsaid', {}, 'You said ', h('q', {}, said)));
    if (ctx.replying) parts.push(h('div.creply', {}, h('span.rdot'), 'Replying by voice…'));
    else if (ctx.expanded) {
      const row = h('div.crow');
      if (c.canOpen) row.append(ctx.button('Open', { id: c.id, action: 'open' }, '.primary'));
      row.append(ctx.button('Try again', { id: c.id, action: 'kind', name: 'retry' }));
      if (c.canReply) row.append(ctx.button(ctx.armed ? 'Hold your key to reply' : 'Hold to reply', { id: c.id, action: 'arm-reply' }, ctx.armed ? '.armed' : ''));
      parts.push(row);
    }
    return parts;
  },
};
