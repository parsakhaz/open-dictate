// The point-and-say review (L6): exactly what will go, before it goes. The crop as a thumbnail, the text read there
// with secrets masked (and how many), the person's words and where it is going; Send, Cancel and the "Sends in 3 s"
// ring, which stops while the pointer is over the card. Everything is text nodes; the thumbnail is decoded from the
// card's own data onto a canvas (the pill page loads no images by URL).
import { h } from '../bridge';
import type { BodyContext, CardBody, CardDto } from './types';

interface ReviewData {
  thumb: string;
  caption: string;
  textLabel: string;
  text: string;
  secrets: number;
  words: string;
  to: string;
  mode: 'countdown' | 'wait';
  remainingMs: number;
  paused: boolean;
}

const MASK = '••••••';

function isReview(x: unknown): x is ReviewData {
  const d = x as ReviewData;
  return !!d && typeof d === 'object' && typeof d.thumb === 'string' && typeof d.text === 'string' && typeof d.words === 'string';
}

function thumbnail(b64: string): HTMLCanvasElement {
  const canvas = h('canvas.pthumb');
  void (async () => {
    try {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext('2d')?.drawImage(bmp, 0, 0);
      bmp.close();
    } catch {
      canvas.classList.add('broken');
    }
  })();
  return canvas;
}

/** The read text, with each masked secret (and the prefix it kept, "sk-live-") marked. */
function readText(text: string): HTMLElement {
  const el = h('div.ptext');
  if (!text) {
    el.append(h('span.pnone', {}, 'No text read here. Only the crop goes.'));
    return el;
  }
  for (const part of text.split(/(\S*••••••)/)) if (part) el.append(part.includes(MASK) ? h('span.psecret', {}, part) : part);
  return el;
}

/** "Sends in 3 s" with a ring, counting down on its own between redraws, and still while paused. */
function countdownEl(d: ReviewData): HTMLElement {
  const ring = h('span.pring');
  const label = h('span', {});
  const el = h('div.pcount', {}, ring, label);
  const total = 3000;
  const start = performance.now();
  const draw = () => {
    const left = d.paused ? d.remainingMs : Math.max(0, d.remainingMs - (performance.now() - start));
    ring.style.setProperty('--p', String(1 - left / total));
    label.textContent = d.paused ? 'Paused while you look' : `Sends in ${Math.max(1, Math.ceil(left / 1000))} s`;
  };
  draw();
  if (!d.paused) {
    const timer = setInterval(() => {
      if (!el.isConnected && performance.now() - start > 500) return clearInterval(timer);
      draw();
    }, 100);
  }
  el.dataset.paused = String(d.paused);
  return el;
}

export const pointReview: CardBody = {
  parts(c: CardDto, ctx: BodyContext) {
    const d = c.data;
    if (!isReview(d)) return [h('div.title', {}, c.title)];
    const secrets = d.secrets ? h('span.psecrets', {}, `${d.secrets} secret${d.secrets === 1 ? '' : 's'} hidden`) : null;
    const grid = h(
      'div.pgrid',
      {},
      h('div.pshot', {}, thumbnail(d.thumb), h('div.pcaption', {}, d.caption)),
      h('div.pread', {}, h('div.plabel', {}, `Text read from the ${d.textLabel.toLowerCase()}`, secrets), readText(d.text)),
    );
    const said = h('div.psaid', {}, h('span.plabel', {}, 'You said'), h('span.pwords', {}, `“${d.words}”`), h('span.pto', {}, `→ ${d.to}`));
    const row = h('div.crow.prow', {}, ctx.button('Send', { id: c.id, action: 'kind', name: 'send' }, '.primary'), ctx.button('Cancel', { id: c.id, action: 'kind', name: 'cancel' }), d.mode === 'countdown' ? countdownEl(d) : h('div.pcount', {}, 'Waits for Send'));
    return [h('div.title', {}, c.title), grid, said, row];
  },
};
