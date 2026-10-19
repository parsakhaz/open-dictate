// The history picker (Right Ctrl+V by default): like Windows clipboard history, for dictations. The window never takes
// focus; main forwards the keys it swallows while the picker is open.
import { type HistoryEntry, HistoryStore, relativeTime } from '../core/history';
import { dictate, h } from './bridge';

const ICON = { copy: '⧉', pin: '●', unpin: '○', del: '×', search: '⌕', mic: '●' };

const root = document.getElementById('root')!;
const query = h('span.query');
const placeholder = h('span.placeholder', {}, 'Type to search');
const caret = h('span.caret');
const search = h('div.search', {}, h('span.icon', {}, ICON.search), query, caret, placeholder);
const list = h('div.list', { role: 'listbox' });
const footer = h('div.footer', {}, h('span', {}, 'Enter paste'), h('span', {}, 'Shift+Enter paste raw'), h('span', {}, 'Tab show raw'), h('span', {}, 'Esc close'));
const panel = h('div.panel', {}, h('div.header', {}, h('div.title', {}, 'Dictation history'), search), list, footer);
root.append(panel);

let items: HistoryEntry[] = [];
let hotkey = 'the dictation key';
let shown: HistoryEntry[] = [];
let selected = 0;
let q = '';
let localKeys = false;
let now = Date.now();
const rawOpen = new Set<string>();

function choose(e: HistoryEntry, raw = false, copyOnly = false): void {
  dictate.send('dictate:picker-choose', { id: e.id, raw, copyOnly });
}

function iconButton(glyph: string, title: string, onClick: () => void, cls = ''): HTMLButtonElement {
  return h(`button.act${cls ? `.${cls}` : ''}` as 'button', {
    title,
    'aria-label': title,
    onclick: (ev: MouseEvent) => {
      ev.stopPropagation();
      onClick();
    },
  }, glyph);
}

function card(e: HistoryEntry, i: number): HTMLElement {
  const showRaw = rawOpen.has(e.id);
  const differs = e.raw.trim() !== e.text.trim();
  const el = h(
    'div.card',
    {
      role: 'option',
      'aria-selected': String(i === selected),
      onclick: () => choose(e),
      onmouseenter: () => {
        selected = i;
        mark();
      },
    },
    h('div.text', {}, e.text),
    showRaw ? h('div.raw', {}, h('span.rawlabel', {}, 'Heard'), e.raw, h('button.pasteraw', { onclick: (ev: MouseEvent) => {
            ev.stopPropagation();
            choose(e, true);
          },
        }, 'Paste raw')) : null,
    h(
      'div.meta',
      {},
      e.pinned ? h('span.pinned', { title: 'Pinned' }, ICON.pin) : null,
      h('span', {}, relativeTime(e.at, now)),
      differs
        ? h(
            'button.rawtoggle',
            {
              onclick: (ev: MouseEvent) => {
                ev.stopPropagation();
                toggleRaw(e.id);
              },
            },
            showRaw ? 'Hide raw' : 'Show raw',
          )
        : null,
    ),
    h(
      'div.actions',
      {},
      iconButton(ICON.copy, 'Copy (don’t paste)', () => choose(e, showRaw, true)),
      iconButton(e.pinned ? ICON.unpin : ICON.pin, e.pinned ? 'Unpin' : 'Pin', () => dictate.send('dictate:picker-pin', { id: e.id, pinned: !e.pinned })),
      iconButton(ICON.del, 'Delete', () => dictate.send('dictate:picker-delete', { id: e.id }), 'danger'),
    ),
  );
  el.classList.toggle('selected', i === selected);
  return el;
}

function toggleRaw(id: string): void {
  if (rawOpen.has(id)) rawOpen.delete(id);
  else rawOpen.add(id);
  render();
}

function render(): void {
  shown = new HistoryStore(items, Number.MAX_SAFE_INTEGER).filter(q);
  selected = Math.max(0, Math.min(selected, shown.length - 1));
  query.textContent = q;
  placeholder.hidden = !!q;
  list.replaceChildren(
    ...(shown.length
      ? shown.map(card)
      : [h('div.empty', {}, h('div.emptyicon', {}, ICON.mic), items.length ? `Nothing matches “${q}”` : 'No dictations yet', items.length ? null : h('div.emptyhint', {}, `Hold ${hotkey} and speak; what you say appears here.`))]),
  );
  mark();
}

function mark(): void {
  list.querySelectorAll('.card').forEach((c, i) => {
    c.classList.toggle('selected', i === selected);
    c.setAttribute('aria-selected', String(i === selected));
  });
  list.querySelectorAll('.card')[selected]?.scrollIntoView({ block: 'nearest' });
}

const CHARS: Record<number, string> = { 32: ' ', 189: '-', 190: '.', 188: ',', 222: "'", 191: '/' };

function onPickerKey(k: { vk: number; shift: boolean }): void {
  const cur = shown[selected];
  switch (k.vk) {
    case 0x1b:
      dictate.send('dictate:picker-close');
      return;
    case 0x0d:
      if (cur) choose(cur, k.shift);
      return;
    case 0x09:
      if (cur) toggleRaw(cur.id);
      return;
    case 0x26:
      selected = Math.max(0, selected - 1);
      return void mark();
    case 0x28:
      selected = Math.min(shown.length - 1, selected + 1);
      return void mark();
    case 0x21:
      selected = Math.max(0, selected - 4);
      return void mark();
    case 0x22:
      selected = Math.min(shown.length - 1, selected + 4);
      return void mark();
    case 0x24:
      selected = 0;
      return void mark();
    case 0x23:
      selected = shown.length - 1;
      return void mark();
    case 0x08:
      q = q.slice(0, -1);
      selected = 0;
      return void render();
  }
  let ch = '';
  if ((k.vk >= 0x41 && k.vk <= 0x5a) || (k.vk >= 0x30 && k.vk <= 0x39)) ch = String.fromCharCode(k.vk).toLowerCase();
  else ch = CHARS[k.vk] ?? '';
  if (ch && !(ch === ' ' && !q)) {
    q += ch;
    selected = 0;
    render();
  }
}

dictate.on('dictate:picker-key', onPickerKey);
const LOCAL_KEYS: Record<string, number> = { Escape: 0x1b, Enter: 0x0d, Tab: 0x09, ArrowUp: 0x26, ArrowDown: 0x28, PageUp: 0x21, PageDown: 0x22, Home: 0x24, End: 0x23, Backspace: 0x08 };
document.addEventListener('keydown', (e) => {
  if (!localKeys) return;
  if (LOCAL_KEYS[e.key]) { e.preventDefault(); onPickerKey({ vk: LOCAL_KEYS[e.key], shift: e.shiftKey }); }
  else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !(e.key === ' ' && !q)) {
    e.preventDefault(); q += e.key; selected = 0; render();
  }
});

dictate.on('dictate:picker-open', (a: { items: HistoryEntry[]; now: number; hotkey: string; localKeys?: boolean }) => {
  items = a.items;
  hotkey = a.hotkey;
  now = a.now;
  localKeys = !!a.localKeys;
  q = '';
  selected = 0;
  rawOpen.clear();
  render();
  list.scrollTop = 0;
  root.classList.remove('visible');
  requestAnimationFrame(() => root.classList.add('visible'));
});

dictate.on('dictate:picker-items', (next: HistoryEntry[]) => {
  items = next;
  render();
});

dictate.on('dictate:picker-close', () => root.classList.remove('visible'));

// Listeners are registered: main may now open the picker.
dictate.send('dictate:picker-ready');
