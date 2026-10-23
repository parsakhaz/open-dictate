// The lineup grid with stars in order, and the lightbox behind Open full size (L4). Images come from main as image
// data and are shown only as <img> (an SVG's scripts never run there); every word is a text node.
// Keys: 1–6 star (the order starred is the order sent), Space or Open full size for the lightbox, H and the arrows in
// it, Enter sends, Esc steps out of the lightbox and then closes the sheet back to the card.
import { dictate, h } from '../bridge';
import type { SheetPage } from './types';

interface Payload {
  cardId: string;
  title: string;
  message: string;
  source: string;
  pick: 'one' | 'many' | 'rank';
  max: number;
  candidates: { label: string; caption: string; image?: string; text?: string }[];
}

const ORD = ['1st', '2nd', '3rd', '4th', '5th', '6th'];
const STAR = 'M12 2.8l2.8 5.7 6.3.9-4.6 4.4 1.1 6.2L12 17.1 6.4 20l1.1-6.2L2.9 9.4l6.3-.9z';
const HEART = 'M12 20.3l-1.3-1.2C5.4 14.3 2 11.2 2 7.5 2 4.4 4.4 2 7.5 2c1.7 0 3.4.8 4.5 2.1C13.1 2.8 14.8 2 16.5 2 19.6 2 22 4.4 22 7.5c0 3.7-3.4 6.8-8.7 11.6z';

let p: Payload | null = null;
let root: HTMLElement | null = null;
let picks: number[] = [];
let mode: 'grid' | 'box' = 'grid';
let index = 0;
let sent = false;

function icon(d: string): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

const kbd = (k: string) => h('kbd', {}, k);

function toggle(i: number): void {
  if (!p || i < 0 || i >= p.candidates.length) return;
  index = i;
  if (picks.includes(i)) picks = picks.filter((x) => x !== i);
  else if (p.pick === 'one') picks = [i];
  else if (picks.length < p.max) picks = [...picks, i];
  draw();
}

function send(): void {
  if (!p || sent || !picks.length) return;
  sent = true;
  void dictate.invoke('dictate:lineup:send', p.cardId, picks);
}

function none(): void {
  if (!p || sent) return;
  sent = true;
  void dictate.invoke('dictate:lineup:none', p.cardId);
}

/** The candidate itself: its image, or its text as a quote. */
function view(c: Payload['candidates'][number], cls: string): HTMLElement {
  if (c.image) return h(`div.${cls}`, {}, h('img', { src: c.image, alt: c.label, draggable: 'false' }));
  return h(`div.${cls}.text`, {}, h('div.lu-text', {}, c.text ?? ''));
}

function rankText(i: number): string | null {
  const at = picks.indexOf(i);
  if (at < 0 || !p) return null;
  return p.pick === 'one' ? 'Pick' : ORD[at];
}

function grid(): HTMLElement[] {
  const pp = p!;
  const n = pp.candidates.length;
  const cells = pp.candidates.map((c, i) => {
    const on = picks.includes(i);
    const rank = rankText(i);
    return h(
      'div.lu-cell',
      { 'data-on': String(on) },
      h('button.lu-frame', { 'aria-label': `Candidate ${i + 1}`, onclick: () => toggle(i), ondblclick: () => openBox(i) }, view(c, 'lu-media')),
      h(
        'div.lu-meta',
        {},
        h('span.lu-num', {}, String(i + 1)),
        h('span.lu-label', {}, c.label),
        c.caption ? h('span.lu-cap', {}, c.caption) : null,
        rank ? h('span.lu-rank', {}, rank) : null,
        h('button.lu-star', { 'aria-label': `Star ${i + 1}`, 'aria-pressed': String(on), onclick: () => toggle(i) }, icon(STAR)),
      ),
    );
  });
  const say = pp.pick === 'one' ? 'Pick one · say ' : pp.pick === 'rank' ? 'Rank them · say ' : 'Pick favourites · say ';
  const example = pp.pick === 'one' ? '“three”' : '“two and four”';
  return [
    h('div.lu-grid', { 'data-n': String(n) }, ...cells),
    h(
      'div.lu-foot',
      {},
      h('span.say', {}, say, h('i', {}, example)),
      h('span.keys', {}, kbd('1'), '–', kbd(String(n)), pp.pick === 'one' ? ' pick ' : ' star ', kbd('Enter'), ' send'),
      h(
        'div.crow',
        {},
        h('button.cbtn', { onclick: none }, 'None of these'),
        h('button.cbtn', { onclick: () => openBox(picks.at(-1) ?? 0) }, 'Open full size'),
        h('button.cbtn.primary.lu-send', { disabled: !picks.length, onclick: send }, picks.length ? `Send (${picks.length})` : 'Send'),
      ),
    ),
  ];
}

function box(): HTMLElement[] {
  const pp = p!;
  const n = pp.candidates.length;
  const c = pp.candidates[index];
  const on = picks.includes(index);
  const rail = picks.map((i) =>
    h(
      'div.lu-short',
      {},
      h('button.lu-sframe', { 'aria-label': `Show ${i + 1}`, onclick: () => go(i) }, view(pp.candidates[i], 'lu-media')),
      h('div.lu-sline', {}, h('b', {}, String(i + 1)), h('span.lu-label', {}, pp.candidates[i].label), h('button.x', { 'aria-label': `Remove ${i + 1}`, onclick: () => toggle(i) }, '✕')),
    ),
  );
  if (picks.length < Math.min(pp.max, n)) rail.push(h('div.lu-slot', {}, 'Press ', kbd('H'), ' on another to add it here'));
  return [
    h(
      'div.lu-box',
      {},
      h(
        'div.lu-stage',
        {},
        h('div.lu-big', {}, view(c, 'lu-media'), h('button.lu-nav.prev', { 'aria-label': 'Previous', onclick: () => go(index - 1) }, '‹'), h('button.lu-nav.next', { 'aria-label': 'Next', onclick: () => go(index + 1) }, '›'), h('span.lu-count', {}, `${index + 1} / ${n}`)),
        h(
          'div.lu-meta',
          {},
          h('span.lu-num', {}, String(index + 1)),
          h('span.lu-label', {}, c.label),
          c.caption ? h('span.lu-cap', {}, c.caption) : null,
          h('button.lu-heart', { 'data-on': String(on), 'aria-pressed': String(on), onclick: () => toggle(index) }, icon(HEART), on ? 'In shortlist ' : 'Add to shortlist ', kbd('H')),
        ),
        h(
          'div.lu-legend',
          {},
          kbd('H'),
          ' heart ',
          kbd('←'),
          kbd('→'),
          ' move ',
          kbd('Enter'),
          ' send ',
          kbd('Esc'),
          ' back to the grid',
          h('span.lu-dots', {}, ...pp.candidates.map((_, i) => h('i', { 'data-at': String(i === index), 'data-on': String(picks.includes(i)) }))),
        ),
      ),
      h(
        'div.lu-rail',
        {},
        h('div.lu-rhead', {}, 'Shortlist', h('span', {}, `♥ ${picks.length}`)),
        h('div.lu-rlist', {}, ...rail),
        h('button.cbtn.primary.lu-send', { disabled: !picks.length, onclick: send }, picks.length ? `Send shortlist (${picks.length})` : 'Send shortlist'),
        h('button.cbtn', { onclick: none }, 'None of these'),
        h('div.lu-note', {}, 'Order is the order you picked.'),
      ),
    ),
  ];
}

function go(i: number): void {
  if (!p) return;
  const n = p.candidates.length;
  index = ((i % n) + n) % n;
  draw();
}

function openBox(i: number): void {
  mode = 'box';
  go(i);
}

function draw(): void {
  if (!p || !root) return;
  const el = h(
    'div.lu',
    { 'data-mode': mode, 'data-index': String(index), 'data-picks': JSON.stringify(picks) },
    h(
      'div.shead',
      {},
      h('span.ttl', {}, p.title),
      h('span.lu-src', {}, p.source),
      h('button.x', { 'aria-label': 'Close', title: 'Back to the card (Esc)', onclick: () => dictate.send('dictate:sheet-esc') }, '✕'),
    ),
    p.message && mode === 'grid' ? h('div.lu-msg', {}, p.message) : null,
    ...(mode === 'grid' ? grid() : box()),
  );
  root.replaceChildren(el);
}

export const lineup: SheetPage = {
  show(r, payload) {
    const next = payload as Payload | null;
    if (!next || !Array.isArray(next.candidates)) return;
    if (next.cardId !== p?.cardId) {
      picks = [];
      mode = 'grid';
      index = 0;
      sent = false;
    }
    p = next;
    root = r;
    draw();
  },
  hide() {
    p = null;
    root = null;
  },
  key(e) {
    if (!p || e.ctrlKey || e.altKey || e.metaKey) return false;
    const k = e.key;
    if (/^[1-6]$/.test(k)) {
      toggle(Number(k) - 1);
      return true;
    }
    if (k === 'Enter') {
      send();
      return true;
    }
    if (mode === 'grid') {
      if (k === ' ') {
        openBox(picks.at(-1) ?? index);
        return true;
      }
      return false;
    }
    if (k === 'h' || k === 'H') toggle(index);
    else if (k === 'ArrowLeft') go(index - 1);
    else if (k === 'ArrowRight') go(index + 1);
    else if (k === 'Escape' || k === ' ') {
      mode = 'grid';
      draw();
    } else return false;
    return true;
  },
};
