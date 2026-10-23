// L1 · Decision sheets and approval cards: the decide and approve tools (src/core/tools/decide.ts, approve.ts), their
// cards on the pill, the person's answers by click, key or one spoken sentence (src/core/decidematch.ts), and the
// sheet: every question laid out once the person expands a card (remembered until Shrink), or the wide comparison
// when an agent sends previews. Both wait like ask: the card is held while the person dictates, ✕ or the time running
// out ends the wait, and every result carries card_id.
import { screen, shell } from 'electron';
import type { HubSession } from '../../core/agenthub';
import type { Card } from '../../core/cards';
import { type AnswerOut, answeredCount, answersOut, applyVoice, complete, type DecideData, newDecide, pick, type Via } from '../../core/decidecard';
import { isApproval } from '../../core/decidematch';
import { SHEET_SIZES } from '../../core/sheetkinds';
import { type ApproveArgs, parseApprove } from '../../core/tools/approve';
import { parseDecide } from '../../core/tools/decide';
import { PILL_STATUS_H, placeSheet, SHEET_MARGIN } from '../windows';
import type { Feature, FeatureHost, ReplyTarget } from './host';

type DecideResult = { answered: true; via: Via; answers: AnswerOut[]; raw?: string } | { answered: false; reason: string };
type ApproveResult = { approved: true } | { approved: false; changes: string; raw: string } | { answered: false; reason: string };

interface Live {
  kind: 'decide' | 'approve';
  session: string;
  /** decide: the questions and answers so far. */
  data?: DecideData;
  /** approve: the plan as the agent sent it. */
  plan?: ApproveArgs;
  /** "Other… (hold to say)" was clicked for this question: the next sentence answers it in their own words. */
  otherFor?: number;
}

const tab = (c: Card) => c.source.split(' · ').pop() || 'the agent';
const isIndex = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0;
const isVia = (x: unknown): x is Via => x === 'click' || x === 'keys' || x === 'voice';

class Decisions {
  private live = new Map<string, Live>();
  /** The card whose sheet is open. */
  private sheetCard: string | null = null;
  /** Cards whose sheet the person closed: they stay compact on the pill. */
  private compact = new Set<string>();

  constructor(private host: FeatureHost) {
    const { hub } = host;
    hub.handle('decide', (session, args, signal) => this.decide(session, args, signal));
    hub.handle('approve', (session, args, signal) => this.approve(session, args, signal));
    hub.cardKind('decide', {
      reply: async (card, text, raw) => this.sayDecide(card, text, raw),
      action: async (card, name, value) => this.actDecide(card, name, value),
    });
    hub.cardKind('approve', {
      reply: async (card, text, raw) => this.sayApprove(card, text, raw),
      action: async (card, name) => this.actApprove(card, name),
    });
    hub.onEnded((id) => { if (hub.queue.get(id)?.requestOwned || this.live.has(id)) this.ended(id); });
    host.replyTarget(() => this.replyTarget());
    host.agents.coverTop((top) => this.followTop(top));
    host.sheet.onClosed((kind, why) => {
      if (kind !== 'decide') return;
      if (why === 'esc' && this.sheetCard) this.compact.add(this.sheetCard);
      this.sheetCard = null;
      // Closed by the person or by another surface: the card shows on the pill again. ('closed' comes from this
      // feature, which redraws itself.)
      if (why !== 'closed') this.host.agents.render();
    });
    host.ipc.handle('shrink', () => this.shrink());
    host.ipc.handle('fit', (height) => {
      if (typeof height === 'number' && Number.isFinite(height) && this.sheetCard) this.fit(height);
    });
    host.ipc.handle('pick', (id, q, label, via) => {
      if (typeof id !== 'string' || !isIndex(q) || typeof label !== 'string') return false;
      return this.pick(id, q, label, isVia(via) ? via : 'click');
    });
    host.ipc.handle('send', (id, via) => (typeof id === 'string' ? this.send(id, isVia(via) ? via : 'click') : { ok: false, message: 'That card is gone' }));
    host.ipc.handle('other', (id, q) => {
      const l = typeof id === 'string' ? this.live.get(id) : undefined;
      if (!l?.data || !isIndex(q) || !l.data.questions[q]?.other) return false;
      l.otherFor = q;
      host.agents.armed = id as string;
      return true;
    });
    host.qa((line) => void this.qa(line));
  }

  // ---------- the tools ----------

  private async decide(session: HubSession, args: unknown, signal: AbortSignal) {
    const a = parseDecide(args);
    const { hub } = this.host;
    if (hub.queue.paused) return { answered: false, reason: 'dnd' };
    if (this.busy(session.id, 'decide')) return { answered: false, reason: 'busy' };
    const src = await hub.source(session);
    if (signal.aborted) return { answered: false, reason: 'cancelled' };
    const id = hub.newId();
    const live: Live = { kind: 'decide', session: session.id, data: newDecide(a.questions, a.previews) };
    this.live.set(id, live);
    const answer = hub.wait<DecideResult>(id, { session: session.id, kind: 'decide', timeoutMs: a.timeoutS * 1000, signal });
    hub.raise({
      id,
      key: `decide:${id}`,
      origin: 'agent',
      kind: 'decide',
      urgency: 'needs_you',
      source: src.line,
      sourceDetail: src.detail,
      title: a.title,
      message: a.message,
      action: 'choose',
      choices: [],
      target: src.target,
      createdAt: Date.now(),
      data: live.data,
    });
    const r = await answer;
    const data = live.data!;
    this.ended(id);
    const extra = { card_id: id, ...(a.truncated ? { truncated: true } : {}) };
    // An unanswered sheet never answers itself: what was filled comes back as partial.
    if (!r.answered) return { ...r, ...(answeredCount(data) ? { partial: answersOut(data, true) } : {}), ...extra };
    return { ...r, ...extra };
  }

  private async approve(session: HubSession, args: unknown, signal: AbortSignal) {
    const a = parseApprove(args);
    const { hub } = this.host;
    if (hub.queue.paused) return { answered: false, reason: 'dnd' };
    if (this.busy(session.id, 'approve')) return { answered: false, reason: 'busy' };
    const src = await hub.source(session);
    if (signal.aborted) return { answered: false, reason: 'cancelled' };
    const id = hub.newId();
    this.live.set(id, { kind: 'approve', session: session.id, plan: a });
    const answer = hub.wait<ApproveResult>(id, { session: session.id, kind: 'approve', timeoutMs: a.timeoutS * 1000, signal });
    hub.raise({
      id,
      key: `approve:${id}`,
      origin: 'agent',
      kind: 'approve',
      urgency: 'needs_you',
      source: src.line,
      sourceDetail: src.detail,
      title: a.title,
      message: '',
      action: 'approve',
      choices: [],
      link: a.link,
      target: src.target,
      createdAt: Date.now(),
      data: { summary: a.summary, risk: a.risk, link: a.link?.host ?? null },
    });
    const r = await answer;
    this.ended(id);
    return { ...r, card_id: id, ...(a.truncated ? { truncated: true } : {}) };
  }

  private busy(session: string, kind: Live['kind']): boolean {
    return [...this.live.entries()].some(([id, l]) => l.session === session && l.kind === kind && this.host.hub.waiting(id));
  }

  private ended(id: string): void {
    this.live.delete(id);
    this.compact.delete(id);
    if (this.sheetCard === id) this.host.sheet.close('closed');
  }

  // ---------- the person ----------

  /** New answers: the card and, when it is open for this card, the sheet. */
  private changed(id: string, data: DecideData): void {
    const l = this.live.get(id);
    if (!l) return;
    l.data = data;
    const card = this.host.hub.queue.get(id);
    if (card) card.data = data;
    this.host.agents.render();
    if (this.sheetCard === id) this.host.sheet.update(this.sheetPayload(id));
  }

  private pick(id: string, q: number, label: string, via: Via): boolean {
    const l = this.live.get(id);
    if (!l?.data || !this.host.hub.waiting(id)) return false;
    const next = pick(l.data, q, label, via);
    if (next === l.data) return false;
    this.changed(id, next);
    return true;
  }

  /** Send: every question's answer goes back (an unanswered one with nothing picked); at least one must be answered. */
  private send(id: string, via: Via): { ok: boolean; message: string } {
    const l = this.live.get(id);
    const card = this.host.hub.queue.get(id);
    if (!l?.data || !card) return { ok: false, message: 'That card is gone' };
    if (!answeredCount(l.data)) return { ok: false, message: 'Pick an answer first' };
    this.host.hub.settle(id, { answered: true, via, answers: answersOut(l.data), ...(l.data.raw ? { raw: l.data.raw } : {}) });
    return { ok: true, message: `Answered ${tab(card)}` };
  }

  private async actDecide(card: Card, name: string, value: unknown) {
    if (name === 'pick') {
      const v = (value ?? {}) as { q?: unknown; label?: unknown };
      if (isIndex(v.q) && typeof v.label === 'string') this.pick(card.id, v.q, v.label, 'click');
      return undefined;
    }
    if (name === 'send') return this.send(card.id, 'click');
    if (name === 'expand') {
      // Remembered: later decision cards open expanded too, until Shrink. A card with previews always opens its
      // comparison, so there Expand only reopens it.
      if (!this.live.get(card.id)?.data?.previews) this.host.update({ decide: { expanded: true } });
      this.compact.delete(card.id);
      this.openSheet(card.id, true);
      this.host.agents.render();
      return undefined;
    }
    return undefined;
  }

  /** One sentence over the card: it fills what it can; once every question has an answer, the answers go. */
  private async sayDecide(card: Card, text: string, raw: string) {
    const l = this.live.get(card.id);
    if (!l?.data) return { ok: false, message: 'That card is gone' };
    const { data, match } = applyVoice(l.data, text, raw, Date.now(), l.otherFor);
    l.otherFor = undefined;
    this.changed(card.id, data);
    const filled = match.fills.length + (match.other ? 1 : 0);
    // ok even when nothing matched: the card stays, and the words are not sent into the Pane tab instead.
    if (!filled) return { ok: true, message: 'No option matched · say one or click' };
    if (complete(data)) {
      this.host.hub.settle(card.id, { answered: true, via: 'voice', answers: answersOut(data), raw });
      return { ok: true, message: `Answered ${tab(card)}` };
    }
    const n = data.questions.length;
    return { ok: true, message: `${answeredCount(data)} of ${n} answered` };
  }

  private async sayApprove(card: Card, text: string, raw: string) {
    const l = this.live.get(card.id);
    if (!l?.plan) return { ok: false, message: 'That card is gone' };
    if (isApproval(text) || isApproval(raw)) {
      if (l.plan.risk === 'high') return { ok: true, message: 'High risk · only a click approves' };
      this.host.hub.settle(card.id, { approved: true });
      return { ok: true, message: `Approved · ${tab(card)}` };
    }
    this.host.hub.settle(card.id, { approved: false, changes: text, raw });
    return { ok: true, message: `Change sent to ${tab(card)}` };
  }

  private async actApprove(card: Card, name: string) {
    const l = this.live.get(card.id);
    if (!l?.plan) return undefined;
    if (name === 'approve') {
      this.host.hub.settle(card.id, { approved: true });
      return { ok: true, message: `Approved · ${tab(card)}` };
    }
    if (name === 'plan') {
      // The whole plan: its link, else the agent's Pane tab. The card stays up.
      if (l.plan.link) void shell.openExternal(l.plan.link.url);
      else if (card.target) {
        const ok = await this.host.agents.pane.open(card.target.paneId, card.target.panelId);
        if (!ok) return { ok: false, message: "Couldn't open Pane" };
      }
    }
    return undefined;
  }

  /**
   * Which of this lane's cards a dictation answers: one whose "Hold to answer" was clicked, the card whose wide sheet
   * is under the pointer, or the top card under the pointer (whether or not it has a Pane tab).
   */
  private replyTarget(): ReplyTarget | null {
    const { hub, agents } = this.host;
    const target = (id: string): ReplyTarget | null => {
      const c = hub.queue.get(id);
      return c && this.live.has(id) ? { cardId: id, to: tab(c) } : null;
    };
    const armed = agents.armed;
    if (armed && this.live.has(armed)) {
      agents.armed = null;
      return target(armed);
    }
    if (this.sheetCard && this.pointerOverSheet()) return target(this.sheetCard);
    const top = hub.queue.view(Date.now()).top;
    if (top && this.live.has(top.id) && this.host.pill.pointerOverCard()) return target(top.id);
    return null;
  }

  // ---------- the sheet ----------

  /**
   * On every redraw of the pill: the sheet follows the top card. It opens, without focus, for a decision card with
   * previews or once the person has chosen expanded (unless they closed it for this card), and closes when another
   * card takes the top. True while it shows the top card, so the pill draws none.
   */
  private followTop(top: Card | null): boolean {
    const mine = top && this.live.get(top.id)?.data ? top.id : null;
    if (this.sheetCard && this.sheetCard !== mine) this.host.sheet.close('closed');
    const wants = mine && !this.compact.has(mine) && (this.host.settings().decide.expanded || this.live.get(mine)?.data?.previews);
    if (wants && !this.host.sheet.isOpen) this.openSheet(mine, false);
    return !!mine && this.sheetCard === mine;
  }

  /** Shrink: back to the compact card, and decision cards stay compact from now on (on a card with previews, only it). */
  private shrink(): void {
    if (!this.sheetCard) return;
    if (!this.live.get(this.sheetCard)?.data?.previews) this.host.update({ decide: { expanded: false } });
    this.compact.add(this.sheetCard);
    this.host.sheet.close('closed');
    this.host.agents.render();
  }

  /** The expanded page's own height, so every question shows without scrolling; at most what fits above the pill. */
  private fit(height: number): void {
    const w = this.host.sheet.window();
    const room = screen.getDisplayMatching(w.getBounds()).workArea.height - PILL_STATUS_H - 2 * SHEET_MARGIN;
    const h = Math.round(Math.min(Math.max(height, 200), room));
    if (Math.abs(w.getBounds().height - 2 * SHEET_MARGIN - h) > 2) placeSheet(w, { width: SHEET_SIZES.decide.width, height: h });
  }

  private openSheet(id: string, focus: boolean): void {
    if (!this.live.get(id)?.data) return;
    this.sheetCard = id;
    this.host.sheet.open('decide', this.sheetPayload(id), { focus });
  }

  private sheetPayload(id: string) {
    const card = this.host.hub.queue.get(id);
    const data = this.live.get(id)?.data;
    return { cardId: id, source: card?.source ?? '', client: card?.sourceDetail ?? '', title: card?.title ?? '', message: card?.message ?? '', ...data };
  }

  private pointerOverSheet(): boolean {
    if (this.host.sheet.kind !== 'decide') return false;
    const w = this.host.sheet.window();
    if (!w.isVisible()) return false;
    const p = screen.getCursorScreenPoint();
    const b = w.getBounds();
    return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
  }

  // ---------- QA ----------

  /**
   * `decide dump` logs the cards this lane is waiting on. `decide say <words>` answers the top one of them as a
   * dictation over it would: the 2 s preview, then its kind's reply. `decide key <key>` presses a key in the sheet,
   * `decide sheet-click <label>` clicks an option or button there.
   */
  private async qa(line: string): Promise<void> {
    const { log, hub, agents } = this.host;
    const [verb, ...rest] = line.split(' ');
    const arg = rest.join(' ');
    if (verb === 'dump') {
      const cards = [...this.live.entries()].map(([id, l]) => ({ id, kind: l.kind, data: l.data, plan: l.plan, otherFor: l.otherFor }));
      const w = this.host.sheet.window();
      const sheetScrolls = this.sheetCard ? await w.webContents.executeJavaScript(`[...document.querySelectorAll('.dlist, .dleftcol')].some((x) => x.scrollHeight > x.clientHeight + 1)`) : null;
      log('info', `QA decide ${JSON.stringify({ cards, sheetCard: this.sheetCard, sheetScrolls })}`);
    } else if (verb === 'say') {
      const top = hub.queue.view(Date.now()).top;
      if (!top || !this.live.has(top.id)) return log('info', 'QA decide-said {"ok":false,"message":"no card of this lane on top"}');
      agents.setDictating(true, top.id);
      const send = await this.host.preview(tab(top), arg);
      const r = send ? await agents.reply(top.id, arg, arg) : { ok: false, message: 'cancelled' };
      agents.setDictating(false);
      this.host.pill.send('dictate:pill', r.ok ? { kind: 'done', message: r.message } : { kind: 'info', message: 'Cancelled · nothing sent' });
      log('info', `QA decide-said ${JSON.stringify(r)}`);
    } else if (verb === 'click') {
      // A click on a card button by its label, scrolled into view first as the person would (a grown card scrolls).
      const pill = this.host.windows().find((w) => w.webContents.getURL().endsWith('pill.html'));
      // The card eases open: measure once its animations are done, or the click lands where the button was.
      const at = (await pill?.webContents.executeJavaScript(`(async () => {
        const finite = document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity);
        await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
        const b = [...document.querySelectorAll('.cards button')].find((x) => x.textContent === ${JSON.stringify(arg)});
        if (!b) return null;
        b.scrollIntoView({ block: 'nearest' });
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`)) as { x: number; y: number } | null | undefined;
      if (pill && at) {
        pill.webContents.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
        pill.webContents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
        pill.webContents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      }
      log('info', `QA decide-click ${JSON.stringify({ label: arg, at: at ?? null })}`);
    } else if (verb === 'sheet-click') {
      // A click in the sheet on an option tile or a button, by its label.
      const wc = this.host.sheet.window().webContents;
      const at = (await wc.executeJavaScript(`(() => {
        const label = ${JSON.stringify(arg)};
        const el = [...document.querySelectorAll('.dtile, button')].find((x) => (x.querySelector('.dlab > div') ?? x).textContent === label);
        const r = el?.getBoundingClientRect();
        return r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null;
      })()`)) as { x: number; y: number } | null;
      if (at) {
        wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
        wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      }
      log('info', `QA decide-sheet-click ${JSON.stringify({ label: arg, at })}`);
    } else if (verb === 'key') {
      const wc = this.host.sheet.window().webContents;
      wc.sendInputEvent({ type: 'keyDown', keyCode: arg });
      if (arg.length === 1) wc.sendInputEvent({ type: 'char', keyCode: arg });
      wc.sendInputEvent({ type: 'keyUp', keyCode: arg });
    } else if (verb === 'hover') {
      // A pointer over the sheet's option `arg` (0-based), as the person's mouse would.
      const at = (await this.host.sheet
        .window()
        .webContents.executeJavaScript(`(() => { const r = document.querySelectorAll('.dopt')[${Number(arg) || 0}]?.getBoundingClientRect(); return r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`)) as { x: number; y: number } | null;
      if (at) this.host.sheet.window().webContents.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
    } else log('warn', `QA decide: unknown command ${verb}`);
  }
}

export const decide: Feature = {
  name: 'decide',
  setup(host) {
    new Decisions(host);
  },
};
