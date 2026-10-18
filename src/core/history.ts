// Dictation history: newest first, pinned items on top and never evicted, capped, searchable. Pure.

export interface HistoryEntry {
  id: string;
  /** ISO time the dictation was delivered. */
  at: string;
  /** What the recognizer heard. */
  raw: string;
  /** What was typed (the cleaned text, or the raw text when cleanup was off or failed). */
  text: string;
  pinned?: boolean;
  /** Key release to text delivered, for the numbers in the README. */
  ms?: number;
}

export const DEFAULT_HISTORY_LIMIT = 200;

export class HistoryStore {
  private items: HistoryEntry[];

  constructor(
    items: HistoryEntry[] = [],
    private limit = DEFAULT_HISTORY_LIMIT,
  ) {
    this.items = [...items].sort((a, b) => b.at.localeCompare(a.at));
    this.trim();
  }

  setLimit(limit: number): void {
    this.limit = Math.max(1, Math.round(limit));
    this.trim();
  }

  /** Unpinned items beyond the limit are dropped, oldest first. */
  private trim(): void {
    let unpinned = 0;
    this.items = this.items.filter((e) => e.pinned || ++unpinned <= this.limit);
  }

  add(e: HistoryEntry): void {
    this.items.unshift(e);
    this.trim();
  }

  /** Pinned first, then newest first. */
  list(): HistoryEntry[] {
    return [...this.items.filter((e) => e.pinned), ...this.items.filter((e) => !e.pinned)];
  }

  latest(): HistoryEntry | undefined {
    return this.items[0];
  }

  get(id: string): HistoryEntry | undefined {
    return this.items.find((e) => e.id === id);
  }

  /** Every word of `query` must appear, in any case, in the text or the raw transcript. */
  filter(query: string): HistoryEntry[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return this.list();
    return this.list().filter((e) => {
      const hay = `${e.text}\n${e.raw}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }

  setPinned(id: string, pinned: boolean): void {
    const e = this.get(id);
    if (e) e.pinned = pinned || undefined;
    this.trim();
  }

  remove(id: string): void {
    this.items = this.items.filter((e) => e.id !== id);
  }

  /** Removes everything except pinned items. */
  clear(): void {
    this.items = this.items.filter((e) => e.pinned);
  }

  toJSON(): HistoryEntry[] {
    return this.items;
  }
}

/** "just now", "2 min ago", "3 h ago", "yesterday", "4 days ago", or a date. */
export function relativeTime(at: string, now: number): string {
  const s = Math.max(0, (now - Date.parse(at)) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
