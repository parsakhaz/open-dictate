// Agent cards above the pill: the top card collapsed (source line and title), expanded on hover with the
// message and Dictate's own buttons, and the list behind "+N". Every word is shown as plain text. Only the cards
// take clicks: main lets the window catch the pointer while it is over them.
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
}

type Action = { id: string; action: 'open' | 'dismiss' | 'link' | 'review' | 'arm-reply' } | { id: string; action: 'choose'; value: string } | { id: string; action: 'consent'; value: 'once' | 'session' | 'deny' };

const act = (a: Action) => void dictate.invoke('dictate:card-action', a);

export function mountCards(parent: HTMLElement, before: Node): void {
  const box = h('div.cards');
  parent.insertBefore(box, before);
  let view: CardsView = { top: null, more: 0, list: [] };
  let hovered = false;
  let listOpen = false;
  let armed: string | null = null;

  /** The window takes the pointer only while it is over a card. */
  const over = (on: boolean) => {
    if (hovered === on) return;
    hovered = on;
    dictate.send('dictate:pill-mouse', on);
    draw();
  };
  box.addEventListener('mouseenter', () => over(true));
  box.addEventListener('mouseleave', () => over(false));
  // QA screenshots: expanded without a mouse.
  dictate.on('dictate:qa-hover', (on: boolean) => over(on));
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

  function cardEl(c: CardDto, more: number): HTMLElement {
    const expanded = hovered && !listOpen;
    const el = h(
      'div.card',
      {
        'data-urgency': c.urgency,
        'data-expanded': String(expanded),
        onclick: () => {
          if (c.canOpen && c.kind !== 'consent') act({ id: c.id, action: 'open' });
        },
      },
      h('div.chead', {}, h('span.src', {}, expanded && c.sourceDetail ? `${c.source} · ${c.sourceDetail}` : c.source),
        more ? h('button.more', { onclick: (e: Event) => { e.stopPropagation(); listOpen = !listOpen; draw(); } }, `+${more}`) : null,
        c.kind === 'consent' ? null : h('button.x', { title: 'Dismiss', onclick: (e: Event) => { e.stopPropagation(); act({ id: c.id, action: 'dismiss' }); } }, '✕')),
      h('div.title', {}, c.title),
      expanded || c.kind === 'consent' ? (c.message ? h('div.msg', {}, c.message) : null) : null,
      expanded || c.kind === 'consent' ? buttons(c) : null,
    );
    return el;
  }

  function listEl(cards: CardDto[]): HTMLElement {
    return h(
      'div.list',
      {},
      ...cards.map((c) =>
        h('div.item', { 'data-urgency': c.urgency, onclick: () => c.canOpen && act({ id: c.id, action: 'open' }) },
          h('span.src', {}, c.source),
          h('span.title', {}, c.title),
          h('button.x', { title: 'Dismiss', onclick: (e: Event) => { e.stopPropagation(); act({ id: c.id, action: 'dismiss' }); } }, '✕'),
        ),
      ),
      h('button.cbtn.ghost.close', { onclick: () => { listOpen = false; draw(); } }, 'Close'),
    );
  }

  function draw(): void {
    if (!view.top) listOpen = false;
    if (armed && !view.list.some((c) => c.id === armed)) armed = null;
    box.replaceChildren(...(view.top ? [listOpen ? listEl(view.list) : cardEl(view.top, view.more)] : []));
    box.classList.toggle('shown', !!view.top);
    if (!view.top && hovered) over(false);
    // Main checks the pointer against this at key down: holding the key over the card answers it.
    requestAnimationFrame(() => {
      const r = box.firstElementChild?.getBoundingClientRect();
      dictate.send('dictate:card-rect', r && view.top ? { x: r.x, y: r.y, width: r.width, height: r.height } : null);
    });
  }

  dictate.on('dictate:cards', (v: CardsView) => {
    view = v;
    draw();
  });
}
