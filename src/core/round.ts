// The decision round: the person works through the waiting cards one after another, by keys or by voice, and the
// round ends with a summary and Undo for the last action. Here are the round's cursor, its spoken commands and its
// words; the window, keys and microphone are main's. Pure.

/** What the person did with a card in a round. */
export type RoundAction = 'approved' | 'answered' | 'snoozed' | 'skipped' | 'opened';

export interface RoundResult {
  id: string;
  action: RoundAction;
  title: string;
  /** The tab, for the summary's right-hand column. */
  tab: string;
  /** The answer, for "answered". */
  text?: string;
  /** When a snoozed card comes back. */
  until?: number;
}

/** A whole utterance that is a command rather than an answer. */
export type RoundCommand = { type: 'approve' } | { type: 'skip' } | { type: 'open' } | { type: 'end' } | { type: 'choose'; n: number } | { type: 'snooze'; minutes: number };

const NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty five': 45, fortyfive: 45, sixty: 60, ninety: 90,
  a: 1, an: 1, half: 30,
};

function number(words: string): number | null {
  if (/^\d+$/.test(words)) return Number(words);
  if (words in NUMBERS) return NUMBERS[words];
  const [tens, ones] = words.split(' ');
  if (tens in NUMBERS && ones in NUMBERS && NUMBERS[tens] >= 20 && NUMBERS[ones] < 10) return NUMBERS[tens] + NUMBERS[ones];
  return null;
}

const words = (text: string) => ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `.replace(/\s+/g, ' ');

/**
 * The person's whole utterance as a round command: "approve", "next" or "skip", "open", "done", "snooze" (the first
 * length) or "snooze ten" (any length 1–120 minutes), "later", or a bare number one to four that picks that choice.
 * Anything else, however short, is the answer.
 */
export function parseCommand(text: string, lengths: number[]): RoundCommand | null {
  const w = words(text).trim().replace(/^(ok|okay|um|uh) /, '').replace(/ (please|thanks|thank you)$/, '');
  if (/^(approve|approved|approve it|yes approve|send it)$/.test(w)) return { type: 'approve' };
  if (/^(next|skip|skip it|next one|pass)$/.test(w)) return { type: 'skip' };
  if (/^(open|open it|open the tab)$/.test(w)) return { type: 'open' };
  if (/^(done|stop|end|end round|that s all|that s it)$/.test(w)) return { type: 'end' };
  if (/^(later|not now)$/.test(w)) return { type: 'snooze', minutes: lengths[0] ?? 5 };
  const snooze = w.match(/^snooze(?: it)?(?: for)?(?: (.+?))?(?: (?:minutes?|mins?|m))?$/);
  if (snooze) {
    if (!snooze[1]) return { type: 'snooze', minutes: lengths[0] ?? 5 };
    const m = number(snooze[1]);
    return m && m >= 1 && m <= 120 ? { type: 'snooze', minutes: m } : null;
  }
  const pick = w.match(/^(?:option |number |choice )?(\S+)$/);
  const n = pick ? number(pick[1]) : null;
  if (n && n >= 1 && n <= 4 && pick && pick[1] !== 'a' && pick[1] !== 'an' && pick[1] !== 'half') return { type: 'choose', n };
  return null;
}

/** The snooze shortcut pressed again while its toast shows: the next length, staying on the last. */
export function nextLength(lengths: number[], current: number): number {
  const i = lengths.indexOf(current);
  return i >= 0 && i < lengths.length - 1 ? lengths[i + 1] : (lengths[lengths.length - 1] ?? current);
}

export class Round {
  private i = 0;
  readonly results: RoundResult[] = [];

  constructor(
    private ids: string[],
    readonly startedAt: number,
  ) {}

  /** The card in front of the person, or null when the round has gone through them all. */
  current(): string | null {
    return this.ids[this.i] ?? null;
  }

  /** "2 of 5". */
  position(): { n: number; of: number } {
    return { n: Math.min(this.i + 1, this.ids.length), of: this.ids.length };
  }

  /** The queue chips: each card and whether it is done, now or next. */
  chips(): { id: string; state: 'done' | 'now' | 'next' }[] {
    return this.ids.map((id, k) => ({ id, state: k < this.i ? 'done' : k === this.i ? 'now' : 'next' }));
  }

  /** Cards that came in during the round join its end. */
  add(ids: string[]): void {
    for (const id of ids) if (!this.ids.includes(id)) this.ids.push(id);
  }

  /** A card left on its own (answered on the pill, withdrawn): the round goes past it. */
  drop(id: string): void {
    const k = this.ids.indexOf(id);
    if (k < 0 || this.results.some((r) => r.id === id)) return;
    this.ids.splice(k, 1);
    if (k < this.i) this.i--;
  }

  /** A click on a chip: that card comes to the front, the rest keep their order. */
  jump(id: string): void {
    const k = this.ids.indexOf(id);
    if (k <= this.i) return;
    this.ids.splice(k, 1);
    this.ids.splice(this.i, 0, id);
  }

  /** The person acted on the current card: the round moves on. */
  act(r: RoundResult): void {
    this.results.push(r);
    this.i++;
  }

  /** Undo: the last action is taken back and its card is in front again. */
  undo(): RoundResult | undefined {
    const r = this.results.pop();
    if (!r) return undefined;
    const k = this.ids.indexOf(r.id);
    if (k >= 0) {
      this.ids.splice(k, 1);
      this.i = Math.max(0, this.i - 1);
      this.ids.splice(this.i, 0, r.id);
    }
    return r;
  }

  done(): boolean {
    return this.i >= this.ids.length;
  }
}

/** "Round done: 3 approved, 1 answered, 1 snoozed until 14:45", from what the round did. `clock` writes a time. */
export function summaryLine(results: RoundResult[], clock: (t: number) => string): string {
  const count = (a: RoundAction) => results.filter((r) => r.action === a);
  const parts: string[] = [];
  for (const a of ['approved', 'answered', 'opened'] as const) if (count(a).length) parts.push(`${count(a).length} ${a}`);
  const snoozed = count('snoozed');
  if (snoozed.length === 1 && snoozed[0].until !== undefined) parts.push(`1 snoozed until ${clock(snoozed[0].until)}`);
  else if (snoozed.length) parts.push(`${snoozed.length} snoozed`);
  if (count('skipped').length) parts.push(`${count('skipped').length} skipped`);
  return parts.length ? `Round done: ${parts.join(', ')}` : 'Round done: nothing changed';
}

/** The local time as the pill shows it, "14:37". */
export function clockTime(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
