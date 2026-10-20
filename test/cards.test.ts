import { describe, expect, it } from 'vitest';
import { AFTER_DICTATION_MS, type Card, CardQueue, FADED_KEEP_MS, INFO_MS } from '../src/core/cards';

let n = 0;
function card(over: Partial<Card> = {}): Card {
  n++;
  return {
    id: `c${n}`,
    key: `tab:p${n}`,
    origin: 'agent',
    kind: 'notify',
    urgency: 'needs_you',
    source: 'repo · Codex',
    title: `card ${n}`,
    message: '',
    choices: [],
    target: { paneId: 'pane', panelId: `p${n}` },
    createdAt: 1000 + n,
    ...over,
  };
}

describe('CardQueue', () => {
  it('shows the most urgent, oldest card first, with the rest counted', () => {
    const q = new CardQueue();
    const finished = card({ urgency: 'info', kind: 'pane-ready', createdAt: 1 });
    const older = card({ createdAt: 2 });
    const newer = card({ createdAt: 3 });
    q.add(finished, 10);
    q.add(newer, 10);
    q.add(older, 10);
    const v = q.view(10);
    expect(v.top?.id).toBe(older.id);
    expect(v.more).toBe(2);
    expect(v.all.map((c) => c.id)).toEqual([older.id, newer.id, finished.id]);
  });

  it('keeps one card per tab: a newer card replaces the older one', () => {
    const q = new CardQueue();
    expect(q.add(card({ key: 'tab:x', title: 'first' }), 0)).toBe('shown');
    expect(q.add(card({ key: 'tab:x', title: 'second' }), 0)).toBe('replaced');
    expect(q.view(0).all.map((c) => c.title)).toEqual(['second']);
  });

  it('never lets "finished" hide a card that still needs the person', () => {
    const q = new CardQueue();
    q.add(card({ key: 'tab:x', title: 'Needs your input', kind: 'pane-blocked' }), 0);
    q.add(card({ key: 'tab:x', title: 'Finished', kind: 'pane-ready', urgency: 'info' }), 0);
    expect(q.view(0).all.map((c) => c.title)).toEqual(['Needs your input']);
  });

  it("keeps the agent's headline when its tab then becomes blocked, and offers Reply", () => {
    const q = new CardQueue();
    const mine = card({ key: 'tab:x', title: 'Approve the migration?', urgency: 'info', target: null });
    q.add(mine, 0);
    q.add(card({ key: 'tab:x', origin: 'pane', kind: 'pane-blocked', title: 'Needs your input', target: { paneId: 'P', panelId: 'x' } }), 0);
    const v = q.view(0);
    expect(v.all).toHaveLength(1);
    expect(v.top).toMatchObject({ id: mine.id, title: 'Approve the migration?', urgency: 'needs_you', kind: 'pane-blocked', target: { panelId: 'x' } });
  });

  it('three blocked tabs show as one card with +2', () => {
    const q = new CardQueue();
    for (const t of ['a', 'b', 'c']) q.add(card({ key: `tab:${t}`, kind: 'pane-blocked', origin: 'pane' }), 0);
    expect(q.view(0).more).toBe(2);
  });

  it('holds new cards while the person dictates, and for a second after', () => {
    const q = new CardQueue();
    q.setDictating(true, 0);
    expect(q.add(card(), 100)).toBe('queued');
    expect(q.view(100).top).toBeNull();
    q.setDictating(false, 5000);
    expect(q.view(5000 + AFTER_DICTATION_MS - 1).top).toBeNull();
    expect(q.nextDue(5000)).toBe(5000 + AFTER_DICTATION_MS);
    expect(q.view(5000 + AFTER_DICTATION_MS).top).not.toBeNull();
  });

  it('pausing alerts holds everything and reports dnd; unpausing shows what still needs the person', () => {
    const q = new CardQueue();
    q.setPaused(true);
    expect(q.add(card({ title: 'needs' }), 0)).toBe('dnd');
    expect(q.add(card({ title: 'fyi', urgency: 'info' }), 0)).toBe('dnd');
    expect(q.view(0).top).toBeNull();
    expect(q.waiting).toBe(2);
    q.setPaused(false);
    expect(q.view(0).all.map((c) => c.title)).toEqual(['needs']);
  });

  it('fades an info card a few seconds after it appears, and later forgets it', () => {
    const q = new CardQueue();
    const fyi = card({ urgency: 'info', createdAt: 0 });
    q.add(fyi, 0);
    q.tick(0);
    expect(q.view(INFO_MS - 1).top?.id).toBe(fyi.id);
    expect(q.nextDue(1)).toBe(INFO_MS);
    expect(q.tick(INFO_MS)).toBe(true);
    expect(q.view(INFO_MS).top).toBeNull();
    expect(q.view(INFO_MS).all).toHaveLength(1);
    q.tick(FADED_KEEP_MS + 1);
    expect(q.view(FADED_KEEP_MS + 1).all).toHaveLength(0);
  });

  it('shows an info card for about 4.5 s', () => {
    const q = new CardQueue();
    const fyi = card({ urgency: 'info' });
    q.add(fyi, 0);
    q.tick(0);
    q.tick(4400);
    expect(q.view(4400).top?.id).toBe(fyi.id);
    q.tick(4500);
    expect(q.view(4500).top).toBeNull();
  });

  it('pauses an info card while the pointer is over it, then gives it the rest of its time', () => {
    const q = new CardQueue();
    const fyi = card({ urgency: 'info' });
    q.add(fyi, 0);
    q.tick(0);
    q.setHovered(true, 1000);
    expect(q.nextDue(1000)).toBeNull();
    q.tick(30_000);
    expect(q.view(30_000).top?.id).toBe(fyi.id);
    q.setHovered(false, 30_000);
    // 1 s had passed before the hover: 3.5 s are left.
    expect(q.nextDue(30_000)).toBe(33_500);
    q.tick(33_499);
    expect(q.view(33_499).top?.id).toBe(fyi.id);
    q.tick(33_500);
    expect(q.view(33_500).top).toBeNull();
  });

  it('gives an info card at least 2 s more after the pointer leaves it, however little time it had left', () => {
    const q = new CardQueue();
    const fyi = card({ urgency: 'info' });
    q.add(fyi, 0);
    q.tick(0);
    // Pointed at with 0.3 s left.
    q.setHovered(true, 4200);
    q.tick(9000);
    expect(q.view(9000).top?.id).toBe(fyi.id);
    q.setHovered(false, 9000);
    expect(q.nextDue(9000)).toBe(11_000);
    q.tick(10_999);
    expect(q.view(10_999).top?.id).toBe(fyi.id);
    q.tick(11_000);
    expect(q.view(11_000).top).toBeNull();
  });

  it('keeps the vocabulary card until it is reviewed or dismissed, also across a pause', () => {
    const q = new CardQueue();
    const vocab = card({ kind: 'vocab', urgency: 'info', origin: 'dictate', key: 'vocab:s1' });
    q.add(vocab, 0);
    q.tick(0);
    q.tick(10 * 60_000);
    expect(q.view(10 * 60_000).top?.id).toBe(vocab.id);
    expect(q.nextDue(10 * 60_000)).toBeNull();
    q.setPaused(true);
    q.setPaused(false);
    expect(q.view(10 * 60_000).top?.id).toBe(vocab.id);
  });

  it('keeps the card being answered by voice on screen while the person dictates, and holds the rest', () => {
    const q = new CardQueue();
    const ask = card({ kind: 'ask', title: 'Staging or prod?' });
    q.add(ask, 0);
    q.setDictating(true, 100, ask.id);
    expect(q.view(100).top?.id).toBe(ask.id);
    expect(q.replyingTo).toBe(ask.id);
    const urgent = card({ urgency: 'consent', kind: 'consent', key: 'consent:1' });
    expect(q.add(urgent, 200)).toBe('queued');
    expect(q.view(200).top?.id).toBe(ask.id);
    // Released and still there (the reply was cancelled): no pause before the cards come back.
    q.setDictating(false, 5000);
    expect(q.replyingTo).toBeNull();
    expect(q.view(5000).top?.id).toBe(urgent.id);
  });

  it('never fades an info card while it is being answered by voice', () => {
    const q = new CardQueue();
    const done = card({ kind: 'pane-ready', urgency: 'info' });
    q.add(done, 0);
    q.tick(0);
    q.setDictating(true, 1000, done.id);
    q.tick(20_000);
    expect(q.view(20_000).top?.id).toBe(done.id);
  });

  it('keeps "needs you" cards until they are handled', () => {
    const q = new CardQueue();
    const c = card();
    q.add(c, 0);
    q.tick(10 * 60_000);
    expect(q.view(10 * 60_000).top?.id).toBe(c.id);
    expect(q.remove(c.id)?.id).toBe(c.id);
    expect(q.view(0).top).toBeNull();
  });

  it('puts history consent above everything else', () => {
    const q = new CardQueue();
    q.add(card({ createdAt: 1 }), 0);
    const consent = card({ urgency: 'consent', kind: 'consent', key: 'consent:1', createdAt: 9 });
    q.add(consent, 0);
    expect(q.view(0).top?.id).toBe(consent.id);
  });
});
