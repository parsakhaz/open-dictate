// The inbox on the pill (L2): the "3 waiting" badge, the "Held while you talk" and "Paused" capsules, the Snooze
// button on every expanded card (its next length), the snooze and dismiss toasts with Undo, the snoozed shelf with
// countdown rings, the "Back from snooze" tag, the "earlier" list of faded notes, and one pulse when a card an agent
// waits on arrives. Main sends the queue's summary with the cards (view.extra), the toast and the lengths on its own
// channels. Everything is plain text in elements.
import { bindingLabel } from '../../core/hotkeys';
import { clockTime, snoozeLength } from '../../core/round';
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
interface Recent {
  id: string;
  source: string;
  title: string;
  message: string;
  at: number;
}
interface Extra {
  waiting?: number;
  reason?: string | null;
  /** When a timed pause ends. */
  pausedUntil?: number;
  snoozed?: Shelved[];
  back?: string[];
  recent?: Recent[];
  /** A note faded a moment ago: the "earlier" capsule shows on its own. */
  recentFresh?: boolean;
}

const invoke = (name: string, ...args: unknown[]) => void dictate.invoke(`dictate:inbox:${name}`, ...args);

let strip: HTMLElement;
let extra: Extra = {};
let hasTop = false;
let lengths = [3, 5, 10];
let snoozeKey = 'Off';
let toast: { id: string; kind: 'snoozed'; minutes: number; back: string } | { id: string; kind: 'dismissed' } | null = null;
let shelfOpen = false;
let earlierOpen = false;
let pulseDue = false;
let ticker: ReturnType<typeof setInterval> | undefined;
let drawn = '';

/** "now", "4 min", "1 h": how long ago a note faded. */
function ago(at: number, now: number): string {
  const m = Math.floor((now - at) / 60_000);
  return m < 1 ? 'now' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h`;
}

/** One soft ring around the card, or the waiting badge when the card is held: a card an agent waits on arrived. */
function pulse(): void {
  pulseDue = false;
  const el = document.querySelector<HTMLElement>('.cards .card') ?? strip.querySelector<HTMLElement>('.capsule.waiting');
  if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  el.animate([{ boxShadow: '0 0 0 1.5px rgba(96, 205, 255, 1), 0 0 0 0 rgba(96, 205, 255, 0.5)' }, { boxShadow: '0 0 0 1.5px rgba(96, 205, 255, 1), 0 0 0 12px rgba(96, 205, 255, 0)' }], { duration: 900, easing: 'ease-out' });
}

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
  const next = JSON.stringify([extra, hasTop, lengths, snoozeKey, toast, shelfOpen, earlierOpen]);
  if (next === drawn) return;
  drawn = next;
  const now = Date.now();
  const snoozed = extra.snoozed ?? [];
  const recent = extra.recent ?? [];
  const parts: HTMLElement[] = [];
  if (earlierOpen && recent.length) {
    parts.push(
      h(
        'div.shelf.earlier',
        {},
        h('div.shelfhead', {}, h('span.ttl', {}, 'Earlier'), h('button.cbtn.ghost.close', { onclick: () => { earlierOpen = false; draw(); } }, 'Close')),
        ...recent.map((r) => h('div.shelfrow', { 'data-id': r.id }, h('span.ago', {}, ago(r.at, now)), h('div.shelftext', {}, h('div.src', {}, r.source), h('div.title', {}, r.title), r.message ? h('div.msg', {}, r.message) : null))),
      ),
    );
  }
  if (shelfOpen && snoozed.length) {
    parts.push(
      h(
        'div.shelf',
        {},
        h('div.shelfhead', {}, h('span.ttl', {}, 'Snoozed'), h('span', {}, `· ${snoozed.length} card${snoozed.length === 1 ? '' : 's'}`)),
        ...snoozed.map((s) =>
          h('div.shelfrow', { 'data-id': s.id }, ring(s, now), h('div.shelftext', {}, h('div.src', {}, s.source), h('div.title', {}, s.title)), h('button.cbtn.now', { onclick: () => invoke('now', s.id) }, 'Now'), h('button.x', { title: 'Drop', onclick: () => invoke('drop', s.id) }, '✕')),
        ),
      ),
    );
  }
  if (toast?.kind === 'snoozed') {
    parts.push(h('div.toast', {}, h('span.clock', {}, '◷'), `Snoozed ${toast.minutes} min`, h('span.dim', {}, `· back at ${toast.back}`), h('button.undo', { onclick: () => invoke('undo') }, 'Undo')));
  } else if (toast) {
    parts.push(h('div.toast', {}, 'Dismissed', h('button.undo', { onclick: () => invoke('undo') }, 'Undo')));
  }
  const caps: HTMLElement[] = [];
  const waiting = extra.waiting ?? 0;
  if (extra.reason === 'paused') {
    const until = extra.pausedUntil ? `Paused until ${clockTime(extra.pausedUntil)}` : 'Paused';
    caps.push(h('button.capsule.paused', { title: 'Resume cards', onclick: () => invoke('resume') }, h('span.pause', {}, '❚❚'), until, waiting ? h('span.dim', {}, `· ${waiting} waiting`) : null, h('span.resume', {}, 'Resume')));
  } else if (waiting && extra.reason === 'talking') caps.push(h('div.capsule.held', {}, h('span.pause', {}, '❚❚'), 'Held while you talk', h('span.dim', {}, `· ${waiting}`)));
  else if (waiting && !hasTop && extra.reason !== 'round' && extra.reason !== 'paused') caps.push(h('button.capsule.waiting', { title: 'Start a decision round', onclick: () => invoke('round') }, h('span.wdot'), `${waiting} waiting`));
  if (snoozed.length && extra.reason !== 'round') caps.push(h('button.capsule.snoozed', { title: shelfOpen ? 'Close' : 'Show snoozed cards', onclick: () => { shelfOpen = !shelfOpen; draw(); } }, h('span.clock', {}, '◷'), `${snoozed.length} snoozed`));
  // The faded notes: on their own just after one fades, else alongside whatever else the pill shows.
  if (recent.length && extra.reason !== 'round' && (extra.recentFresh || hasTop || caps.length || parts.length)) caps.push(h('button.capsule.earlier', { title: earlierOpen ? 'Close' : 'Show earlier notes', onclick: () => { earlierOpen = !earlierOpen; draw(); } }, `${recent.length} earlier`));
  if (caps.length) parts.push(h('div.caps', {}, ...caps));
  if (!snoozed.length) shelfOpen = false;
  if (!recent.length) earlierOpen = false;
  strip.replaceChildren(...parts);
  strip.classList.toggle('shown', parts.length > 0);
  // The shelf's rings count down while it is open.
  if (shelfOpen && !ticker) ticker = setInterval(() => {
    for (const item of extra.snoozed ?? []) {
      const row = [...strip.querySelectorAll<HTMLElement>('.shelfrow')].find((el) => el.dataset.id === item.id);
      // Only countdown paint changes; action nodes, focus, and in-flight clicks survive.
      row?.querySelector('.ringbox')?.replaceWith(ring(item, Date.now()));
    }
  }, 1000);
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
    // Listening before the cards do, so a card drawn for this view already sees its "Back from snooze".
    dictate.on('dictate:cards', (v: CardsView) => {
      extra = (v.extra ?? {}) as Extra;
    });
    // The card arrives in the next view; the pulse waits for it.
    dictate.on('dictate:pulse', () => {
      pulseDue = true;
    });
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
      const target = what === 'waiting' ? strip.querySelector<HTMLElement>('.capsule.waiting') : what === 'snoozed' ? strip.querySelector<HTMLElement>('.capsule.snoozed') : what === 'earlier' ? strip.querySelector<HTMLElement>('.capsule.earlier') : what === 'snooze' ? document.querySelector<HTMLElement>('.cards .snz button') : what === 'undo' ? strip.querySelector<HTMLElement>('.toast .undo') : what.startsWith('now ') ? strip.querySelector<HTMLElement>(`.shelfrow[data-id="${what.slice(4)}"] .now`) : what.startsWith('chip ') ? document.querySelector<HTMLElement>(`.cards .snz button[data-min="${what.slice(5)}"]`) : null;
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
        earlier: [...strip.querySelectorAll('.earlier .shelfrow')].map((r) => (r as HTMLElement).innerText),
      });
    });
  },
  update(view: CardsView) {
    extra = (view.extra ?? {}) as Extra;
    hasTop = !!view.top;
    draw();
    if (pulseDue) requestAnimationFrame(pulse);
  },
  cardParts(c: CardDto, ctx) {
    const parts: HTMLElement[] = [];
    if (extra.back?.includes(c.id)) parts.push(h('div.backtag', {}, h('span.clock', {}, '◷'), 'Back from snooze'));
    // The snooze row, under the card's own buttons, on every expanded card that can wait: one button, for the card's
    // next length.
    if (ctx.expanded && !ctx.replying && c.urgency !== 'consent' && c.kind !== 'round-summary') {
      const m = snoozeLength(lengths, c.snoozes ?? 0);
      parts.push(
        h(
          'div.snz',
          {},
          h('button.cbtn.chip', { 'data-min': String(m), onclick: (e: Event) => { e.stopPropagation(); invoke('snooze', c.id); } }, h('span.clock', {}, '◷'), `Snooze ${m} min`),
          snoozeKey === 'Off' ? null : h('span.keys', {}, ...snoozeKey.split(' + ').map((k) => h('kbd', {}, k))),
        ),
      );
    }
    return parts;
  },
};
