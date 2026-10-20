// The inbox on the pill (L2): the "3 waiting" badge and "Held while you talk" capsule, snooze chips on every expanded
// card, the snooze toast with Undo, the snoozed shelf with countdown rings, and the "Back from snooze" tag. Main
// sends the queue's summary with the cards (view.extra), the toast and the lengths on its own channels. Everything
// is plain text in elements.
import { bindingLabel } from '../../core/hotkeys';
import type { Binding } from '../../core/types';
import { dictate, h } from '../bridge';
import type { CardDto, CardsView, PillExtra } from './types';

interface Shelved {
  id: string;
  title: string;
  source: string;
  until: number;
  since: number;
}
interface Extra {
  waiting?: number;
  reason?: string | null;
  snoozed?: Shelved[];
  back?: string[];
}

const invoke = (name: string, ...args: unknown[]) => void dictate.invoke(`dictate:inbox:${name}`, ...args);

let strip: HTMLElement;
let extra: Extra = {};
let hasTop = false;
let lengths = [3, 5, 10];
let snoozeKey = 'Off';
let toast: { id: string; minutes: number; back: string } | null = null;
let shelfOpen = false;
let ticker: ReturnType<typeof setInterval> | undefined;

/** A ring that drains towards the minute the card comes back, with the time left inside. */
function ring(s: Shelved, now: number): HTMLElement {
  const left = Math.max(0, s.until - now);
  const total = Math.max(1, s.until - s.since);
  const r = 15;
  const c = 2 * Math.PI * r;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 36 36');
  svg.classList.add('ring');
  for (const [cls, dash] of [['track', 0], ['fill', c * (1 - left / total)]] as const) {
    const circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('cx', '18');
    circle.setAttribute('cy', '18');
    circle.setAttribute('r', String(r));
    circle.setAttribute('class', cls);
    if (cls === 'fill') {
      circle.setAttribute('stroke-dasharray', String(c));
      circle.setAttribute('stroke-dashoffset', String(dash));
    }
    svg.append(circle);
  }
  const m = Math.floor(left / 60_000);
  const sec = Math.floor((left % 60_000) / 1000);
  return h('span.ringbox', {}, svg as unknown as HTMLElement, h('span.ringtime', {}, `${m}:${String(sec).padStart(2, '0')}`));
}

function draw(): void {
  if (!strip) return;
  const now = Date.now();
  const snoozed = extra.snoozed ?? [];
  const parts: HTMLElement[] = [];
  if (shelfOpen && snoozed.length) {
    parts.push(
      h(
        'div.shelf',
        {},
        h('div.shelfhead', {}, h('span.ttl', {}, 'Snoozed'), h('span', {}, `· ${snoozed.length} card${snoozed.length === 1 ? '' : 's'}`), h('span.hint', {}, snoozeKey === 'Off' ? '' : `${snoozeKey} snoozes the top card`)),
        ...snoozed.map((s) =>
          h('div.shelfrow', { 'data-id': s.id }, ring(s, now), h('div.shelftext', {}, h('div.src', {}, s.source), h('div.title', {}, s.title)), h('button.cbtn.now', { onclick: () => invoke('now', s.id) }, 'Now'), h('button.x', { title: 'Drop', onclick: () => invoke('drop', s.id) }, '✕')),
        ),
      ),
    );
  }
  if (toast) {
    parts.push(h('div.toast', {}, h('span.clock', {}, '◷'), `Snoozed ${toast.minutes} min`, h('span.dim', {}, `· back at ${toast.back}`), h('button.undo', { onclick: () => invoke('undo-snooze') }, 'Undo')));
  }
  const caps: HTMLElement[] = [];
  const waiting = extra.waiting ?? 0;
  if (waiting && extra.reason === 'talking') caps.push(h('div.capsule.held', {}, h('span.pause', {}, '❚❚'), 'Held while you talk', h('span.dim', {}, `· ${waiting}`)));
  else if (waiting && !hasTop && extra.reason !== 'round' && extra.reason !== 'paused') caps.push(h('button.capsule.waiting', { title: 'Start a decision round', onclick: () => invoke('round') }, h('span.dot'), `${waiting} waiting`));
  if (snoozed.length && extra.reason !== 'round') caps.push(h('button.capsule.snoozed', { title: shelfOpen ? 'Close' : 'Show snoozed cards', onclick: () => { shelfOpen = !shelfOpen; draw(); } }, h('span.clock', {}, '◷'), `${snoozed.length} snoozed`));
  if (caps.length) parts.push(h('div.caps', {}, ...caps));
  if (!snoozed.length) shelfOpen = false;
  strip.replaceChildren(...parts);
  strip.classList.toggle('shown', parts.length > 0);
  // The shelf's rings count down while it is open.
  if (shelfOpen && !ticker) ticker = setInterval(draw, 1000);
  if (!shelfOpen && ticker) {
    clearInterval(ticker);
    ticker = undefined;
  }
  sendRects();
}

/** The badge, toast and shelf take clicks: main lets the click-through pill catch them there. */
function sendRects(): void {
  requestAnimationFrame(() => {
    const rects = [...strip.querySelectorAll<HTMLElement>('.shelf, .toast, .capsule')].map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    dictate.send('dictate:extra-rects', rects);
  });
}

export const inbox: PillExtra = {
  mount(root) {
    strip = h('div.inbox');
    const status = root.querySelector('.status');
    root.insertBefore(strip, status);
    dictate.on('dictate:inbox:toast', (t: typeof toast) => {
      toast = t;
      draw();
    });
    const config = (c: { lengths: number[]; key: Binding | null } | null) => {
      if (!c) return;
      lengths = c.lengths;
      snoozeKey = bindingLabel(c.key);
      draw();
    };
    dictate.on('dictate:inbox:config', config);
    void dictate.invoke<{ lengths: number[]; key: Binding | null }>('dictate:inbox:config').then(config, () => undefined);
    // QA: clicks on the strip without a pointer.
    dictate.on('dictate:inbox:qa', (what: string) => {
      const target = what === 'waiting' ? strip.querySelector<HTMLElement>('.capsule.waiting') : what === 'snoozed' ? strip.querySelector<HTMLElement>('.capsule.snoozed') : what === 'undo' ? strip.querySelector<HTMLElement>('.toast .undo') : what.startsWith('now ') ? strip.querySelector<HTMLElement>(`.shelfrow[data-id="${what.slice(4)}"] .now`) : what.startsWith('chip ') ? document.querySelector<HTMLElement>(`.cards .snz button[data-min="${what.slice(5)}"]`) : null;
      target?.click();
      const card = document.querySelector('.cards .card');
      dictate.send('dictate:inbox:qa-dump', {
        clicked: !!target,
        strip: strip.innerText,
        shelf: [...strip.querySelectorAll('.shelfrow')].map((r) => (r as HTMLElement).innerText),
        rings: strip.querySelectorAll('.ring').length,
        card: card ? (card as HTMLElement).innerText : null,
        back: !!document.querySelector('.cards .backtag'),
        chips: [...document.querySelectorAll('.cards .snz button')].map((b) => b.textContent),
      });
    });
  },
  update(view: CardsView) {
    extra = (view.extra ?? {}) as Extra;
    hasTop = !!view.top;
    draw();
  },
  cardParts(c: CardDto, ctx) {
    const parts: HTMLElement[] = [];
    if (extra.back?.includes(c.id)) parts.push(h('div.backtag', {}, h('span.clock', {}, '◷'), 'Back from snooze'));
    // The snooze row, under the card's own buttons, on every expanded card that can wait.
    if (ctx.expanded && !ctx.replying && c.urgency !== 'consent' && c.kind !== 'round-summary') {
      parts.push(
        h(
          'div.snz',
          {},
          h('span.lbl', {}, h('span.clock', {}, '◷'), 'Snooze'),
          ...lengths.map((m) => h('button.cbtn.chip', { 'data-min': String(m), onclick: (e: Event) => { e.stopPropagation(); invoke('snooze', c.id, m); } }, `${m}m`)),
          snoozeKey === 'Off' ? null : h('span.keys', {}, ...snoozeKey.split(' + ').map((k) => h('kbd', {}, k))),
        ),
      );
    }
    return parts;
  },
};
