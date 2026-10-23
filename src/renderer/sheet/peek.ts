// The docked peek's chrome around the hardened view main places in this window: header, URL chip, the amber strip
// when the page tries to leave, and the confirm strip for a dragged region. The page itself is a separate window
// main lays over the hole this page leaves (and reports here); everything drawn is text nodes.
import type { PeekSheetAction, PeekSheetPayload } from '../../core/peekdata';
import { dictate, h } from '../bridge';
import type { SheetPage } from './types';

let current: PeekSheetPayload | null = null;
let hole: HTMLElement | null = null;
let observer: ResizeObserver | null = null;

const act = (name: PeekSheetAction) => dictate.send('dictate:peek:action', name);

function report(): void {
  if (!hole) return;
  const r = hole.getBoundingClientRect();
  dictate.send('dictate:peek:hole', { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
}

const btn = (label: string, name: PeekSheetAction, cls = '', title?: string) => h(`button.cbtn${cls}`, { onclick: () => act(name), title }, label);

function header(p: PeekSheetPayload): HTMLElement {
  const row = h(
    'div.row',
    {},
    h('span.src', {}, p.source),
    h('span.url', { title: p.url }, h('span.ok', { 'data-local': String(p.local) }), p.url),
    h('span.sp'),
    p.away ? btn('Back to the agent’s page', 'home', '.ghost') : null,
    btn('Open in browser', 'browser'),
    h('button.ib', { onclick: () => act('shrink'), title: 'Back to the card (Esc)', 'aria-label': 'Shrink' }, '⤡'),
    h('button.ib', { onclick: () => act('close'), title: 'Close the peek', 'aria-label': 'Close' }, '✕'),
  );
  const hint = p.talking
    ? h('div.hint.talking', {}, h('span.rdot'), `Talking about ${p.talking}…`)
    : h('div.hint', {}, 'Hold your dictation key over the page and talk. Drag to mark a region.');
  return h('div.phead', {}, row, h('div.title', {}, p.title), p.ask && p.ask !== p.title ? h('div.ask', {}, p.ask) : null, hint);
}

function blockedStrip(b: NonNullable<PeekSheetPayload['blocked']>): HTMLElement {
  return h(
    'div.pblocked',
    {},
    h('span.bang', {}, '!'),
    h(
      'div.btext',
      {},
      h('div.bt', {}, b.kind === 'popup' ? `This page tried to open ${b.host} in a new window` : `This page wants to go to ${b.host}`),
      h('div.bu', {}, b.url.length > 90 ? `${b.url.slice(0, 89)}…` : b.url),
      h(
        'div.brow',
        {},
        b.kind === 'navigate' ? btn('Allow once', 'allow', '.warn') : null,
        btn(b.kind === 'navigate' ? 'Stay' : 'OK', 'stay'),
        h('span.bnote', {}, b.kind === 'navigate' ? 'Opens in the peek; Back returns to the agent’s page.' : 'Pop-ups never open from a peek.'),
      ),
    ),
  );
}

function confirmStrip(c: NonNullable<PeekSheetPayload['confirm']>): HTMLElement {
  return h(
    'div.pconfirm',
    {},
    h('div.cimg', {}, h('img', { src: c.image, alt: 'The region that will be sent' })),
    h(
      'div.ctext',
      {},
      h('div.cmeta', {}, `Region ${c.size.width} × ${c.size.height} · `, h('span.to', {}, `→ ${c.to}`)),
      h('div.cwords', {}, `“${c.words}”`),
      c.under ? h('div.cunder', {}, h('code', {}, c.under.selector.split(' > ').pop() ?? ''), c.under.text ? ` ${c.under.text}` : '') : null,
    ),
    h('div.cbtns', {}, h('button.cbtn.primary', { onclick: () => act('send') }, 'Send ', h('kbd', {}, 'Enter')), h('button.cbtn', { onclick: () => act('drop') }, 'Esc')),
  );
}

export const peek: SheetPage = {
  show(root, payload) {
    const p = payload as PeekSheetPayload | null;
    if (!p || typeof p !== 'object') return;
    current = p;
    root.dataset.urgency = 'needs_you';
    hole = h('div.vp', {}, p.snapshot ? h('img.snap', { src: p.snapshot, alt: '' }) : null);
    root.replaceChildren(header(p), p.blocked ? blockedStrip(p.blocked) : '', hole, p.confirm ? confirmStrip(p.confirm) : '');
    observer?.disconnect();
    observer = new ResizeObserver(report);
    observer.observe(hole);
    requestAnimationFrame(report);
  },
  hide() {
    observer?.disconnect();
    observer = null;
    hole = null;
    current = null;
    const frame = document.querySelector<HTMLElement>('.sheet');
    if (frame) delete frame.dataset.urgency;
  },
  key(e) {
    if (!current?.confirm) return false;
    if (e.key === 'Enter') act('send');
    else if (e.key === 'Escape') act('drop');
    else return false;
    return true;
  },
};
