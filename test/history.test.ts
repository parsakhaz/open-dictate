import { describe, expect, it } from 'vitest';
import { type HistoryEntry, HistoryStore, relativeTime } from '../src/core/history';

function entry(i: number, text = `item ${i}`, raw = text): HistoryEntry {
  return { id: `id${i}`, at: new Date(Date.UTC(2026, 9, 18, 0, i)).toISOString(), raw, text };
}

describe('HistoryStore', () => {
  it('lists newest first', () => {
    const h = new HistoryStore();
    h.add(entry(1));
    h.add(entry(2));
    expect(h.list().map((e) => e.id)).toEqual(['id2', 'id1']);
    expect(h.latest()?.id).toBe('id2');
  });

  it('keeps only the last N unpinned items', () => {
    const h = new HistoryStore([], 3);
    for (let i = 1; i <= 5; i++) h.add(entry(i));
    expect(h.list().map((e) => e.id)).toEqual(['id5', 'id4', 'id3']);
  });

  it('keeps pinned items on top and never evicts them', () => {
    const h = new HistoryStore([], 2);
    h.add(entry(1));
    h.setPinned('id1', true);
    for (let i = 2; i <= 6; i++) h.add(entry(i));
    expect(h.list().map((e) => e.id)).toEqual(['id1', 'id6', 'id5']);
    h.setPinned('id1', false);
    expect(h.list().map((e) => e.id)).toEqual(['id6', 'id5']);
  });

  it('filters on every word, case-insensitive, across cleaned and raw text', () => {
    const h = new HistoryStore([entry(1, 'Ship the Pane release', 'ship the pain release'), entry(2, 'Lunch at noon'), entry(3, 'Pane notes for Doozy')]);
    expect(h.filter('pane').map((e) => e.id)).toEqual(['id3', 'id1']);
    expect(h.filter('PANE doozy').map((e) => e.id)).toEqual(['id3']);
    expect(h.filter('pain').map((e) => e.id)).toEqual(['id1']);
    expect(h.filter('  ').length).toBe(3);
  });

  it('deletes one item, and clear keeps pinned ones', () => {
    const h = new HistoryStore([entry(1), entry(2), entry(3)]);
    h.remove('id2');
    h.setPinned('id1', true);
    expect(h.list().map((e) => e.id)).toEqual(['id1', 'id3']);
    h.clear();
    expect(h.list().map((e) => e.id)).toEqual(['id1']);
  });

  it('applies a lower limit at once and sorts loaded items', () => {
    const h = new HistoryStore([entry(1), entry(3), entry(2)]);
    expect(h.list().map((e) => e.id)).toEqual(['id3', 'id2', 'id1']);
    h.setLimit(1);
    expect(h.list().map((e) => e.id)).toEqual(['id3']);
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  it('reads like Windows clipboard history', () => {
    expect(relativeTime('2026-10-18T11:59:50Z', now)).toBe('just now');
    expect(relativeTime('2026-10-18T11:58:00Z', now)).toBe('2 min ago');
    expect(relativeTime('2026-10-18T09:00:00Z', now)).toBe('3 h ago');
    expect(relativeTime('2026-10-17T10:00:00Z', now)).toBe('yesterday');
    expect(relativeTime('2026-10-14T12:00:00Z', now)).toBe('4 days ago');
  });
});
