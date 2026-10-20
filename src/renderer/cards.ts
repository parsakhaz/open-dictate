// Agent cards above the pill: the top card shows its source, its whole title and message at a glance, and on hover
// Dictate's own buttons; the list behind "+N". While the person answers it by voice it stays up, marked as such.
// Every word is shown as plain text. Only the cards take clicks: main watches the pointer, lets the window catch it
// while it is over a card, and says so here. The card's body eases to its new height whenever what it shows changes.
import { messageLines, plainTitle } from '../core/cardtext';
import { dictate, h } from './bridge';

export interface CardDto {
  id: string;
  kind: 'pane-blocked' | 'pane-ready' | 'notify' | 'ask' | 'consent' | 'vocab';
  urgency: 'info' | 'needs_you' | 'consent';
  source: string;
  sourceDetail?: string;
  title: string;
  message: string;
  choices: string[];
  linkHost: string | null;
  canOpen: boolean;
  canReply: boolean;
}

export interface CardsView {
  top: CardDto | null;
  more: number;
  list: CardDto[];
  replying: boolean;
}

type Action = { id: string; action: 'open' | 'dismiss' | 'link' | 'review' | 'arm-reply' } | { id: string; action: 'choose'; value: string } | { id: string; action: 'consent'; value: 'once' | 'session' | 'deny' };

const act = (a: Action) => void dictate.invoke('dictate:card-action', a);

const EASE = 'cubic-bezier(0.2, 0, 0, 1)';
/** A new card opens from its first line of title to everything it says. */
const OPEN_MS = 260;
const RESIZE_MS = 200;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function mountCards(parent: HTMLElement, before: Node): void {
  const box = h('div.cards');
  parent.insertBefore(box, before);
  let view: CardsView = { top: null, more: 0, list: [], replying: false };
  let hovered = false;
  let listOpen = false;
  let armed: string | null = null;
  /** The card on screen, kept while the same card is on top so redraws never replace it under the pointer. */
  let shown: { id: string; el: HTMLElement; body: HTMLElement; head: HTMLElement; drawn: string } | null = null;
  let resize: Animation | undefined;

  // From main, which watches the pointer against the card's rectangle (sent below).
  dictate.on('dictate:card-hover', (on: boolean) => {
    if (hovered === on) return;
    hovered = on;
    draw();
  });
  dictate.on('dictate:qa-list', () => {
    listOpen = true;
    draw();
  });

  const button = (label: string, a: Action, cls = '') =>
    h(`button.cbtn${cls}`, {
      onclick: (e: Event) => {
        e.stopPropagation();
        if (a.action === 'arm-reply') armed = a.id;
        act(a);
        draw();
      },
    }, label);

  function buttons(c: CardDto): HTMLElement {
    const row = h('div.crow');
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
    if (c.canReply) row.append(button(armed === c.id ? 'Hold your key to reply' : 'Hold to reply', { id: c.id, action: 'arm-reply' }, armed === c.id ? '.armed' : ''));
    if (c.linkHost) row.append(button(`Open link (${c.linkHost})`, { id: c.id, action: 'link' }, '.ghost'));
    return row;
  }

  /** The source line, "+N" and ✕. */
  function head(c: CardDto, expanded: boolean): HTMLElement[] {
    return [
      h('span.src', {}, expanded && c.sourceDetail ? `${c.source} · ${c.sourceDetail}` : c.source),
      view.more ? h('button.more', { onclick: (e: Event) => { e.stopPropagation(); listOpen = !listOpen; draw(); } }, `+${view.more}`) : null,
      c.kind === 'consent' || view.replying ? null : h('button.x', { title: 'Dismiss', onclick: (e: Event) => { e.stopPropagation(); act({ id: c.id, action: 'dismiss' }); } }, '✕'),
    ].filter((x): x is HTMLElement => !!x);
  }

  /** The title and message always; the buttons on hover (consent always); a note while it is being answered. */
  function bodyParts(c: CardDto, expanded: boolean): HTMLElement[] {
    const parts: HTMLElement[] = [h('div.title', {}, plainTitle(c.title))];
    if (c.message) parts.push(message(c.message));
    if (view.replying) parts.push(h('div.creply', {}, h('span.rdot'), 'Replying by voice…'));
    else if (expanded || c.kind === 'consent') parts.push(buttons(c));
    return parts;
  }

  /** Bold, italic and inline code as elements holding text nodes; everything else is plain text. Never HTML. */
  function message(md: string): HTMLElement {
    const el = h('div.msg');
    messageLines(md).forEach((line, i) => {
      if (i) el.append('\n');
      for (const r of line) el.append(r.style === 'b' ? h('strong', {}, r.text) : r.style === 'i' ? h('em', {}, r.text) : r.style === 'code' ? h('code', {}, r.text) : r.text);
    });
    return el;
  }

  /** Sets the card's contents, and eases its body from the old height to the new one. */
  function fill(c: CardDto, fresh: boolean): void {
    const expanded = hovered && !view.replying;
    const drawn = JSON.stringify([c, view.more, view.replying, expanded, armed === c.id]);
    if (!shown || fresh) {
      const headEl = h('div.chead');
      const body = h('div.cbody');
      const el = h('div.card', {
        onclick: () => {
          const top = view.top;
          if (top?.canOpen && top.kind !== 'consent' && !view.replying) act({ id: top.id, action: 'open' });
        },
      }, headEl, body);
      shown = { id: c.id, el, body, head: headEl, drawn: '' };
    }
    const s = shown;
    if (s.drawn === drawn) return;
    s.el.dataset.urgency = c.urgency;
    s.el.dataset.expanded = String(expanded);
    s.el.dataset.replying = String(view.replying);
    const from = s.drawn ? s.body.getBoundingClientRect().height : null;
    s.head.replaceChildren(...head(c, expanded));
    s.body.replaceChildren(...bodyParts(c, expanded));
    s.drawn = drawn;
    if (!box.contains(s.el)) box.replaceChildren(s.el);
    animateBody(s.body, from);
  }

  function animateBody(body: HTMLElement, from: number | null): void {
    const was = resize;
    resize = undefined;
    was?.cancel();
    body.style.overflow = '';
    if (reducedMotion() || !body.isConnected) return;
    const to = body.getBoundingClientRect().height;
    // A new card starts from its first line of title.
    const start = from ?? Math.min(to, (body.firstElementChild as HTMLElement | null)?.getBoundingClientRect().height ?? to);
    if (Math.abs(start - to) < 1) return;
    body.style.overflow = 'hidden';
    const a = body.animate([{ height: `${start}px` }, { height: `${to}px` }], { duration: from === null ? OPEN_MS : RESIZE_MS, easing: EASE });
    const done = () => {
      if (resize !== a) return;
      body.style.overflow = '';
      resize = undefined;
      sendRect();
    };
    a.onfinish = done;
    a.oncancel = done;
    resize = a;
  }

  function listEl(cards: CardDto[]): HTMLElement {
    return h(
      'div.list',
      {},
      ...cards.map((c) =>
        h('div.item', { 'data-urgency': c.urgency, onclick: () => c.canOpen && act({ id: c.id, action: 'open' }) },
          h('span.src', {}, c.source),
          h('span.title', {}, plainTitle(c.title)),
          h('button.x', { title: 'Dismiss', onclick: (e: Event) => { e.stopPropagation(); act({ id: c.id, action: 'dismiss' }); } }, '✕'),
        ),
      ),
      h('button.cbtn.ghost.close', { onclick: () => { listOpen = false; draw(); } }, 'Close'),
    );
  }

  /** Main checks the pointer against this at key down: holding the key over the card answers it. */
  function sendRect(): void {
    requestAnimationFrame(() => {
      const r = box.firstElementChild?.getBoundingClientRect();
      dictate.send('dictate:card-rect', r && view.top ? { x: r.x, y: r.y, width: r.width, height: r.height } : null);
    });
  }

  function draw(): void {
    const top = view.top;
    if (!top || view.replying) listOpen = false;
    if (armed && !view.list.some((c) => c.id === armed)) armed = null;
    if (!top) {
      shown = null;
      box.replaceChildren();
    } else if (listOpen) {
      shown = null;
      box.replaceChildren(listEl(view.list));
    } else {
      fill(top, shown?.id !== top.id);
    }
    box.classList.toggle('shown', !!top);
    sendRect();
  }

  dictate.on('dictate:cards', (v: CardsView) => {
    view = v;
    draw();
  });
}
