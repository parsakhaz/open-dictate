// The decision card in the sheet (L1), in one of two layouts. Expanded: every question stacked with its options as
// tiles, sized to fit them all; a click, a number key or voice answers, ↑ ↓ (or ← → and Tab) move between questions.
// With previews: question tabs, options on the left, the hovered option's preview on the right; hovering (or ↑ ↓)
// only changes the preview, a click, a number key, Space or voice changes the answer, ← → and Tab move between
// questions. Enter sends in both; Shrink goes back to the compact card for good. Main holds the answers: each pick
// goes to it, and it sends the sheet back. Every word, preview included, is a text node; never HTML.
import type { DecideData } from '../../core/decidecard';
import { answeredCount, complete, isAnswered } from '../../core/decidecard';
import { CAPS } from '../../core/agenttools';
import { fitPlain } from '../../core/cardtext';
import type { Preview } from '../../core/tools/decide';
import { dictate, h } from '../bridge';
import type { SheetPage } from './types';

type Payload = DecideData & { cardId: string; source: string; client: string; title: string; message: string };

const isPayload = (x: unknown): x is Payload => !!x && typeof x === 'object' && typeof (x as Payload).cardId === 'string' && Array.isArray((x as Payload).questions);

let root: HTMLElement | null = null;
let p: Payload | null = null;
/** The question on screen, the option hovered (or moved to with ↑ ↓), and a note in the foot. */
let cur = 0;
let hover: number | null = null;
let note = '';
/** The expanded layout's height last asked of main. */
let fitted = 0;

/** A sheet that opened by itself has no keyboard focus, so its keys reach the app in front until it is clicked. */
const NO_KEYS = 'Click to use keys';
addEventListener('focus', () => draw());
addEventListener('blur', () => draw());

/** How long tiles a sentence filled stay lit, as on the card. */
const FLASH_MS = 700;

const invoke = <T>(name: string, ...args: unknown[]) => dictate.invoke<T>(`dictate:decide:${name}`, ...args);

async function choose(q: number, label: string, via: 'click' | 'keys'): Promise<void> {
  if (!p) return;
  const id = p.cardId;
  const ok = await invoke<boolean>('pick', id, q, label, via);
  // A single answer moves on to the next question still open.
  if (ok && p?.cardId === id && !p.questions[q].multi) {
    const next = p.questions.findIndex((_, i) => i > q && !isAnswered(p!.answers[i]));
    if (next >= 0) {
      cur = next;
      hover = null;
    }
  }
  draw();
}

async function send(via: 'click' | 'keys'): Promise<void> {
  if (!p) return;
  const r = await invoke<{ ok: boolean; message: string }>('send', p.cardId, via);
  if (!r.ok) {
    note = r.message;
    draw();
  }
}

/** "Other… (hold to say)": the next sentence over this card answers question `q` in their own words. */
async function armOther(id: string, q: number): Promise<void> {
  if (await invoke<boolean>('other', id, q)) note = 'Hold your key and say it';
  draw();
}

function go(q: number): void {
  if (!p) return;
  cur = (q + p.questions.length) % p.questions.length;
  hover = null;
  draw();
}

/** The preview shown: the hovered option's, else the picked one's, else the first with one. */
function shownPreview(): { n: number; label: string; preview: Preview } | null {
  if (!p) return null;
  const q = p.questions[cur];
  const picked = q.options.findIndex((o) => p!.answers[cur].picked.includes(o.label));
  const order = [hover, picked, ...q.options.map((_, i) => i)].filter((i): i is number => i !== null && i >= 0);
  const i = order.find((x) => q.options[x]?.preview);
  return i === undefined ? null : { n: i + 1, label: q.options[i].label, preview: q.options[i].preview! };
}

function previewPane(): HTMLElement {
  const s = shownPreview();
  if (!s) return h('div.dright', {}, h('div.dpvh', {}, 'No preview for this question'));
  const lines = s.preview.content.split('\n');
  const code = s.preview.kind === 'code';
  const added = code ? lines.filter((l) => l.startsWith('+')).length : 0;
  const removed = code ? lines.filter((l) => l.startsWith('-')).length : 0;
  return h(
    'div.dright',
    {},
    h('div.dpvh', {}, h('b', {}, `${s.n} · ${s.label}`), added || removed ? h('span.dtag.dstat', {}, `+${added} −${removed}`) : null),
    h(
      `div.dpre${code ? '.code' : ''}`,
      {},
      ...lines.map((l) => {
        const kind = code && l.startsWith('+') ? '.a' : code && l.startsWith('-') ? '.d' : '';
        return h(`div${kind}`, {}, kind ? l.slice(1) : l || ' ');
      }),
    ),
  );
}

function head(d: Payload): HTMLElement {
  return h(
    'div.shead',
    {},
    h('span.src', {}, d.source),
    d.client ? h('span', {}, d.client) : null,
    h('button.dshrink', { title: 'Back to the small card, for this and later cards', onclick: () => void invoke('shrink') }, 'Shrink'),
    h('button.x', { title: 'Close (Esc)', onclick: () => dictate.send('dictate:sheet-esc') }, '✕'),
  );
}

/** Expanded: every question at once, its options as tiles with their descriptions. */
function drawStacked(d: Payload): void {
  const n = d.questions.length;
  const left = n - answeredCount(d);
  const flashing = new Set(d.flash && Date.now() - d.flash.at < FLASH_MS ? d.flash.qs : []);
  const questions = d.questions.map((q, i) => {
    const a = d.answers[i];
    const done = isAnswered(a);
    const tiles = q.options.map((o, k) => {
      const on = a.picked.includes(o.label);
      return h(
        `div.dtile${on ? '.sel' : ''}${on && flashing.has(i) ? '.flash' : ''}`,
        {
          onclick: (e: Event) => {
            e.stopPropagation();
            cur = i;
            void choose(i, o.label, 'click');
          },
        },
        h('kbd', {}, String(k + 1)),
        h('div.dlab', {}, h('div', {}, o.label), o.description ? h('div.ddesc', {}, o.description) : null),
      );
    });
    const other = q.other
      ? h(
          'div.dtile.dothertile',
          {
            onclick: (e: Event) => {
              e.stopPropagation();
              cur = i;
              void armOther(d.cardId, i);
            },
          },
          h('div.dlab', {}, h('div', {}, 'Other…'), h('div.ddesc', {}, 'Hold your key and say it')),
        )
      : null;
    return h(
      `div.dsq${i === cur ? '.on' : ''}`,
      { 'data-multi': String(q.multi), onclick: () => cur !== i && go(i) },
      h(
        'div.dsqh',
        {},
        h(`span.dhead${done ? '.done' : i === cur ? '.acc' : ''}`, {}, q.header),
        h('span.dsqt', {}, q.question),
        done && a.via === 'voice' ? h('span.dheard', {}, 'by voice') : null,
        done ? h('span.dok', { title: 'Answered' }, '✓') : q.multi ? h('span.dtag', {}, 'pick any') : null,
      ),
      h('div.dtiles', {}, ...tiles, other),
      a.other ? h('div.dother', {}, `Your words: “${a.other}”`) : null,
    );
  });
  const list = h('div.dlist', {}, ...questions);
  root!.replaceChildren(
    head(d),
    h(
      'div.dtitle.stack',
      {},
      h('span.ttl', {}, d.title),
      n > 1 ? h(`span.dtag${n - left ? '.acc' : ''}`, {}, `${n - left} of ${n} answered`) : null,
      d.message ? h('span.msg', {}, fitPlain(d.message, CAPS.message).text) : null,
    ),
    list,
    h(
      'div.sfoot',
      {},
      note
        ? h('span.dhint', {}, note)
        : !document.hasFocus()
          ? h('span.dhint', {}, NO_KEYS)
          : h('span.dhint', {}, h('kbd', {}, `1–${d.questions[cur].options.length}`), ' pick · ', h('kbd', {}, '↑'), h('kbd', {}, '↓'), ' question · ', h('kbd', {}, 'Enter'), ' send · or hold your key to say it'),
      h(`button.cbtn${complete(d) ? '.primary' : ''}`, { onclick: () => void send('click') }, left ? `Send answers · ${left} left` : 'Send answers'),
    ),
  );
  // Main sizes the sheet to everything here, so nothing scrolls unless the screen is too short.
  const natural = Math.ceil(root!.offsetHeight - list.clientHeight + list.scrollHeight);
  if (natural !== fitted) {
    fitted = natural;
    void invoke('fit', natural);
  }
}

function draw(): void {
  if (!root || !p) return;
  const d = p;
  cur = Math.min(cur, d.questions.length - 1);
  if (!d.previews) {
    drawStacked(d);
    return;
  }
  const q = d.questions[cur];
  const a = d.answers[cur];
  const anyPreview = q.options.some((o) => o.preview);
  const tabs = d.questions.map((x, i) => {
    const ans = d.answers[i];
    const done = isAnswered(ans);
    return h(
      `button.dtab${i === cur ? '.on' : ''}`,
      { onclick: () => go(i) },
      done ? h('span.dok', {}, '✓') : null,
      h(`span.dhead${done ? '.done' : i === cur ? '.acc' : ''}`, {}, x.header),
      h('span.dans', {}, ans.other ? `“${ans.other}”` : ans.picked.length ? ans.picked.join(', ') : 'not answered'),
    );
  });
  const opts = q.options.map((o, i) => {
    const on = a.picked.includes(o.label);
    return h(
      `div.dopt${on ? '.sel' : ''}${hover === i ? '.hov' : ''}`,
      {
        onmouseenter: () => {
          if (hover === i) return;
          hover = i;
          draw();
        },
        onclick: () => void choose(cur, o.label, 'click'),
      },
      h('kbd', {}, String(i + 1)),
      h('div.dlab', {}, h('div', {}, o.label), o.description ? h('div.ddesc', {}, o.description) : null),
      h(`span.${q.multi ? 'dbox' : 'drad'}`),
    );
  });
  const left = d.questions.length - answeredCount(d);
  root.replaceChildren(
    head(d),
    h('div.dtitle', {}, h('span.ttl', {}, d.title), d.message ? h('span.msg', {}, fitPlain(d.message, CAPS.message).text) : null),
    h('div.dtabs', {}, ...tabs),
    h(
      `div.dbody${anyPreview ? '' : '.narrow'}`,
      {},
      h('div.dleftcol', {}, h('div.dqt', {}, q.question), q.multi ? h('div.ddesc', {}, 'Pick any') : null, h('div.dopts', {}, ...opts), a.other ? h('div.dother', {}, `Your words: “${a.other}”`) : null),
      anyPreview ? previewPane() : null,
    ),
    h(
      'div.sfoot',
      {},
      q.other ? h('button.cbtn.armed', { onclick: () => void armOther(d.cardId, cur) }, 'Other… (hold to say)') : null,
      note
        ? h('span.dhint', {}, note)
        : !document.hasFocus()
          ? h('span.dhint', {}, NO_KEYS)
          : h('span.dhint', {}, h('kbd', {}, '↑'), h('kbd', {}, '↓'), ' compare · ', h('kbd', {}, `1–${q.options.length}`), ' pick · ', h('kbd', {}, '←'), h('kbd', {}, '→'), ' question'),
      h('button.cbtn', { onclick: () => go(cur + 1) }, 'Skip'),
      h(`button.cbtn${complete(d) ? '.primary' : ''}`, { onclick: () => void send('click') }, left ? `Send answers · ${left} left` : 'Send answers'),
    ),
  );
}

export const decide: SheetPage = {
  show(el, payload) {
    if (!isPayload(payload)) return;
    if (p?.cardId !== payload.cardId) {
      cur = Math.max(0, payload.answers.findIndex((x) => !isAnswered(x)));
      hover = null;
      note = '';
      fitted = 0;
    }
    root = el;
    p = payload;
    draw();
  },
  hide() {
    root = null;
    p = null;
    fitted = 0;
  },
  key(e) {
    if (!p) return false;
    const q = p.questions[cur];
    if (!p.previews && ['ArrowDown', 'ArrowUp'].includes(e.key)) {
      go(cur + (e.key === 'ArrowUp' ? -1 : 1));
      return true;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const n = q.options.length;
      hover = hover === null ? (e.key === 'ArrowDown' ? 0 : n - 1) : (hover + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      draw();
      return true;
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Tab') {
      go(cur + (e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1));
      return true;
    }
    if (/^[1-4]$/.test(e.key) && Number(e.key) <= q.options.length) {
      void choose(cur, q.options[Number(e.key) - 1].label, 'keys');
      return true;
    }
    if (e.key === ' ' && hover !== null) {
      void choose(cur, q.options[hover].label, 'keys');
      return true;
    }
    if (e.key === 'Enter') {
      void send('keys');
      return true;
    }
    return false;
  },
};
