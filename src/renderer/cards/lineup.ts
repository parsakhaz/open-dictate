// The lineup card: a strip of numbered thumbnails that opens the grid (L4). The thumbnails are small PNGs from main,
// decoded here and drawn on canvases (the pill's page loads no image URLs); a text or other candidate shows its
// number and label.
import { plainTitle } from '../../core/cardtext';
import { h } from '../bridge';
import { message } from './standard';
import type { CardBody, CardDto } from './types';

interface Data {
  pick: 'one' | 'many' | 'rank';
  candidates: { label: string; thumb?: string; text?: string }[];
}

/** Decoded thumbnails by card and place, so a redraw draws at once. */
const bitmaps = new Map<string, ImageBitmap | 'failed' | Promise<void>>();

function decode(key: string, b64: string, redraw: () => void): void {
  if (bitmaps.has(key)) return;
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  bitmaps.set(
    key,
    createImageBitmap(new Blob([bytes], { type: 'image/png' })).then(
      (bmp) => {
        bitmaps.set(key, bmp);
        redraw();
      },
      () => {
        bitmaps.set(key, 'failed');
      },
    ),
  );
}

function tile(c: CardDto, i: number, cand: Data['candidates'][number]): HTMLElement {
  const key = `${c.id}:${i}`;
  const el = h('div.lu-tile', { title: cand.label }, h('span.lu-n', {}, String(i + 1)));
  const draw = () => {
    const bmp = bitmaps.get(key);
    if (!(bmp instanceof ImageBitmap)) return false;
    const cv = h('canvas', { width: bmp.width, height: bmp.height });
    cv.getContext('2d')?.drawImage(bmp, 0, 0);
    el.prepend(cv);
    el.classList.add('img');
    return true;
  };
  if (cand.thumb) {
    decode(key, cand.thumb, () => {
      if (el.isConnected && !el.querySelector('canvas')) draw();
    });
    if (!draw()) el.append(h('span.lu-l', {}, cand.label));
  } else el.append(h('span.lu-l', {}, cand.text ? `“${cand.text}”` : cand.label));
  return el;
}

export const lineup: CardBody = {
  parts(c, ctx) {
    const d = (c.data ?? { pick: 'many', candidates: [] }) as Data;
    // Only the card on top keeps its thumbnails.
    for (const key of bitmaps.keys()) if (!key.startsWith(`${c.id}:`)) bitmaps.delete(key);
    const parts: HTMLElement[] = [h('div.title', {}, plainTitle(c.title))];
    if (c.message) parts.push(message(c.message));
    const open = (e: Event) => {
      e.stopPropagation();
      ctx.act({ id: c.id, action: 'kind', name: 'open' });
    };
    parts.push(h('div.lu-strip', { onclick: open }, ...d.candidates.map((cand, i) => tile(c, i, cand))));
    if (ctx.replying) parts.push(h('div.creply', {}, h('span.rdot'), 'Replying by voice…'));
    else if (ctx.expanded) {
      const n = d.candidates.length;
      parts.push(
        h(
          'div.crow',
          {},
          ctx.button('Open lineup', { id: c.id, action: 'kind', name: 'open' }, '.primary'),
          ctx.button('None of these', { id: c.id, action: 'kind', name: 'none' }),
          h('span.lu-say', {}, d.pick === 'one' ? `Hold your key and say a number, 1–${n}` : 'Hold your key and say “two and four”'),
        ),
      );
    }
    return parts;
  },
};
