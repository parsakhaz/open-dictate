// Attention cards on the pill: what agents and Pane tabs need from the person. One card per tab (or per agent
// session outside Pane), ranked most urgent and oldest first, held while the person dictates and while alerts are
// paused. Pure: time comes in as arguments.
import type { ActionHint } from './agenttools';

/** consent and needs_you stay until handled; info fades after a few seconds. */
export type CardUrgency = 'info' | 'needs_you' | 'consent';

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
  kind: 'pane-blocked' | 'pane-ready' | 'notify' | 'ask' | 'consent' | 'vocab';
  urgency: CardUrgency;
  /** Always Dictate's own words: "<Pane name> · <tab>", or "<client> · <folder>". */
  source: string;
  /** Shown when the card is expanded, e.g. the Session name. */
  sourceDetail?: string;
  title: string;
  message: string;
  action?: ActionHint | null;
  choices: string[];
  link?: { url: string; host: string } | null;
  /** The Pane tab this card opens and replies to; none outside Pane. */
  target: CardTarget | null;
  createdAt: number;
  /** When an info card was first on screen; it fades a few seconds later. */
  shownAt?: number;
  faded?: boolean;
}

export type AddResult = 'shown' | 'queued' | 'dnd' | 'replaced';

export const INFO_MS = 5000;
/** Faded info cards are kept for the list this long. */
export const FADED_KEEP_MS = 10 * 60_000;
/** After a dictation ends, cards wait this long before appearing. */
export const AFTER_DICTATION_MS = 1000;

const rank = (u: CardUrgency) => (u === 'consent' ? 0 : u === 'needs_you' ? 1 : 2);

export interface CardView {
  /** The card on the pill, if any is due. */
  top: Card | null;
  /** Every other card waiting, faded info cards included: the "+N". */
  more: number;
  /** All cards, in order, for the list behind "+N". */
  all: Card[];
}

export class CardQueue {
  private cards: Card[] = [];
  /** The person is dictating (or just finished): nothing new appears until `holdUntil`. */
  private dictating = false;
  private holdUntil = 0;
  paused = false;

  /** Adds a card, or merges it into the card already there for the same tab or session. */
  add(card: Card, now: number): AddResult {
    const i = this.cards.findIndex((c) => c.key === card.key);
    let replaced = false;
    let next = card;
    if (i >= 0) {
      const old = this.cards[i];
      // A finished tab never hides one that still needs the person.
      if (card.kind === 'pane-ready' && rank(old.urgency) < rank(card.urgency)) return this.paused ? 'dnd' : 'queued';
      // Pane saying a tab is blocked keeps the agent's own headline from that tab, and offers Reply.
      if (card.kind === 'pane-blocked' && old.origin === 'agent' && old.kind === 'notify') {
        next = { ...old, kind: 'pane-blocked', urgency: 'needs_you', target: card.target ?? old.target, faded: false, shownAt: undefined };
      }
      this.cards.splice(i, 1);
      replaced = true;
    }
    this.cards.push(next);
    this.sort();
    if (this.paused) return 'dnd';
    if (replaced) return 'replaced';
    return this.isHeld(now) || this.view(now).top?.id !== next.id ? 'queued' : 'shown';
  }

  remove(id: string): Card | undefined {
    const i = this.cards.findIndex((c) => c.id === id);
    return i >= 0 ? this.cards.splice(i, 1)[0] : undefined;
  }

  removeKey(key: string): Card | undefined {
    const c = this.cards.find((x) => x.key === key);
    return c ? this.remove(c.id) : undefined;
  }

  get(id: string): Card | undefined {
    return this.cards.find((c) => c.id === id);
  }

  byKey(key: string): Card | undefined {
    return this.cards.find((c) => c.key === key);
  }

  /** Cards waiting for the person: the tray's count while alerts are paused. */
  get waiting(): number {
    return this.cards.filter((c) => !c.faded).length;
  }

  setDictating(on: boolean, now: number): void {
    if (this.dictating && !on) this.holdUntil = now + AFTER_DICTATION_MS;
    this.dictating = on;
  }

  /** Unpausing shows the cards that still need the person; info that arrived meanwhile is dropped. */
  setPaused(on: boolean): void {
    if (this.paused && !on) this.cards = this.cards.filter((c) => c.urgency !== 'info');
    this.paused = on;
  }

  isHeld(now: number): boolean {
    return this.paused || this.dictating || now < this.holdUntil;
  }

  /** Fades info cards that have been up long enough, and forgets old faded ones. Returns true when anything changed. */
  tick(now: number): boolean {
    let changed = false;
    const top = this.isHeld(now) ? null : this.visible()[0];
    if (top && top.urgency === 'info' && top.shownAt === undefined) top.shownAt = now;
    for (const c of this.cards) {
      if (c.urgency === 'info' && !c.faded && c.shownAt !== undefined && now - c.shownAt >= INFO_MS) {
        c.faded = true;
        changed = true;
      }
    }
    const before = this.cards.length;
    this.cards = this.cards.filter((c) => !(c.faded && now - c.createdAt > FADED_KEEP_MS));
    return changed || this.cards.length !== before;
  }

  /** When the next tick could change what is on screen, or null. */
  nextDue(now: number): number | null {
    const times: number[] = [];
    if (!this.paused && !this.dictating && now < this.holdUntil) times.push(this.holdUntil);
    for (const c of this.cards) {
      if (c.urgency === 'info' && !c.faded && c.shownAt !== undefined) times.push(c.shownAt + INFO_MS);
      if (c.faded) times.push(c.createdAt + FADED_KEEP_MS);
    }
    if (!this.isHeld(now) && this.visible()[0]?.shownAt === undefined && this.visible()[0]?.urgency === 'info') times.push(now);
    return times.length ? Math.max(now, Math.min(...times)) : null;
  }

  view(now: number): CardView {
    const all = [...this.cards];
    const top = this.isHeld(now) ? null : (this.visible()[0] ?? null);
    return { top, more: top ? all.length - 1 : 0, all };
  }

  private visible(): Card[] {
    return this.cards.filter((c) => !c.faded);
  }

  private sort(): void {
    this.cards.sort((a, b) => rank(a.urgency) - rank(b.urgency) || a.createdAt - b.createdAt);
  }
}
