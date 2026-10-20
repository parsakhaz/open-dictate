// The peek card: the title, a live thumbnail of the page beside the message and its address, and Peek, Open in
// browser, Open in Pane and Hold to reply on hover. The thumbnail arrives as pixels and is drawn on a canvas (the
// pill takes no images); the address and the agent's words are text nodes.
import { plainTitle } from '../../core/cardtext';
import type { PeekCardData } from '../../core/peekdata';
import { h } from '../bridge';
import { message } from './standard';
import type { BodyContext, CardBody, CardDto } from './types';

const canvases = new Map<string, { at: string; el: HTMLCanvasElement }>();

function thumb(c: CardDto, d: PeekCardData): HTMLElement {
  const box = h('div.pthumb', { 'data-state': d.failed ? 'failed' : d.loading ? 'loading' : 'live' });
  if (d.thumb) {
    // Redraw only when the pixels changed; the card redraws on every queue change.
    const key = `${d.thumb.width}x${d.thumb.height}:${d.thumb.rgba.length}:${d.thumb.rgba.slice(-64)}`;
    let cv = canvases.get(c.id);
    if (!cv || cv.at !== key) {
      const el = cv?.el ?? h('canvas');
      el.width = d.thumb.width;
      el.height = d.thumb.height;
      const bytes = Uint8ClampedArray.from(atob(d.thumb.rgba), (ch) => ch.charCodeAt(0));
      el.getContext('2d')?.putImageData(new ImageData(bytes, d.thumb.width, d.thumb.height), 0, 0);
      cv = { at: key, el };
      canvases.set(c.id, cv);
    }
    box.append(cv.el);
  } else box.append(h('div.pthumb-note', {}, d.failed ? 'Couldn’t load' : 'Loading…'));
  if (d.thumb && d.live && !d.docked && !d.failed) box.append(h('span.plive', {}, 'LIVE'));
  if (d.docked) box.append(h('span.plive.open', {}, 'OPEN'));
  return box;
}

function buttons(c: CardDto, d: PeekCardData, ctx: BodyContext): HTMLElement {
  const row = h('div.crow');
  const { button } = ctx;
  if (!d.docked) row.append(button('Peek', { id: c.id, action: 'kind', name: 'peek' }, '.primary'));
  row.append(button('Open in browser', { id: c.id, action: 'kind', name: 'browser' }));
  if (d.canPane) row.append(button('Open in Pane', { id: c.id, action: 'kind', name: 'pane' }));
  row.append(button(ctx.armed ? 'Hold your key to reply' : 'Hold to reply', { id: c.id, action: 'arm-reply' }, ctx.armed ? '.armed' : '.reply'));
  return row;
}

export const peek: CardBody = {
  parts(c, ctx) {
    const d = c.data as PeekCardData | undefined;
    const parts: HTMLElement[] = [h('div.title', {}, plainTitle(c.title))];
    if (!d) {
      if (c.message) parts.push(message(c.message));
      return parts;
    }
    for (const id of canvases.keys()) if (id !== c.id && canvases.size > 8) canvases.delete(id);
    const side = h('div.pside');
    if (c.message) side.append(message(c.message));
    if (d.ask && d.ask !== c.message) side.append(h('div.pask', {}, d.ask));
    side.append(h('div.purl', {}, h('span.pdot', { 'data-local': String(d.local) }), d.url));
    if (d.failed) side.append(h('div.pfail', {}, d.failed));
    else if (d.docked) side.append(h('div.pnote', {}, 'Open above. Hold your key over the page to point and talk.'));
    parts.push(h('div.pbody', {}, thumb(c, d), side));
    if (ctx.replying) parts.push(h('div.creply', {}, h('span.rdot'), 'Replying by voice…'));
    else if (ctx.expanded) parts.push(buttons(c, d, ctx));
    return parts;
  },
};
