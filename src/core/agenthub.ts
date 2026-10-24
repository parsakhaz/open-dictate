// What happens when an agent calls one of Dictate's tools, when Pane reports a tab, and when the person clicks a
// card: the rules between the tools, the card queue, consent and Pane. Everything outside (the pill, runpane,
// history, settings, time) comes in through HubDeps. Pure.
import { cleanMessage, cleanText } from './agenttext';
import { CAPS, parseAsk, parseHistoryRequest, parseNotify, ToolInputError } from './agenttools';
import type { ClientInfo, PaneIds } from './agentwire';
import { type AddResult, BLOCKING_KINDS, type Card, type CardKind, CardQueue, type CardTarget, type SavedQueue } from './cards';
import type { HistoryStore } from './history';
import { type AccessOutcome, type AccessRecord, CONSENT_TIMEOUT_MS, consentSummary, GrantBook, HISTORY_NOTE, readHistory } from './historyaccess';
import { clientSourceLine, type PaneAction, paneSourceLine, WORDS } from './panewatch';
import type { Origin, RequestKind, RequestOwner } from './requests';
import type { VocabTerm } from './types';
import { checkProposals, type PendingTerm } from './vocabproposals';

/** One bridge connection: who is calling, from where. Never anything the agent typed. */
export interface HubSession {
  id: string;
  client: ClientInfo;
  pane: PaneIds | null;
  cwd: string;
  origin?: Origin;
  requestOwned?: boolean;
  /** A question brought back after a restart: the card ids it had before. */
  restoredFrom?: string[];
}

/** An agent's question as asked, kept so it can come back after a restart. */
export interface SavedCall {
  tool: string;
  args: unknown;
  session: Pick<HubSession, 'client' | 'pane' | 'cwd' | 'origin'>;
  /** Every id the card has had, the current one last. */
  aliases: string[];
  createdAt: number;
  snoozes?: number;
  snoozedUntil?: number;
}

/** What the hub keeps across a restart. CLI requests are kept by their own book. */
export interface SavedHub {
  next: number;
  queue: SavedQueue;
  calls: SavedCall[];
  /** An agent's notes that need the person and no call waits on: kept as they are. */
  notes?: Card[];
}

export interface Source {
  line: string;
  /** The round's chip: the same "<agent> · <project>" line. */
  name: string;
  detail?: string;
  /** The Pane tab to open and reply to, when the session is inside one Dictate could find. */
  target: CardTarget | null;
}

export interface TabInfo {
  paneName: string;
  repoName?: string;
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
  /** A card an agent waits on arrived: one pulse of the pill. */
  pulse?(): void;
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

/** How a wait ends without an answer, as a surface tool returns it. */
export type WaitEnd = { answered: false; reason: 'timeout' | 'cancelled' | 'dismissed' };

export interface WaitOptions<E> {
  /** The bridge session waiting: its connection closing ends the wait as cancelled. */
  session: string;
  kind: CardKind;
  timeoutMs: number;
  /** The agent cancelled the call. */
  signal: AbortSignal;
  /** What the wait returns when it times out, is cancelled, or the person dismisses the card; WaitEnd by default. */
  ends?: { timeout: E; cancelled: E; dismissed: E };
}

/** How a card left the pill: answered (a wait settled with an answer, or a reply delivered to its tab), dismissed, expired or cancelled (the agent went). */
export type CardEnd = 'answered' | 'dismissed' | 'expired' | 'cancelled';

/** A surface tool's handler: the arguments as the agent sent them; what it returns goes back as the tool's result. */
export type ToolHandler = (session: HubSession, args: unknown, signal: AbortSignal) => Promise<unknown>;

/** What a surface's card kind does when the person answers it. */
export interface CardHandler {
  /** The person's cleaned words for the card (the key held over it, or Reply). */
  reply?(card: Card, text: string, raw: string): Promise<{ ok: boolean; message: string }>;
  /** A click on one of the kind's own buttons, sent by its body as { action: 'kind', name, value }. */
  action?(card: Card, name: string, value: unknown): Promise<{ ok: boolean; message: string } | undefined>;
}

interface Waiter {
  session: string;
  kind: CardKind;
  resolve(v: unknown): void;
  timer: unknown;
  detach?: () => void;
  ends: { timeout: unknown; cancelled: unknown; dismissed: unknown };
  /** The MCP question behind this wait, saved so its card survives a restart. */
  call?: Omit<SavedCall, 'aliases' | 'createdAt'>;
}

const WAIT_ENDS = {
  timeout: { answered: false, reason: 'timeout' },
  cancelled: { answered: false, reason: 'cancelled' },
  dismissed: { answered: false, reason: 'dismissed' },
} satisfies Record<string, WaitEnd>;

/** A spoken answer names one of the choices ("staging please" → Staging) when exactly one appears in it. */
export function matchChoice(text: string, choices: string[]): string | undefined {
  const said = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  const hits = choices.filter((c) => {
    const w = c.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    return w && said.includes(` ${w} `);
  });
  return hits.length === 1 ? hits[0] : undefined;
}

/** A card in the log: its kind and where it came from, never its words. */
export const cardLabel = (card: Card) => `${card.kind} from ${card.source}`;

export class AgentHub {
  readonly queue = new CardQueue();
  readonly grants = new GrantBook();
  private next = 1;
  /** Bumped when Pane alerts are turned off: an event still looking up its tab then adds nothing. */
  private paneEpoch = 0;
  /** Every call waiting on the person, by card id: asks, consents and the surfaces' questions. */
  private waits = new Map<string, Waiter>();
  private tools = new Map<string, ToolHandler>();
  private kinds = new Map<CardKind, CardHandler>();
  private statusParts: (() => Record<string, unknown>)[] = [];
  private enders: ((cardId: string, how: CardEnd, value: unknown) => void)[] = [];
  private owners = new Map<string, RequestOwner>();
  private cardOwners = new Map<string, RequestOwner>();
  /** MCP questions being raised, by `<session>:<tool>` (a session asks one of each kind at a time). */
  private calling = new Map<string, NonNullable<Waiter['call']>>();

  constructor(private deps: HubDeps) {}

  async callOwned(session: HubSession, tool: RequestKind, args: unknown, owner: RequestOwner): Promise<unknown> {
    this.owners.set(session.id, owner);
    try {
      return await this.call({ ...session, requestOwned: true }, tool, args, owner.signal);
    } catch (error) {
      // An exception after raise must withdraw the request's resources, never leave an orphan card.
      for (const [id, wait] of this.waits) if (wait.session === session.id) this.fail(id, 'feature_failed');
      throw error;
    } finally {
      this.owners.delete(session.id);
    }
  }

  requestOwned(cardId: string): boolean { return this.cardOwners.has(cardId); }

  tickOwned(): void {
    for (const [id] of this.cardOwners) {
      const card = this.queue.get(id);
      if (!card) this.settle(id, { reason: 'faded', card_id: id });
    }
  }

  /** A request-owned surface failed after admission; preserve identity and fail closed. */
  fail(cardId: string, code: string): boolean {
    const owner = this.cardOwners.get(cardId);
    if (!owner) return false;
    owner.ending('failed');
    return this.settle(cardId, { answered: false, reason: code, code, card_id: cardId });
  }

  // ---------- the surfaces' seams ----------

  /** A surface tool's handler (the bridge lists the tool once its module is enabled). */
  handle(tool: string, handler: ToolHandler): void {
    this.tools.set(tool, handler);
  }

  /** What a surface's card kind does when the person answers it by voice or with its own buttons. */
  cardKind(kind: CardKind, handler: CardHandler): void {
    this.kinds.set(kind, handler);
  }

  /** More fields for the status tool (the inbox adds focus and waiting). */
  extendStatus(part: () => Record<string, unknown>): void {
    this.statusParts.push(part);
  }

  /** Told whenever a card ends: how, and with what (the wait's value, or the words sent to its tab). card_status reads this. */
  onEnded(cb: (cardId: string, how: CardEnd, value: unknown) => void): void {
    this.enders.push(cb);
  }

  private ended(cardId: string, how: CardEnd, value: unknown, card: Card | undefined): void {
    this.deps.log('info', `card ${cardId} ${how}${card ? ` (${cardLabel(card)})` : ''}`);
    for (const cb of this.enders) cb(cardId, how, value);
  }

  newId(): string {
    return this.id();
  }

  /** Puts a card on the pill (or merges it with its tab's card): what notify returns, with the card's id. */
  raise(card: Card): { status: AddResult; card_id: string } {
    const status = this.add(card);
    return { status, card_id: this.queue.byKey(card.key)?.id ?? card.id };
  }

  /**
   * Waits for the person on card `cardId` (start waiting, then raise it): settle() answers it; the time running
   * out, the agent cancelling, its connection closing or ✕ end it. The card goes when the wait ends.
   */
  wait<T, E = WaitEnd>(cardId: string, o: WaitOptions<E>): Promise<T | E> {
    return new Promise((resolve) => {
      const startedAt = this.deps.now();
      const w: Waiter = { session: o.session, kind: o.kind, resolve: resolve as (v: unknown) => void, timer: undefined, ends: o.ends ?? WAIT_ENDS, call: this.calling.get(`${o.session}:${o.kind}`) };
      const owner = this.owners.get(o.session);
      if (owner) this.cardOwners.set(cardId, owner);
      const blocking = BLOCKING_KINDS.has(o.kind);
      // When the time comes the queue may have moved the deadline out (time held doesn't count): wait on. A blocking
      // card outlives the call: the agent hears timeout, and the card stays until the person acts.
      const arm = (due: number) => {
        w.timer = this.deps.setTimer(() => {
          const next = this.queue.deadline(cardId, startedAt, o.timeoutMs, this.deps.now(), !!owner);
          if (next > due) arm(next);
          else if (blocking) this.release(cardId, w.ends.timeout);
          else this.settle(cardId, w.ends.timeout);
        }, Math.max(0, due - this.deps.now()));
      };
      this.waits.set(cardId, w);
      // A CLI request's blocking card waits until answered, cancelled, or the request's own lifetime ends.
      if (Number.isFinite(o.timeoutMs) && !(blocking && owner)) arm(this.queue.deadline(cardId, startedAt, o.timeoutMs, startedAt, !!owner));
      const abort = () => this.settle(cardId, o.signal.reason === 'request_expired' ? w.ends.timeout : w.ends.cancelled);
      o.signal.addEventListener('abort', abort, { once: true });
      w.detach = () => o.signal.removeEventListener('abort', abort);
      if (o.signal.aborted) abort();
    });
  }

  /** Ends a wait with `value`. The card goes too, unless `keepCard` (a snoozed question stays in Dictate). */
  settle(cardId: string, value: unknown, keepCard = false): boolean {
    const w = this.waits.get(cardId);
    if (!w) return false;
    if (w.timer !== undefined) this.deps.clearTimer(w.timer);
    w.detach?.();
    this.waits.delete(cardId);
    const how = value === w.ends.timeout ? 'expired' : value === w.ends.cancelled ? 'cancelled' : value === w.ends.dismissed ? 'dismissed' : 'answered';
    if (!keepCard) {
      const result = value as { answered?: boolean } | undefined;
      this.cardOwners.get(cardId)?.ending(w.kind === 'notify' && how === 'answered' && result?.answered !== true ? 'completed' : how);
      this.cardOwners.delete(cardId);
    }
    // A blocking card that ran out of time leaves a line in the "earlier" list.
    const card = keepCard ? undefined : how === 'expired' && BLOCKING_KINDS.has(w.kind) ? this.queue.retire(cardId, this.deps.now()) : this.queue.remove(cardId);
    if (card) this.deps.changed();
    w.resolve(value);
    // A wait settled with keepCard (a snoozed question) hasn't ended: its card is still in Dictate.
    if (!keepCard) this.ended(cardId, how, value, card);
    return true;
  }

  /**
   * The agent stops waiting and the card stays: it still takes an answer, which card_status reports and, in Pane, is
   * typed into the agent's tab. The card goes when the person acts on it.
   */
  release(cardId: string, value: unknown): boolean {
    const w = this.waits.get(cardId);
    const card = this.queue.get(cardId);
    if (!w || !card) return this.settle(cardId, value);
    this.settle(cardId, value, true);
    this.deps.log('info', `card ${cardId} stays after its call ended (${cardLabel(card)})`);
    const late = this.wait<unknown>(cardId, { session: `late:${cardId}`, kind: card.kind, timeoutMs: Number.POSITIVE_INFINITY, signal: new AbortController().signal });
    this.waits.get(cardId)!.call = w.call;
    void late.then((v) => this.deliverLate(card, v));
    return true;
  }

  /** An answer given after the agent's call returned: into its Pane tab as a message (card_status has it either way). */
  private async deliverLate(card: Card, value: unknown): Promise<void> {
    const v = (value ?? {}) as Record<string, unknown>;
    const text = v.answered === false ? '' : String(v.choice ?? v.text ?? (v.approved === true ? 'Approved' : (v.changes ?? '')));
    if (!card.target || !text) return;
    const r = await this.deps.pane.send(card.target.panelId, `Answer to your earlier question “${card.title}”: ${text}`).catch(() => ({ delivered: false }));
    this.deps.log(r.delivered ? 'info' : 'warn', `card ${card.id} late answer ${r.delivered ? 'sent to its tab' : 'not delivered; card_status has it'}`);
  }

  // ---------- across a restart ----------

  /** The waiting MCP questions, the id counter and what card_status knows. */
  saved(): SavedHub {
    const calls: SavedCall[] = [];
    for (const [id, w] of this.waits) {
      const c = this.queue.get(id);
      if (w.call && c) calls.push({ ...w.call, aliases: [...this.queue.aliasesOf(id), id], createdAt: c.createdAt, snoozes: c.snoozes, snoozedUntil: c.snoozedUntil });
    }
    const notes = this.queue.list().filter((c) => c.origin === 'agent' && c.kind === 'notify' && c.urgency === 'needs_you' && !this.waits.has(c.id));
    return { next: this.next, queue: this.queue.saved(), calls, notes };
  }

  /** What card_status knows and the agents' notes come back; saved questions come back through resumeCall. */
  load(s: SavedHub): void {
    this.next = Math.max(this.next, s.next);
    this.queue.load(s.queue);
    for (const c of s.notes ?? []) this.queue.add({ ...c, shownAt: undefined, firstShownAt: undefined }, this.deps.now());
  }

  /**
   * Raises a saved question again, owned by `owner`: an MCP question whose call ended with the app, or a CLI request.
   * Its card takes back its age and snoozes.
   */
  resume(session: HubSession, tool: string, args: unknown, owner: RequestOwner, was: Pick<SavedCall, 'aliases' | 'createdAt' | 'snoozes' | 'snoozedUntil'>): Promise<unknown> {
    const accepted = owner.accepted;
    const restoring: RequestOwner = {
      ...owner,
      accepted: (card, presentation, destination) => {
        this.queue.restore(card, was, this.deps.now());
        accepted(card, presentation, destination);
      },
    };
    return this.callOwned(session, tool as RequestKind, args, restoring);
  }

  /** A saved MCP question comes back after a restart; a later answer reaches card_status and its Pane tab. */
  resumeCall(s: SavedCall): void {
    let card: Card | undefined;
    const owner: RequestOwner = {
      requestId: `resumed:${s.aliases[0]}`,
      signal: new AbortController().signal,
      accepted: (id) => { card = this.queue.get(id); },
      ending: () => undefined,
    };
    void this.resume({ id: `resumed:${s.aliases[0]}:${this.next}`, ...s.session, restoredFrom: s.aliases }, s.tool, s.args, owner, s)
      .then((v) => card && this.deliverLate(card, v))
      .catch((err) => this.deps.log('warn', `agents: a saved question could not come back (${(err as Error).message})`));
  }

  /** A call is waiting on this card. */
  waiting(cardId: string): boolean {
    return this.waits.has(cardId);
  }

  /** The session is already waiting on a card of this kind. */
  waitingOn(session: string, kind: CardKind): boolean {
    return [...this.waits.values()].some((w) => w.session === session && w.kind === kind);
  }

  // ---------- tools ----------

  async call(session: HubSession, tool: string, args: unknown, signal: AbortSignal): Promise<unknown> {
    // An MCP question is kept with its wait, so its card can come back after a restart (CLI requests keep their own).
    const key = `${session.id}:${tool}`;
    const keep = BLOCKING_KINDS.has(tool as CardKind) && (!session.requestOwned || !!session.restoredFrom);
    if (keep) this.calling.set(key, { tool, args, session: { client: session.client, pane: session.pane, cwd: session.cwd, ...(session.origin ? { origin: session.origin } : {}) } });
    try {
      return await this.dispatch(session, tool, args, signal);
    } finally {
      if (keep) this.calling.delete(key);
    }
  }

  private async dispatch(session: HubSession, tool: string, args: unknown, signal: AbortSignal): Promise<unknown> {
    switch (tool) {
      case 'status':
        return { running: true, ...this.deps.status(), doNotDisturb: this.queue.paused, historyAccess: this.deps.history.enabled(), ...Object.assign({}, ...this.statusParts.map((p) => p())) };
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
      default: {
        const handler = this.tools.get(tool);
        if (!handler) throw new ToolInputError(`Unknown tool: ${tool}`);
        return handler(session, args, signal);
      }
    }
  }

  /** Where a session really is, as "<agent> · <project>": its Pane tab when Pane knows it, else its folder. The round's chips use the same line. */
  async source(session: HubSession): Promise<Source> {
    if (session.origin) {
      const o = session.origin;
      const line = o.agent || o.workspace ? clientSourceLine({ name: o.agent || session.client.name, title: o.agent ? undefined : session.client.title }, o.workspace ?? '') : cleanText(o.id, 60).text;
      return { line, name: line, detail: ['Claimed remote origin', cleanText(o.machine, 40).text].filter(Boolean).join(' · '), target: null };
    }
    if (session.pane) {
      const tab = await this.deps.pane.tab(session.pane.sessionId, session.pane.panelId).catch(() => null);
      if (tab) {
        const line = paneSourceLine(tab, session.client);
        return { line, name: line, target: { paneId: session.pane.sessionId, panelId: session.pane.panelId } };
      }
    }
    const line = clientSourceLine(session.client, session.cwd);
    return { line, name: line, target: null };
  }

  private add(card: Card): AddResult {
    if (this.cardOwners.has(card.id)) card.requestOwned = true;
    const r = this.queue.add(card, this.deps.now());
    this.deps.log('info', `card ${card.id} raised (${cardLabel(card)}): ${r}`);
    this.cardOwners.get(card.id)?.accepted(card.id, { state: r }, { source: card.source, ...(card.target ? { local_pane: card.target } : {}) });
    this.queue.tick(this.deps.now());
    if (card.urgency !== 'info' && this.queue.view(this.deps.now()).top?.id === card.id) this.deps.chime();
    if (BLOCKING_KINDS.has(card.kind)) this.deps.pulse?.();
    this.deps.changed();
    return r;
  }

  private id(): string {
    return `k${this.next++}`;
  }

  private async notify(session: HubSession, args: unknown) {
    const a = parseNotify(args);
    const src = await this.source(session);
    const owner = this.owners.get(session.id);
    if (owner?.signal.aborted) return { answered: false, reason: 'cancelled' };
    if (owner) {
      const id = this.id();
      const key = JSON.stringify(['cli-notify', session.origin ? ['origin', session.origin.id] : src.target ? ['tab', src.target.panelId] : ['request', session.id]]);
      const old = this.queue.byKey(key);
      if (old) this.settle(old.id, { reason: 'replaced', replaced_by: owner.requestId, card_id: old.id });
      const answer = this.wait(id, { session: session.id, kind: 'notify', timeoutMs: 24 * 3600_000, signal: owner.signal });
      const status = this.add({ id, key, origin: 'agent', kind: 'notify', urgency: a.urgency, source: src.line, sourceName: src.name, sourceDetail: src.detail, title: a.title, message: a.message, action: a.action, choices: a.choices, link: a.link, target: src.target, createdAt: this.deps.now() });
      const result = await answer as Record<string, unknown>;
      return { ...result, status, card_id: id, ...(a.truncated ? { truncated: true } : {}) };
    }
    const status = this.add({
      id: this.id(),
      key: src.target ? `tab:${src.target.panelId}` : `session:${session.id}`,
      origin: 'agent',
      kind: 'notify',
      urgency: a.urgency,
      source: src.line,
      sourceName: src.name,
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

  private async ask(session: HubSession, args: unknown, signal: AbortSignal): Promise<AskResult & { card_id?: string; truncated?: boolean }> {
    const a = parseAsk(args);
    if (this.waitingOn(session.id, 'ask')) return { answered: false, reason: 'busy' };
    const src = await this.source(session);
    if (signal.aborted) return { answered: false, reason: 'cancelled' };
    const id = this.id();
    const answer = this.wait<AskResult>(id, { session: session.id, kind: 'ask', timeoutMs: a.timeoutS * 1000, signal });
    this.add({
      id,
      key: `ask:${id}`,
      origin: 'agent',
      kind: 'ask',
      urgency: 'needs_you',
      source: src.line,
      sourceName: src.name,
      sourceDetail: src.detail,
      title: a.question,
      message: a.message,
      action: 'reply',
      choices: a.choices,
      target: src.target,
      createdAt: this.deps.now(),
    });
    const r = await answer;
    return { ...r, card_id: id, ...(a.truncated ? { truncated: true } : {}) };
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
    else if (this.waitingOn(session.id, 'consent')) outcome = 'busy';
    else {
      const answer = await this.askConsent(session, src, a, signal);
      outcome = answer === 'once' ? 'allowed-once' : answer === 'session' ? 'allowed-session' : answer === 'timeout' ? 'timeout' : answer === 'off' ? 'off' : 'denied';
    }
    // The setting may have gone off while the card waited, even if the hub was not told in time.
    if (!this.deps.history.enabled()) outcome = 'off';
    if (outcome === 'allowed-session') this.grants.grant(session.id, { source: src.line, client: session.client.name }, this.deps.now());
    if (outcome !== 'allowed-once' && outcome !== 'allowed-session' && outcome !== 'session-grant') {
      record(outcome, 0);
      return { granted: false, reason: outcome };
    }
    const r = readHistory(this.deps.history.store(), a, this.deps.now());
    record(outcome, r.entries.length);
    return { granted: true, note: HISTORY_NOTE, entries: r.entries, ...(r.redacted ? { redacted: r.redacted } : {}), ...(a.clamped ? { clamped: true } : {}) };
  }

  private askConsent(session: HubSession, src: Source, a: ReturnType<typeof parseHistoryRequest>, signal: AbortSignal): Promise<ConsentAnswer | 'timeout' | 'dismissed' | 'off'> {
    const id = this.id();
    const words = consentSummary(a, src.line);
    // ✕ on a consent card is a deny.
    const answer = this.wait<ConsentAnswer | 'off', 'timeout' | 'dismissed' | 'deny'>(id, { session: session.id, kind: 'consent', timeoutMs: CONSENT_TIMEOUT_MS, signal, ends: { timeout: 'timeout', cancelled: 'dismissed', dismissed: 'deny' } });
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
    return answer;
  }

  /** The agent's connection closed: its session grant ends, and its questions are withdrawn. */
  sessionClosed(sessionId: string): void {
    this.grants.ended(sessionId);
    for (const [id, w] of [...this.waits]) if (w.session === sessionId) this.settle(id, w.ends.cancelled);
    // The vocabulary review stays: the terms wait in Settings whether or not the agent is still connected.
    const c = this.queue.byKey(`session:${sessionId}`);
    if (c && c.urgency === 'info' && this.queue.remove(c.id)) this.deps.changed();
  }

  /** The person turned history access off: every waiting consent card is withdrawn and denied, and session grants end. */
  historyAccessOff(): void {
    for (const g of this.grants.list(this.deps.now())) this.grants.revoke(g.sessionId);
    for (const [id, w] of [...this.waits]) if (w.kind === 'consent') this.settle(id, 'off');
  }

  // ---------- the person, on the pill ----------

  dismiss(cardId: string): void {
    const w = this.waits.get(cardId);
    if (w) this.settle(cardId, w.ends.dismissed);
    else {
      const card = this.queue.remove(cardId);
      if (!card) return;
      this.deps.changed();
      this.ended(cardId, 'dismissed', undefined, card);
    }
  }

  consent(cardId: string, answer: ConsentAnswer): void {
    if (this.waits.get(cardId)?.kind === 'consent') this.settle(cardId, answer);
  }

  /** A click on a choice: the answer to an ask, or a reply typed into the card's tab. */
  async choose(cardId: string, choice: string): Promise<{ ok: boolean; message: string }> {
    const card = this.queue.get(cardId);
    if (!card?.choices.includes(choice)) return { ok: false, message: 'That card is gone' };
    if (this.waits.get(cardId)?.kind === 'ask' || (card.requestOwned && card.kind === 'notify')) {
      this.settle(cardId, { answered: true, text: choice, raw: choice, choice });
      return { ok: true, message: 'Answered' };
    }
    if (!card.target) return { ok: false, message: 'Nowhere to send it' };
    return this.replyToTab(card, choice);
  }

  /** The person's cleaned words for a card: its kind's own handler, the answer to an ask, or a reply sent into its Pane tab. */
  async reply(cardId: string, text: string, raw: string): Promise<{ ok: boolean; message: string }> {
    const card = this.queue.get(cardId);
    if (!card) return { ok: false, message: 'That card is gone' };
    const handler = this.kinds.get(card.kind);
    if (handler?.reply) return handler.reply(card, text, raw);
    // A notify with no tab to type into keeps the words for its agent: card_status, or the CLI request, returns them.
    if (this.waits.get(cardId)?.kind === 'ask' || (card.kind === 'notify' && (card.requestOwned || !card.target))) {
      const choice = matchChoice(text, card.choices) ?? matchChoice(raw, card.choices);
      const answer = { answered: true, text, raw, ...(choice ? { choice } : {}) };
      if (!this.settle(cardId, answer) && this.queue.remove(cardId)) {
        this.deps.changed();
        this.ended(cardId, 'answered', answer, card);
      }
      return { ok: true, message: `Answered ${card.source.split(' · ').pop()}` };
    }
    if (!card.target) return { ok: false, message: 'Nowhere to send it' };
    return this.replyToTab(card, text);
  }

  /** A click on one of a surface card's own buttons, handled by its kind. */
  async cardAction(cardId: string, name: string, value: unknown): Promise<{ ok: boolean; message: string } | undefined> {
    const card = this.queue.get(cardId);
    const handler = card ? this.kinds.get(card.kind) : undefined;
    return card && handler?.action ? handler.action(card, name, value) : undefined;
  }

  /** A reply typed into a card's Pane tab, as voice replies are; the card goes once it is delivered. */
  async replyToTab(card: Card, text: string): Promise<{ ok: boolean; message: string }> {
    const tab = card.source.split(' · ').pop();
    const r = await this.deps.pane.send(card.target!.panelId, text);
    if (!r.delivered) {
      this.deps.log('warn', `agents: reply to a Pane tab was not delivered (${r.blocked ?? 'no reason'})`);
      return { ok: false, message: "Couldn't send · opened the tab" };
    }
    if (this.queue.remove(card.id)) {
      this.deps.changed();
      this.ended(card.id, 'answered', { text }, card);
    }
    return { ok: true, message: `Sent to ${tab}` };
  }

  setPaused(on: boolean, until?: number): void {
    this.queue.setPaused(on, this.deps.now(), until);
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
    const epoch = this.paneEpoch;
    const tab = await this.deps.pane.tab(a.paneId, a.panelId).catch(() => null);
    const message = a.message ?? cleanMessage(await this.deps.pane.lastMessage(a.panelId).catch(() => null), CAPS.kept).text;
    if (epoch !== this.paneEpoch) return;
    const blocked = a.type === 'blocked';
    this.add({
      id: this.id(),
      key,
      origin: 'pane',
      kind: blocked ? 'pane-blocked' : 'pane-ready',
      urgency: blocked ? 'needs_you' : 'info',
      source: tab ? paneSourceLine(tab) : 'Pane tab',
      title: a.title ?? (blocked ? WORDS.blocked : WORDS.finished),
      message,
      action: blocked ? 'reply' : null,
      choices: [],
      target: { paneId: a.paneId, panelId: a.panelId },
      createdAt: this.deps.now(),
    });
  }

  /** Pane alerts were turned off: the cards Dictate made from Pane's own events go; agents' notes stay, as they were before Pane merged in. */
  dropPaneCards(): void {
    this.paneEpoch++;
    if (this.queue.dropPane()) this.deps.changed();
  }
}
