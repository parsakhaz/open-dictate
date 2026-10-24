// L4 · Lineup: the lineup tool, its image loading and path checks, its card and its sheet page. An agent lines up two
// to six candidates; they arrive as a needs-you card with a strip of thumbnails, and Open lineup shows the grid in the
// sheet window (stars in order, keys, the lightbox). Clicks, keys or one spoken sentence answer it.
import { nativeImage, screen } from 'electron';
import type { Card } from '../../core/cards';
import { answerFor, type LineupAnswer, type LineupArgs, parseLineup } from '../../core/tools/lineup';
import { spokenPicks } from '../../core/tools/lineupvoice';
import type { Feature, FeatureHost } from './host';
import { dataUrl, imageRoots, loadImage } from './lineupimages';

/** What the card draws: no image data beyond a small thumbnail each. */
export interface LineupCardData {
  pick: LineupArgs['pick'];
  candidates: { label: string; thumb?: string; text?: string }[];
}

/** What the sheet page draws (src/renderer/sheet/lineup.ts). */
export interface LineupPayload {
  cardId: string;
  title: string;
  message: string;
  source: string;
  pick: LineupArgs['pick'];
  max: number;
  candidates: { label: string; caption: string; image?: string; text?: string }[];
}

interface Open {
  args: LineupArgs;
  payload: LineupPayload;
}

const THUMB_H = 96;

/** A small PNG of the image for the card (PNG and JPEG; the others show their number and label). */
function thumbnail(bytes: Buffer): string | undefined {
  const img = nativeImage.createFromBuffer(bytes);
  if (img.isEmpty()) return undefined;
  const { height } = img.getSize();
  return (height > THUMB_H ? img.resize({ height: THUMB_H, quality: 'good' }) : img).toPNG().toString('base64');
}

/** The grid's size: as in the mockup, within the screen the pill is on. */
function sheetSize(): { width: number; height: number } {
  const a = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  return { width: Math.min(960, a.width - 80), height: Math.min(640, a.height - 140) };
}

function setup(host: FeatureHost): void {
  const { hub, sheet } = host;
  const open = new Map<string, Open>();
  /** The card whose lineup is in the sheet right now. */
  let shown: string | null = null;

  const showSheet = (cardId: string) => {
    const o = open.get(cardId);
    if (!o) return;
    shown = cardId;
    sheet.open('lineup', o.payload, { focus: true, size: sheetSize() });
  };

  const closeSheet = (cardId: string) => {
    if (shown !== cardId) return;
    shown = null;
    if (sheet.kind === 'lineup') sheet.close('closed');
  };
  hub.onEnded((id) => { closeSheet(id); open.delete(id); });

  sheet.onClosed((kind) => {
    if (kind === 'lineup') shown = null;
  });

  const answer = (cardId: string, picks: number[], extra: { comment?: string; raw?: string } = {}) => {
    const o = open.get(cardId);
    if (!o) return false;
    closeSheet(cardId);
    return hub.settle(cardId, answerFor(o.args, picks, extra));
  };

  hub.handle('lineup', async (session, raw, signal) => {
    const args = parseLineup(raw);
    const roots = imageRoots(session.cwd);
    const cardData: LineupCardData = { pick: args.pick, candidates: [] };
    const candidates: LineupPayload['candidates'] = [];
    args.candidates.forEach((c, i) => {
      if (c.image !== undefined) {
        const img = loadImage(c.image, session.cwd, i + 1, roots);
        cardData.candidates.push({ label: c.label, thumb: thumbnail(img.bytes) });
        candidates.push({ label: c.label, caption: c.caption, image: dataUrl(img) });
      } else {
        cardData.candidates.push({ label: c.label, text: c.text?.slice(0, 80) });
        candidates.push({ label: c.label, caption: c.caption, text: c.text });
      }
    });
    const src = await hub.source(session);
    if (signal.aborted) return { answered: false, reason: 'cancelled' };
    const id = hub.newId();
    open.set(id, { args, payload: { cardId: id, title: args.title, message: args.message, source: src.line, pick: args.pick, max: args.max, candidates } });
    const waiting = hub.wait<LineupAnswer>(id, { session: session.id, kind: 'lineup', timeoutMs: args.timeoutS * 1000, signal });
    const { card_id } = hub.raise({
      id,
      key: `lineup:${id}`,
      origin: 'agent',
      kind: 'lineup',
      urgency: 'needs_you',
      source: src.line,
      sourceName: src.name,
      sourceDetail: src.detail,
      title: args.title,
      message: args.message,
      choices: [],
      data: cardData,
      target: src.target,
      createdAt: Date.now(),
    });
    host.log('info', `lineup: ${args.candidates.length} candidates (${args.pick}) on card ${id}`);
    try {
      const r = await waiting;
      return { ...r, card_id, ...(args.truncated ? { truncated: true } : {}) };
    } finally {
      closeSheet(id);
      open.delete(id);
    }
  });

  /** The person's words over the lineup or its card: picks in the order said, the rest as a comment. */
  const reply = async (card: Card, text: string, raw: string) => {
    const o = open.get(card.id);
    if (!o) return { ok: false, message: 'That lineup is gone' };
    const labels = o.args.candidates.map((c) => c.label);
    const heard = spokenPicks(text, labels);
    const s = heard.picks.length || heard.none ? heard : spokenPicks(raw, labels);
    if (!s.picks.length && !s.none) return { ok: false, message: 'Say the numbers, like “two and four”' };
    answer(card.id, s.picks, { comment: s.comment || undefined, raw });
    const n = Math.min(s.picks.length, o.args.max);
    return { ok: true, message: s.none ? 'Sent: none of these' : `Sent ${n} pick${n === 1 ? '' : 's'}` };
  };

  hub.cardKind('lineup', {
    reply,
    async action(card, name) {
      if (name === 'open') showSheet(card.id);
      else if (name === 'none') answer(card.id, []);
      return undefined;
    },
  });

  // The words answer the lineup when the key goes down with the pointer over its sheet, or over its card.
  host.replyTarget(() => {
    if (shown && sheet.kind === 'lineup' && open.has(shown)) {
      const b = sheet.window().getBounds();
      const p = screen.getCursorScreenPoint();
      if (p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height) return { cardId: shown, to: 'the lineup' };
    }
    const top = hub.queue.view(Date.now()).top;
    if (top?.kind === 'lineup' && open.has(top.id) && host.pill.pointerOverCard()) return { cardId: top.id, to: 'the lineup' };
    return null;
  });

  // The page: Send (the picks, as candidate indexes in order) and None of these.
  host.ipc.handle('send', (cardId, picks) => typeof cardId === 'string' && Array.isArray(picks) && answer(cardId, picks.filter((p): p is number => typeof p === 'number')));
  host.ipc.handle('none', (cardId) => typeof cardId === 'string' && answer(cardId, []));

  // QA: keys and clicks into the sheet page, its state, and a spoken answer without the speech model.
  host.qa((line) => {
    const [verb, ...rest] = line.split(' ');
    const arg = rest.join(' ');
    const page = () => sheet.window().webContents;
    const top = () => [...open.keys()].find((id) => hub.queue.get(id)) ?? null;
    if (verb === 'key') {
      void page().executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(arg)}, bubbles: true, cancelable: true }))`);
    } else if (verb === 'click') {
      void page()
        .executeJavaScript(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || x.textContent || '').trim() === ${JSON.stringify(arg)}); if (b) b.click(); return !!b; })()`)
        .then((ok) => host.log('info', `QA lineup click ${JSON.stringify({ label: arg, ok })}`));
    } else if (verb === 'dump') {
      void page()
        .executeJavaScript(
          `(() => { const r = document.querySelector('.lu'); return { open: !!r, mode: r?.dataset.mode ?? null, index: Number(r?.dataset.index ?? -1), picks: r ? JSON.parse(r.dataset.picks || '[]') : [], ranks: [...document.querySelectorAll('.lu-cell .lu-rank')].map((x) => x.textContent), send: document.querySelector('.lu-send')?.textContent ?? null, images: [...document.querySelectorAll('.lu img')].map((i) => ({ type: (i.getAttribute('src') || '').slice(5, 18), loaded: i.complete && i.naturalWidth > 0 })), title: document.title, pwned: document.body.dataset.pwned ?? null, text: r?.innerText ?? '' }; })()`,
        )
        .then((s) => host.log('info', `QA lineup ${JSON.stringify(s)}`));
    } else if (verb === 'card') {
      const pill = host.windows().find((w) => !w.isDestroyed() && w.webContents.getURL().endsWith('pill.html'));
      void (pill ? pill.webContents.executeJavaScript(`[...document.querySelectorAll('.lu-tile')].map((t) => ({ drawn: !!t.querySelector('canvas'), label: t.querySelector('.lu-l')?.textContent ?? null }))`) : Promise.resolve(null)).then((tiles) =>
        host.log('info', `QA lineup card ${JSON.stringify({ tiles })}`),
      );
    } else if (verb === 'say') {
      const id = shown ?? top();
      const card = id ? hub.queue.get(id) : undefined;
      void (card ? reply(card, arg, arg) : Promise.resolve({ ok: false, message: 'no lineup' })).then((r) => host.log('info', `QA lineup say ${JSON.stringify(r)}`));
    } else if (verb === 'open') {
      const id = top();
      if (id) showSheet(id);
    }
  });
}

export const lineup: Feature = {
  name: 'lineup',
  setup,
};
