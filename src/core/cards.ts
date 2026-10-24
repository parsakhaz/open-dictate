// Attention cards on the pill: what agents and Pane tabs need from the person. One card per tab (or per agent
// session outside Pane), ranked consent, then cards that block an agent, then the rest, oldest first in each group,
// held while the person dictates (except the card being answered by voice and the point review) and while alerts are
// paused. The inbox's rules live here too: the flow guard holds a new card while the person types or Windows says
// they're busy, a snoozed card waits for its time, and time a card waited before it was first on screen doesn't count
// against a waiting call. Pure: time comes in as arguments.
import type { ActionHint } from './agenttools';
import { type Focus, type HeldReason, TYPING_MS, typingAt } from './flowguard';

/** consent and needs_you stay until handled; info fades after a few seconds, except the vocabulary review. */
export type CardUrgency = 'info' | 'needs_you' | 'consent';

/**
 * Every kind of card. The first six are today's; the rest belong to the surfaces, one lane each: decide and approve
 * (L1), round-summary (L2), voice-draft (L3), lineup (L4), peek (L5), point-review (L6). Each kind has a body module
 * in src/renderer/cards/ and, when it answers anything, a handler registered with AgentHub.cardKind.
 */
export const CARD_KINDS = ['pane-blocked', 'pane-ready', 'notify', 'ask', 'consent', 'vocab', 'decide', 'approve', 'round-summary', 'voice-draft', 'lineup', 'peek', 'point-review'] as const;
export type CardKind = (typeof CARD_KINDS)[number];
/** Cards an agent waits on: they stay until the person acts or the agent cancels, and arrive with a cue. */
export const BLOCKING_KINDS: ReadonlySet<CardKind> = new Set(['ask', 'decide', 'approve', 'lineup']);

export interface CardTarget {
  paneId: string;
  panelId: string;
}

export interface Card {
  id: string;
  /** Cards with the same key replace each other: `tab:<panelId>`, `session:<id>`, or the card's own id. */
  key: string;
  /** Who wrote the words: Pane (blocked, finished, a report) or the agent itself. */
  origin: 'pane' | 'agent' | 'dictate';
  /** pane-ready is Pane's "Finished": it never replaces a card that needs the person. */
  kind: CardKind;
  urgency: CardUrgency;
  /** Always Dictate's own words: "<agent> · <repo> / <Pane name>", or "<agent> · <folder>". */
  source: string;
  /** The round's chip: the same line as `source`. */
  sourceName?: string;
  /** Shown when the card is expanded, e.g. the Session name. */
  sourceDetail?: string;
  title: string;
  message: string;
  action?: ActionHint | null;
  choices: string[];
  link?: { url: string; host: string } | null;
  /** What a surface's card body draws beyond the title and message (decide's questions, lineup's thumbnails): plain data, already checked, never HTML. */
  data?: unknown;
  /** The Pane tab this card opens and replies to; none outside Pane. */
  target: CardTarget | null;
  createdAt: number;
  /** App-owned CLI response sink, independent of Pane routing. */
  requestOwned?: boolean;
  /** When an info card was first on screen; it fades into the "earlier" list a few seconds later (moved on by the time it was hovered). */
  shownAt?: number;
  /** An agent's note that Pane's "blocked" merged into: what it was before, to go back to when Pane alerts are off. */
  beforePane?: Pick<Card, 'kind' | 'urgency' | 'shownAt'>;
  /** When the card was first in front of the person (the pill's top card, or a round's): time before it doesn't count against a wait. */
  firstShownAt?: number;
  /** Snoozed: away until then (a time like createdAt), since snoozedAt. */
  snoozedUntil?: number;
  snoozedAt?: number;
  /** Time spent snoozed before now, which also doesn't count against a wait. */
  snoozedMs?: number;
  /** How many times this card was snoozed: each snooze takes the next length. */
  snoozes?: number;
  /** Came back from a snooze: marked "Back from snooze". */
  back?: boolean;
  /** Came back from a snooze into the inbox: counted in "waiting", not shown until a round or Now. */
  quiet?: boolean;
  /** Answered in a round but not yet sent (Undo can still take it back): out of sight. */
  parked?: boolean;
  /** CLI answer budgets pause after first display while snoozed, quiet or awaiting round Undo. */
  answerPausedAt?: number;
  answerPausedMs?: number;
}

export type AddResult = 'shown' | 'queued' | 'held' | 'dnd' | 'replaced';

export const INFO_MS = 4500;
/** After the pointer leaves, an info card stays at least this long. */
export const HOVER_GRACE_MS = 2000;
/** Faded info notes stay in the "earlier" list this long, at most RECENT_MAX of them. */
export const RECENT_MS = 30 * 60_000;
export const RECENT_MAX = 10;
/** After a note fades, the "earlier" capsule shows on its own this long. */
export const RECENT_FRESH_MS = 60_000;
/** After a dictation ends, cards wait this long before appearing. */
export const AFTER_DICTATION_MS = 1000;
/** A waiting call never runs past this from the call, however long its card was held or snoozed (Codex gives a tool 660 s). */
export const MAX_WAIT_MS = 600_000;
/** How many ended cards card_status remembers. */
const ENDED_KEEP = 500;

/** Where a card is, as card_status reports it. */
export type CardState = 'held' | 'shown' | 'snoozed' | 'answered' | 'dismissed' | 'expired' | 'cancelled' | 'gone';
export interface CardStatus {
  state: CardState;
  /** When a snoozed card comes back. */
  until?: number;
  /** An answer Dictate saw, also one given after the call returned. */
  answer?: unknown;
}

/** A faded info note in the "earlier" list. */
export interface Recent {
  id: string;
  source: string;
  title: string;
  message: string;
  at: number;
}

/** What card_status keeps across a restart: how cards ended, and the ids restored cards had before. */
export interface SavedQueue {
  ends: [string, CardStatus][];
  aliases: [string, string][];
}

/** A snoozed card on the shelf. */
export interface Snoozed {
  id: string;
  title: string;
  source: string;
  until: number;
  since: number;
}

const rank = (c: Card) => (c.kind === 'point-review' ? -2 : c.kind === 'round-summary' ? -1 : c.urgency === 'consent' ? 0 : BLOCKING_KINDS.has(c.kind) ? 1 : c.urgency === 'needs_you' ? 2 : 3);
const byRank = (a: Card, b: Card) => rank(a) - rank(b) || a.createdAt - b.createdAt;
/** Info cards fade; the vocabulary review asks the person to act, so it stays like a card that needs them. The round's summary goes when the inbox takes it. */
const fades = (c: Card) => c.urgency === 'info' && c.kind !== 'vocab' && c.kind !== 'round-summary';
const away = (c: Card) => c.snoozedUntil !== undefined || !!c.parked;
/** Spoken words reach this card's agent: through its Pane tab, a waiting ask, or an agent's notify (card_status, or the CLI request, returns them). */
export const takesReply = (c: Card) => !!c.target || c.kind === 'ask' || c.kind === 'notify';

export interface CardView {
  /** The card on the pill, if any is due. */
  top: Card | null;
  /** Every other card waiting: the "+N". */
  more: number;
  /** All cards, in order, for the list behind "+N" (snoozed and parked cards aren't in it). */
  all: Card[];
  /** The queue's own summary for the pill's extras (the inbox's held and snoozed counts): plain data. */
  extra?: Record<string, unknown>;
}

export class CardQueue {
  private cards: Card[] = [];
  /** The person is dictating (or just finished): nothing new appears until `holdUntil`. */
  private dictating = false;
  private holdUntil = 0;
  /** The card the person is answering by voice: it stays on screen through the dictation. */
  private replying: string | null = null;
  /** Since when the pointer has been over the cards: info cards don't fade meanwhile. */
  private hoveredSince: number | null = null;
  /** The last key-down (the flow guard's typing signal) and Windows' busy state. */
  private typedAt = Number.NEGATIVE_INFINITY;
  private busy = false;
  /** Spans of time new cards were held (dictating, typing, busy, paused), merged, and the spans still open. */
  private holds: [number, number][] = [];
  private dictatingSince: number | null = null;
  private busySince: number | null = null;
  /** A round is open: it shows the cards itself, so the pill shows none. */
  private round = false;
  private roundShown: string | null = null;
  /** The card that was on the pill when the flow guard started holding: it stays. */
  private onScreen: string | null = null;
  /** How cards that left ended, for card_status. */
  private ends = new Map<string, CardStatus>();
  /** A restored card's earlier ids, for card_status: old id → current id. */
  private aliases = new Map<string, string>();
  /** Faded info notes, newest first. */
  private recent: Recent[] = [];
  paused = false;
  /** When a timed pause ends; undefined for "until I resume". Shown on the pill. */
  private pausedUntil: number | undefined;
  private pausedSince: number | null = null;
  /** Where a card goes when its snooze ends: back on top, or quietly into the inbox. */
  returnTo: 'top' | 'inbox' = 'top';

  /** Adds a card, or merges it into the card already there for the same tab or session. */
  add(card: Card, now: number): AddResult {
    const i = this.cards.findIndex((c) => c.key === card.key);
    let replaced = false;
    let next = card;
    if (i >= 0) {
      const old = this.cards[i];
      // A finished tab never hides one that still needs the person, nor the agent's own words.
      if (card.kind === 'pane-ready' && (old.origin === 'agent' || rank(old) < rank(card))) return this.paused ? 'dnd' : 'queued';
      // Pane saying a tab is blocked keeps the agent's own headline from that tab, and offers Reply.
      if (card.kind === 'pane-blocked' && old.origin === 'agent' && old.kind === 'notify') {
        const beforePane = { kind: old.kind, urgency: old.urgency, shownAt: old.shownAt };
        next = { ...old, kind: 'pane-blocked', urgency: 'needs_you', target: card.target ?? old.target, shownAt: undefined, beforePane };
      }
      this.cards.splice(i, 1);
      // The old card left (unless Pane merged into it and it keeps its id): card_status still knows it.
      if (next.id !== old.id && !this.ends.has(old.id)) this.ended(old.id, 'gone');
      if (this.onScreen === old.id) this.onScreen = null;
      replaced = true;
    }
    this.cards.push(next);
    this.sort();
    if (this.paused) return 'dnd';
    if (replaced) return 'replaced';
    if (this.view(now).top?.id === next.id) return 'shown';
    return this.heldFor(now) ? 'held' : 'queued';
  }

  /** Pane alerts were turned off: Pane's cards go, and agents' notes it merged into are as they were. True if any changed. */
  dropPane(): boolean {
    const before = this.cards.length;
    let restored = false;
    this.cards = this.cards.flatMap((c) => {
      if (c.origin === 'pane') return [];
      if (!c.beforePane) return [c];
      restored = true;
      const { beforePane, ...rest } = c;
      return [{ ...rest, ...beforePane }];
    });
    this.sort();
    return restored || this.cards.length !== before;
  }

  remove(id: string): Card | undefined {
    const i = this.cards.findIndex((c) => c.id === id);
    if (i < 0) return undefined;
    if (!this.ends.has(id)) this.ended(id, 'gone');
    if (this.onScreen === id) this.onScreen = null;
    return this.cards.splice(i, 1)[0];
  }

  /** The card leaves into the "earlier" list: a faded note, or a question whose time ran out. */
  retire(id: string, now: number): Card | undefined {
    const c = this.remove(id);
    if (c) this.recent = [{ id: c.id, source: c.source, title: c.title, message: c.message, at: now }, ...this.recent].slice(0, RECENT_MAX);
    return c;
  }

  removeKey(key: string): Card | undefined {
    const c = this.cards.find((x) => x.key === key);
    return c ? this.remove(c.id) : undefined;
  }

  /** Every card, snoozed and parked ones included. */
  list(): Card[] {
    return [...this.cards];
  }

  get(id: string): Card | undefined {
    return this.cards.find((c) => c.id === id);
  }

  byKey(key: string): Card | undefined {
    return this.cards.find((c) => c.key === key);
  }

  /** Cards waiting for the person: the tray's count while alerts are paused. */
  get waiting(): number {
    return this.cards.filter((c) => !away(c)).length;
  }

  /** `replyTo`: the card this dictation answers, kept on screen until the dictation is over. */
  setDictating(on: boolean, now: number, replyTo?: string): void {
    // After a reply the cards come straight back: the person was already looking at them.
    if (this.dictating && !on && !this.replying) this.holdUntil = now + AFTER_DICTATION_MS;
    if (on && this.dictatingSince === null) this.dictatingSince = now;
    if (!on && this.dictatingSince !== null) {
      this.hold(this.dictatingSince, Math.max(now, this.holdUntil));
      this.dictatingSince = null;
    }
    // An info card that was answered but is still here gets its full time again.
    const answered = this.replying ? this.get(this.replying) : undefined;
    if (!on && answered && fades(answered) && answered.shownAt !== undefined) answered.shownAt = now;
    this.dictating = on;
    this.replying = on && replyTo && this.get(replyTo) ? replyTo : null;
  }

  get replyingTo(): string | null {
    return this.replying && this.get(this.replying) ? this.replying : null;
  }

  /** A key went down (its time only): new cards wait until the person has stopped typing for a few seconds. */
  typed(now: number): void {
    this.typedAt = now;
    this.hold(now, now + TYPING_MS);
  }

  /** Windows says the person is busy (full screen, presenting). True when that changed. */
  setBusy(on: boolean, now: number): boolean {
    const changed = this.busy !== on;
    if (on && this.busySince === null) this.busySince = now;
    if (!on && this.busySince !== null) {
      this.hold(this.busySince, now);
      this.busySince = null;
    }
    this.busy = on;
    return changed;
  }

  /** A round is open (it shows the cards), or closed. */
  setRound(on: boolean, now?: number): void {
    if (!on && this.roundShown) {
      const c = this.get(this.roundShown);
      if (c?.quiet) this.pauseAnswer(c, now ?? c.createdAt);
      this.roundShown = null;
    }
    this.round = on;
    this.onScreen = null;
  }

  /** What status reports as `focus`. */
  focus(now: number): Focus {
    if (this.dictating || now < this.holdUntil) return 'dictating';
    return this.busy || typingAt(this.typedAt, now) ? 'focused' : 'free';
  }

  /** Why nothing new shows on the pill right now, or null. */
  heldFor(now: number): HeldReason | null {
    if (this.paused) return 'paused';
    if (this.round) return 'round';
    if (this.dictating || now < this.holdUntil) return 'talking';
    if (typingAt(this.typedAt, now)) return 'typing';
    return this.busy ? 'busy' : null;
  }

  get hovered(): boolean {
    return this.hoveredSince !== null;
  }

  /** The pointer is over the cards: info cards wait, then get the rest of their time when it leaves, at least 2 s. */
  setHovered(on: boolean, now: number): void {
    if (on && this.hoveredSince === null) this.hoveredSince = now;
    if (!on && this.hoveredSince !== null) {
      const paused = now - this.hoveredSince;
      for (const c of this.cards) {
        if (!fades(c) || c.shownAt === undefined) continue;
        c.shownAt = Math.max(c.shownAt + paused, now + HOVER_GRACE_MS - INFO_MS);
      }
      this.hoveredSince = null;
    }
  }

  /** Pausing holds every new card, like dictating does; resuming shows all that queued. `until`: when a timed pause ends. */
  setPaused(on: boolean, now: number, until?: number): void {
    if (on && this.pausedSince === null) this.pausedSince = now;
    if (!on && this.pausedSince !== null) {
      this.hold(this.pausedSince, now);
      this.pausedSince = null;
    }
    this.paused = on;
    this.pausedUntil = on ? until : undefined;
  }

  isHeld(now: number): boolean {
    return this.paused || this.dictating || now < this.holdUntil;
  }

  // ---------- snooze ----------

  /** Puts a card away until `until`. Consent is answer-or-deny, so it can't be snoozed. */
  snooze(id: string, until: number, now: number): boolean {
    const c = this.get(id);
    if (!c || c.urgency === 'consent' || c.kind === 'round-summary') return false;
    this.pauseAnswer(c, now);
    if (c.snoozedUntil === undefined) c.snoozedAt = now;
    c.snoozedUntil = until;
    c.snoozes = (c.snoozes ?? 0) + 1;
    c.back = false;
    c.quiet = false;
    if (this.onScreen === id) this.onScreen = null;
    return true;
  }

  /** Ends a snooze now: its time came (`back`, marked and on top, or into the inbox), Now, or Undo (no mark). */
  wake(id: string, now: number, back = true): boolean {
    const c = this.get(id);
    if (!c || c.snoozedUntil === undefined) return false;
    c.snoozedMs = (c.snoozedMs ?? 0) + Math.max(0, Math.min(now, c.snoozedUntil) - (c.snoozedAt ?? now));
    c.snoozedUntil = undefined;
    c.snoozedAt = undefined;
    c.back = back;
    c.quiet = back && this.returnTo === 'inbox';
    this.resumeAnswer(c, now);
    this.sort();
    return true;
  }

  /** A card from the inbox comes forward (a click on the waiting count, Now). */
  unquiet(id: string, now?: number): void {
    const c = this.get(id);
    if (c) { c.quiet = false; this.resumeAnswer(c, now ?? c.createdAt); }
  }

  /** QA: moves the clock forward for snoozes, so a snoozed card comes back `ms` sooner. */
  advance(ms: number): void {
    for (const c of this.cards) {
      if (c.snoozedUntil === undefined) continue;
      c.snoozedUntil -= ms;
      c.snoozedAt = (c.snoozedAt ?? 0) - ms;
    }
  }

  snoozed(): Snoozed[] {
    return this.cards.filter((c) => c.snoozedUntil !== undefined).map((c) => ({ id: c.id, title: c.title, source: c.source, until: c.snoozedUntil!, since: c.snoozedAt! })).sort((a, b) => a.until - b.until);
  }

  /** Cards that came back into the inbox, waiting for a round. */
  inbox(): Card[] {
    return this.cards.filter((c) => c.quiet && !away(c));
  }

  // ---------- the round ----------

  /** The cards a round works through: those that need the person (not consent, not info), blocking first, oldest first. */
  roundCards(): Card[] {
    return this.cards.filter((c) => c.urgency === 'needs_you' && !away(c) && c.kind !== 'round-summary').sort(byRank);
  }

  /** A card answered in a round waits out of sight until it is sent (or Undo brings it back). */
  park(id: string, on: boolean, now?: number): void {
    const c = this.get(id);
    if (c) {
      if (on) this.pauseAnswer(c, now ?? c.createdAt);
      c.parked = on;
      if (!on) this.resumeAnswer(c, now ?? c.createdAt);
    }
  }

  /** The card is in front of the person (the pill, or a round): time from here counts against its wait. */
  markShown(id: string, now: number): void {
    const c = this.get(id);
    if (c && c.firstShownAt === undefined) c.firstShownAt = now;
    if (c && this.round) {
      const before = this.roundShown ? this.get(this.roundShown) : undefined;
      if (before?.quiet && before.id !== id) this.pauseAnswer(before, now);
      this.roundShown = id;
      this.resumeAnswer(c, now, true);
    }
  }

  // ---------- card_status ----------

  /** How a card ended (the hub says, or the inbox for what it saw itself). */
  ended(id: string, state: CardState, answer?: unknown): void {
    this.ends.delete(id);
    this.ends.set(id, answer === undefined ? { state } : { state, answer });
    if (this.ends.size > ENDED_KEEP) this.ends.delete(this.ends.keys().next().value!);
  }

  status(asked: string, now: number): CardStatus | null {
    const id = this.aliases.get(asked) ?? asked;
    const c = this.get(id);
    if (!c) return this.ends.get(id) ?? null;
    if (c.snoozedUntil !== undefined) return { state: 'snoozed', until: c.snoozedUntil };
    if (this.ends.has(id)) return this.ends.get(id)!;
    if (c.quiet) return { state: 'held' };
    return c.firstShownAt !== undefined || this.view(now).top?.id === id ? { state: 'shown' } : { state: 'held' };
  }

  /** A card brought back after a restart: its first arrival, its snoozes, and the ids card_status knew it by. */
  restore(id: string, was: { createdAt: number; snoozes?: number; snoozedUntil?: number; aliases: string[] }, now: number): void {
    const c = this.get(id);
    if (!c) return;
    c.createdAt = was.createdAt;
    if (was.snoozedUntil !== undefined && was.snoozedUntil > now) this.snooze(id, was.snoozedUntil, now);
    c.snoozes = was.snoozes;
    for (const old of was.aliases) this.aliases.set(old, id);
    this.sort();
  }

  /** What card_status needs after a restart. */
  saved(): SavedQueue {
    return { ends: [...this.ends], aliases: [...this.aliases] };
  }

  load(s: SavedQueue): void {
    this.ends = new Map(s.ends.slice(-ENDED_KEEP));
    this.aliases = new Map(s.aliases.slice(-ENDED_KEEP));
  }

  /** The earlier ids of a card, for saving it. */
  aliasesOf(id: string): string[] {
    return [...this.aliases].filter(([, to]) => to === id).map(([old]) => old);
  }

  /**
   * When a wait on this card (an ask, a consent, a surface's question) runs out: `timeoutMs` after it started, plus
   * the time it was held for focus before it was first in front of the person and the time it was snoozed, never past 600 s from
   * the call (or the call's own timeout, if longer). The hub asks again when that time comes.
   */
  deadline(id: string, startedAt: number, timeoutMs: number, now: number, appOwned = false): number {
    const c = this.get(id);
    if (appOwned && c) {
      const beforeShown = Math.max(0, (c.firstShownAt ?? now) - startedAt);
      const paused = (c.answerPausedMs ?? 0) + (c.answerPausedAt === undefined ? 0 : Math.max(0, now - c.answerPausedAt));
      return Math.min(startedAt + timeoutMs + beforeShown + paused, startedAt + 24 * 3600_000);
    }
    let extra = 0;
    if (c) {
      extra += this.heldBetween(startedAt, c.firstShownAt ?? now, now);
      extra += (c.snoozedMs ?? 0) + (c.snoozedUntil !== undefined ? Math.max(0, now - (c.snoozedAt ?? now)) : 0);
    }
    const due = Math.min(startedAt + timeoutMs + extra, startedAt + (appOwned ? 24 * 3600_000 : Math.max(timeoutMs, MAX_WAIT_MS)));
    if (due <= now && c) this.ended(id, 'expired');
    return due;
  }

  private pauseAnswer(c: Card, now: number): void {
    if (c.requestOwned && c.firstShownAt !== undefined && c.answerPausedAt === undefined) c.answerPausedAt = now;
  }

  private resumeAnswer(c: Card, now: number, visibleInRound = false): void {
    if (!away(c) && (!c.quiet || visibleInRound) && c.answerPausedAt !== undefined) {
      c.answerPausedMs = (c.answerPausedMs ?? 0) + Math.max(0, now - c.answerPausedAt);
      c.answerPausedAt = undefined;
    }
  }

  /** Fades info cards that have been up long enough into the "earlier" list, brings snoozed cards back, and forgets old notes. Returns true when anything changed. */
  tick(now: number): boolean {
    let changed = false;
    for (const c of this.cards) if (c.snoozedUntil !== undefined && c.snoozedUntil <= now) changed = this.wake(c.id, now) || changed;
    const top = this.view(now).top;
    if (top && !this.heldFor(now)) this.onScreen = top.id;
    if (!top) this.onScreen = null;
    if (top && top.id !== this.replying) this.markShown(top.id, now);
    if (top && fades(top) && top.shownAt === undefined) top.shownAt = now;
    for (const c of this.cards.filter((x) => this.ticking(x) && now - x.shownAt! >= INFO_MS)) changed = !!this.retire(c.id, now) || changed;
    const before = this.recent.length;
    this.recent = this.recent.filter((r) => now - r.at < RECENT_MS);
    return changed || this.recent.length !== before;
  }

  /** When the next tick could change what is on screen, or null. */
  nextDue(now: number): number | null {
    const times: number[] = [];
    if (!this.paused && !this.dictating && now < this.holdUntil) times.push(this.holdUntil);
    if (typingAt(this.typedAt, now)) times.push(this.typedAt + TYPING_MS);
    for (const c of this.cards) {
      if (this.ticking(c)) times.push(c.shownAt! + INFO_MS);
      if (c.snoozedUntil !== undefined) times.push(c.snoozedUntil);
    }
    const last = this.recent[0];
    if (last && now < last.at + RECENT_FRESH_MS) times.push(last.at + RECENT_FRESH_MS);
    if (this.recent.length) times.push(this.recent[this.recent.length - 1].at + RECENT_MS);
    const top = this.view(now).top;
    if (top && fades(top) && top.shownAt === undefined) times.push(now);
    return times.length ? Math.max(now, Math.min(...times)) : null;
  }

  view(now: number): CardView {
    const all = this.cards.filter((c) => !away(c));
    const replying = this.replyingTo;
    const top = replying ? this.get(replying)! : this.topAt(now);
    const visible = this.visible();
    const waiting = top ? 0 : visible.length + this.inbox().length;
    const recentFresh = !!this.recent[0] && now < this.recent[0].at + RECENT_FRESH_MS;
    const extra = { waiting, reason: this.heldFor(now), ...(this.pausedUntil !== undefined ? { pausedUntil: this.pausedUntil } : {}), snoozed: this.snoozed(), back: all.filter((c) => c.back).map((c) => c.id), recent: this.recent, recentFresh };
    return { top, more: top ? all.length - 1 : 0, all, extra };
  }

  /** The pill's top card: none while held, except the card already on screen when the flow guard started holding. */
  private topAt(now: number): Card | null {
    const first = this.visible()[0] ?? null;
    // The point review is what the person just did: it shows at once, through any hold.
    if (first?.kind === 'point-review') return first;
    if (this.isHeld(now) || this.round || !first) return null;
    // A round's summary always shows.
    if (first.kind === 'round-summary') return first;
    if (this.heldFor(now)) {
      const kept = this.onScreen ? this.visible().find((c) => c.id === this.onScreen) : undefined;
      return kept ?? null;
    }
    return first;
  }

  /** Records a span new cards were held, merged with the others; only the last hundred are kept. */
  private hold(start: number, end: number): void {
    this.holds = merge([...this.holds, [start, end]]).slice(-100);
  }

  /** How long, between a and b, new cards were held for focus (the spans still open run to now). */
  private heldBetween(a: number, b: number, now: number): number {
    const open: [number, number][] = [];
    if (this.dictatingSince !== null) open.push([this.dictatingSince, now]);
    if (this.busySince !== null) open.push([this.busySince, now]);
    if (this.pausedSince !== null) open.push([this.pausedSince, now]);
    return merge([...this.holds, ...open]).reduce((sum, [s, e]) => sum + Math.max(0, Math.min(e, b) - Math.max(s, a)), 0);
  }

  /** An info card whose time is running: shown, not hovered, not being answered. */
  private ticking(c: Card): boolean {
    return fades(c) && c.shownAt !== undefined && this.hoveredSince === null && c.id !== this.replying;
  }

  private visible(): Card[] {
    return this.cards.filter((c) => !away(c) && !c.quiet);
  }

  private sort(): void {
    this.cards.sort(byRank);
  }
}

function merge(spans: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [s, e] of [...spans].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}
