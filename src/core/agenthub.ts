// What happens when an agent calls one of Dictate's tools, when Pane reports a tab, and when the person clicks a
// card: the rules between the tools, the card queue, consent and Pane. Everything outside (the pill, runpane,
// history, settings, time) comes in through HubDeps. Pure.
import { cleanMessage } from './agenttext';
import { CAPS, parseAsk, parseHistoryRequest, parseNotify, ToolInputError } from './agenttools';
import type { ClientInfo, PaneIds } from './agentwire';
import { type AddResult, type Card, type CardTarget, CardQueue } from './cards';
import type { HistoryStore } from './history';
import { type AccessOutcome, type AccessRecord, CONSENT_TIMEOUT_MS, consentSummary, GrantBook, HISTORY_NOTE, readHistory } from './historyaccess';
import { clientSourceLine, type PaneAction, paneSourceLine, WORDS } from './panewatch';
import type { VocabTerm } from './types';
import { checkProposals, type PendingTerm } from './vocabproposals';

/** One bridge connection: who is calling, from where. Never anything the agent typed. */
export interface HubSession {
  id: string;
  client: ClientInfo;
  pane: PaneIds | null;
  cwd: string;
}

export interface Source {
  line: string;
  detail?: string;
  /** The Pane tab to open and reply to, when the session is inside one Dictate could find. */
  target: CardTarget | null;
}

export interface TabInfo {
  paneName: string;
  panelTitle?: string;
  agentType?: string;
}

export interface HubDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** The queue changed: redraw the pill. */
  changed(): void;
  /** A card that needs the person just appeared. */
  chime(): void;
  log(level: 'info' | 'warn', msg: string): void;
  status(): { modelsReady: boolean; dictating: boolean };
  pane: {
    tab(paneId: string, panelId: string): Promise<TabInfo | null>;
    lastMessage(panelId: string): Promise<string | null>;
    /** Pane is the app in front: a "finished" card would only repeat what the person sees. */
    inFront(): boolean;
    send(panelId: string, text: string): Promise<{ delivered: boolean; blocked?: string }>;
  };
  history: { enabled(): boolean; store(): HistoryStore; record(rec: AccessRecord): void };
  vocab: { approved(): VocabTerm[]; pending(): PendingTerm[]; add(terms: PendingTerm[]): void };
}

export type AskResult = { answered: true; text: string; raw: string; choice?: string } | { answered: false; reason: 'timeout' | 'dismissed' | 'busy' | 'dnd' | 'not_running' | 'cancelled' };
export type ConsentAnswer = 'once' | 'session' | 'deny';

interface Waiter<T> {
  session: string;
  resolve(v: T): void;
  timer: unknown;
}

/** A spoken answer names one of the choices ("staging please" → Staging) when exactly one appears in it. */
export function matchChoice(text: string, choices: string[]): string | undefined {
  const said = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  const hits = choices.filter((c) => {
    const w = c.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    return w && said.includes(` ${w} `);
  });
  return hits.length === 1 ? hits[0] : undefined;
}

export class AgentHub {
  readonly queue = new CardQueue();
  readonly grants = new GrantBook();
  private next = 1;
  private asks = new Map<string, Waiter<AskResult>>();
  private consents = new Map<string, Waiter<ConsentAnswer | 'timeout' | 'dismissed'>>();

  constructor(private deps: HubDeps) {}

  // ---------- tools ----------

  async call(session: HubSession, tool: string, args: unknown, signal: AbortSignal): Promise<unknown> {
    switch (tool) {
      case 'status':
        return { running: true, ...this.deps.status(), doNotDisturb: this.queue.paused, historyAccess: this.deps.history.enabled() };
      case 'notify':
        return this.notify(session, args);
      case 'ask':
        return this.ask(session, args, signal);
      case 'propose_vocabulary':
        return this.propose(session, args);
      case 'list_vocabulary':
        return { terms: this.deps.vocab.approved(), pending: this.deps.vocab.pending().length };
      case 'read_history':
        return this.readHistory(session, args, signal);
      default:
        throw new ToolInputError(`Unknown tool: ${tool}`);
    }
  }

  /** Where a session really is: its Pane tab when Pane knows it, else its client and folder. */
  async source(session: HubSession): Promise<Source> {
    if (session.pane) {
      const tab = await this.deps.pane.tab(session.pane.sessionId, session.pane.panelId).catch(() => null);
      if (tab) return { line: paneSourceLine(tab.paneName, tab.panelTitle, tab.agentType), target: { paneId: session.pane.sessionId, panelId: session.pane.panelId } };
      return { line: `Pane tab · ${clientSourceLine(session.client, '')}`, target: null };
    }
    return { line: clientSourceLine(session.client, session.cwd), target: null };
  }

  private add(card: Card): AddResult {
    const r = this.queue.add(card, this.deps.now());
    this.queue.tick(this.deps.now());
    if (card.urgency !== 'info' && this.queue.view(this.deps.now()).top?.id === card.id) this.deps.chime();
    this.deps.changed();
    return r;
  }

  private id(): string {
    return `k${this.next++}`;
  }

  private async notify(session: HubSession, args: unknown) {
    const a = parseNotify(args);
    const src = await this.source(session);
    const status = this.add({
      id: this.id(),
      key: src.target ? `tab:${src.target.panelId}` : `session:${session.id}`,
      origin: 'agent',
      kind: 'notify',
      urgency: a.urgency,
      source: src.line,
      sourceDetail: src.detail,
      title: a.title,
      message: a.message,
      action: a.action,
      // Choices are sent to the tab, so they need one.
      choices: src.target ? a.choices : [],
      link: a.link,
      target: src.target,
      createdAt: this.deps.now(),
    });
    const id = this.queue.byKey(src.target ? `tab:${src.target.panelId}` : `session:${session.id}`)?.id;
    return { status, card_id: id, ...(a.truncated ? { truncated: true } : {}), ...(a.choices.length && !src.target ? { note: 'Choices need a Pane tab to send them to; they were not shown.' } : {}) };
  }

  private async ask(session: HubSession, args: unknown, signal: AbortSignal): Promise<AskResult & { truncated?: boolean }> {
    const a = parseAsk(args);
    if (this.queue.paused) return { answered: false, reason: 'dnd' };
    if ([...this.asks.values()].some((w) => w.session === session.id)) return { answered: false, reason: 'busy' };
    const src = await this.source(session);
    const id = this.id();
    return new Promise((resolve) => {
      const done = (r: AskResult) => {
        const w = this.asks.get(id);
        if (!w) return;
        this.deps.clearTimer(w.timer);
        this.asks.delete(id);
        if (this.queue.remove(id)) this.deps.changed();
        resolve(a.truncated ? { ...r, truncated: true } : r);
      };
      this.asks.set(id, { session: session.id, resolve: done, timer: this.deps.setTimer(() => done({ answered: false, reason: 'timeout' }), a.timeoutS * 1000) });
      signal.addEventListener('abort', () => done({ answered: false, reason: 'cancelled' }), { once: true });
      this.add({
        id,
        key: `ask:${id}`,
        origin: 'agent',
        kind: 'ask',
        urgency: 'needs_you',
        source: src.line,
        sourceDetail: src.detail,
        title: a.question,
        message: a.message,
        action: 'reply',
        choices: a.choices,
        target: src.target,
        createdAt: this.deps.now(),
      });
    });
  }

  private propose(session: HubSession, args: unknown) {
    const terms = (args && typeof args === 'object' ? (args as { terms?: unknown }).terms : undefined) ?? [];
    return this.source(session).then((src) => {
      const r = checkProposals(terms, this.deps.vocab.approved(), this.deps.vocab.pending(), src.line, new Date(this.deps.now()));
      if (r.accepted.length) {
        this.deps.vocab.add(r.accepted);
        const n = r.accepted.length;
        this.add({
          id: this.id(),
          key: `vocab:${session.id}`,
          origin: 'dictate',
          kind: 'vocab',
          urgency: 'info',
          source: src.line,
          title: `Suggests ${n} term${n === 1 ? '' : 's'} · Review`,
          message: r.accepted.map((t) => t.term).join(', ').slice(0, CAPS.message),
          choices: [],
          target: null,
          createdAt: this.deps.now(),
        });
      }
      return { queued: r.accepted.length, rejected: r.rejected, note: 'Nothing reaches the cleanup prompt until the person approves it in Dictate.' };
    });
  }

  private async readHistory(session: HubSession, args: unknown, signal: AbortSignal) {
    const a = parseHistoryRequest(args);
    const src = await this.source(session);
    const record = (outcome: AccessOutcome, count: number) =>
      this.deps.history.record({ at: new Date(this.deps.now()).toISOString(), source: src.line, client: session.client.name, query: a.query, hours: a.hours, limit: a.limit, includeRaw: a.includeRaw, outcome, count });
    if (!this.deps.history.enabled()) {
      record('off', 0);
      throw new ToolInputError('History access is off in Dictate');
    }
    let outcome: AccessOutcome;
    if (this.grants.allowed(session.id, this.deps.now())) outcome = 'session-grant';
    else if (this.queue.paused) outcome = 'dnd';
    else if ([...this.consents.values()].some((w) => w.session === session.id)) outcome = 'busy';
    else {
      const answer = await this.askConsent(session, src, a, signal);
      if (answer === 'session') this.grants.grant(session.id, { source: src.line, client: session.client.name }, this.deps.now());
      outcome = answer === 'once' ? 'allowed-once' : answer === 'session' ? 'allowed-session' : answer === 'timeout' ? 'timeout' : 'denied';
    }
    if (outcome !== 'allowed-once' && outcome !== 'allowed-session' && outcome !== 'session-grant') {
      record(outcome, 0);
      return { granted: false, reason: outcome };
    }
    const r = readHistory(this.deps.history.store(), a, this.deps.now());
    record(outcome, r.entries.length);
    return { granted: true, note: HISTORY_NOTE, entries: r.entries, ...(r.redacted ? { redacted: r.redacted } : {}), ...(a.clamped ? { clamped: true } : {}) };
  }

  private askConsent(session: HubSession, src: Source, a: ReturnType<typeof parseHistoryRequest>, signal: AbortSignal): Promise<ConsentAnswer | 'timeout' | 'dismissed'> {
    const id = this.id();
    const words = consentSummary(a, src.line);
    return new Promise((resolve) => {
      const done = (r: ConsentAnswer | 'timeout' | 'dismissed') => {
        const w = this.consents.get(id);
        if (!w) return;
        this.deps.clearTimer(w.timer);
        this.consents.delete(id);
        if (this.queue.remove(id)) this.deps.changed();
        resolve(r);
      };
      this.consents.set(id, { session: session.id, resolve: done, timer: this.deps.setTimer(() => done('timeout'), CONSENT_TIMEOUT_MS) });
      signal.addEventListener('abort', () => done('dismissed'), { once: true });
      this.add({
        id,
        key: `consent:${id}`,
        origin: 'dictate',
        kind: 'consent',
        urgency: 'consent',
        source: src.line,
        title: words.title,
        message: words.message,
        choices: [],
        target: null,
        createdAt: this.deps.now(),
      });
    });
  }

  /** The agent's connection closed: its session grant ends, and its questions are withdrawn. */
  sessionClosed(sessionId: string): void {
    this.grants.ended(sessionId);
    for (const w of [...this.asks.values()]) if (w.session === sessionId) w.resolve({ answered: false, reason: 'cancelled' });
    for (const w of [...this.consents.values()]) if (w.session === sessionId) w.resolve('dismissed');
    // The vocabulary review stays: the terms wait in Settings whether or not the agent is still connected.
    const c = this.queue.byKey(`session:${sessionId}`);
    if (c && c.urgency === 'info' && this.queue.remove(c.id)) this.deps.changed();
  }

  // ---------- the person, on the pill ----------

  dismiss(cardId: string): void {
    const ask = this.asks.get(cardId);
    const consent = this.consents.get(cardId);
    if (ask) ask.resolve({ answered: false, reason: 'dismissed' });
    else if (consent) consent.resolve('deny');
    else if (this.queue.remove(cardId)) this.deps.changed();
  }

  consent(cardId: string, answer: ConsentAnswer): void {
    this.consents.get(cardId)?.resolve(answer);
  }

  /** A click on a choice: the answer to an ask, or a reply typed into the card's tab. */
  async choose(cardId: string, choice: string): Promise<{ ok: boolean; message: string }> {
    const card = this.queue.get(cardId);
    if (!card?.choices.includes(choice)) return { ok: false, message: 'That card is gone' };
    if (this.asks.has(cardId)) {
      this.asks.get(cardId)!.resolve({ answered: true, text: choice, raw: choice, choice });
      return { ok: true, message: 'Answered' };
    }
    if (!card.target) return { ok: false, message: 'Nowhere to send it' };
    return this.replyToTab(card, choice);
  }

  /** The person's cleaned words for a card: the answer to an ask, or a reply sent into its Pane tab. */
  async reply(cardId: string, text: string, raw: string): Promise<{ ok: boolean; message: string }> {
    const card = this.queue.get(cardId);
    if (!card) return { ok: false, message: 'That card is gone' };
    if (this.asks.has(cardId)) {
      const choice = matchChoice(text, card.choices) ?? matchChoice(raw, card.choices);
      this.asks.get(cardId)!.resolve({ answered: true, text, raw, ...(choice ? { choice } : {}) });
      return { ok: true, message: `Answered ${card.source.split(' · ').pop()}` };
    }
    if (!card.target) return { ok: false, message: 'Nowhere to send it' };
    return this.replyToTab(card, text);
  }

  private async replyToTab(card: Card, text: string): Promise<{ ok: boolean; message: string }> {
    const tab = card.source.split(' · ').pop();
    const r = await this.deps.pane.send(card.target!.panelId, text);
    if (!r.delivered) {
      this.deps.log('warn', `agents: reply to a Pane tab was not delivered (${r.blocked ?? 'no reason'})`);
      return { ok: false, message: "Couldn't send · opened the tab" };
    }
    if (this.queue.remove(card.id)) this.deps.changed();
    return { ok: true, message: `Sent to ${tab}` };
  }

  setPaused(on: boolean): void {
    this.queue.setPaused(on);
    this.deps.changed();
  }

  /** `replyTo`: the card this dictation answers by voice, kept on the pill meanwhile. */
  setDictating(on: boolean, replyTo?: string): void {
    this.queue.setDictating(on, this.deps.now(), replyTo);
    this.deps.changed();
  }

  // ---------- Pane ----------

  async paneEvent(a: PaneAction): Promise<void> {
    if (!a) return;
    if (a.type === 'clear-pane') {
      let changed = false;
      for (const c of this.queue.view(0).all) if (c.target?.paneId === a.paneId && (c.origin === 'pane' || c.kind === 'pane-blocked') && this.queue.remove(c.id)) changed = true;
      if (changed) this.deps.changed();
      return;
    }
    const key = `tab:${a.panelId}`;
    const existing = this.queue.byKey(key);
    // The tab moved on (working again, or answered in Pane): its Pane card goes; the agent's own notes stay.
    if (existing && (existing.kind === 'pane-blocked' || existing.kind === 'pane-ready')) {
      this.queue.remove(existing.id);
      this.deps.changed();
    }
    if (a.type === 'clear') return;
    if (a.type === 'finished' && this.deps.pane.inFront()) return;
    const tab = await this.deps.pane.tab(a.paneId, a.panelId).catch(() => null);
    const message = a.message ?? cleanMessage(await this.deps.pane.lastMessage(a.panelId).catch(() => null), CAPS.message).text;
    const blocked = a.type === 'blocked';
    this.add({
      id: this.id(),
      key,
      origin: 'pane',
      kind: blocked ? 'pane-blocked' : 'pane-ready',
      urgency: blocked ? 'needs_you' : 'info',
      source: tab ? paneSourceLine(tab.paneName, tab.panelTitle, tab.agentType) : 'Pane tab',
      title: a.title ?? (blocked ? WORDS.blocked : WORDS.finished),
      message,
      action: blocked ? 'reply' : null,
      choices: [],
      target: { paneId: a.paneId, panelId: a.panelId },
      createdAt: this.deps.now(),
    });
  }

  /** Pane alerts were turned off: the cards Dictate made from Pane's own events go; agents' notes stay. */
  dropPaneCards(): void {
    let changed = false;
    for (const c of this.queue.view(0).all) if (c.origin === 'pane' && this.queue.remove(c.id)) changed = true;
    if (changed) this.deps.changed();
  }
}
