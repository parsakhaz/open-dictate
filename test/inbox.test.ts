import { describe, expect, it } from 'vitest';
import { type Card, CardQueue, MAX_WAIT_MS } from '../src/core/cards';
import { isBusyState, TYPING_MS } from '../src/core/flowguard';

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
    target: null,
    createdAt: 1000 + n,
    ...over,
  };
}

describe('the flow guard', () => {
  it('holds a card that arrives within 6 s of a key-down, then shows it, and says so', () => {
    const q = new CardQueue();
    q.typed(10_000);
    const c = card();
    expect(q.add(c, 11_000)).toBe('held');
    expect(q.view(11_000).top).toBeNull();
    expect(q.view(11_000).extra).toMatchObject({ waiting: 1, reason: 'typing' });
    expect(q.focus(11_000)).toBe('focused');
    expect(q.nextDue(11_000)).toBe(10_000 + TYPING_MS);
    q.tick(10_000 + TYPING_MS);
    expect(q.view(10_000 + TYPING_MS).top?.id).toBe(c.id);
    expect(q.focus(10_000 + TYPING_MS)).toBe('free');
  });

  it('keeps a card already on screen when the person starts typing', () => {
    const q = new CardQueue();
    const c = card();
    q.add(c, 0);
    q.tick(0);
    q.typed(100);
    q.tick(200);
    expect(q.view(200).top?.id).toBe(c.id);
    // A newer card waits behind it, held.
    const later = card({ urgency: 'consent', kind: 'consent', key: 'consent:x' });
    expect(q.add(later, 300)).toBe('held');
    expect(q.view(300).top?.id).toBe(c.id);
  });

  it('holds new cards while Windows says the person is busy', () => {
    const q = new CardQueue();
    q.setBusy(true, 0);
    expect(q.add(card(), 0)).toBe('held');
    expect(q.view(0).extra).toMatchObject({ waiting: 1, reason: 'busy' });
    q.setBusy(false, 1);
    q.tick(1);
    expect(q.view(1).top).not.toBeNull();
  });

  it('reports a card held while the person dictates as held, with the talking reason', () => {
    const q = new CardQueue();
    q.setDictating(true, 0);
    expect(q.add(card(), 100)).toBe('held');
    expect(q.view(100).extra).toMatchObject({ waiting: 1, reason: 'talking' });
    expect(q.focus(100)).toBe('dictating');
  });

  it('reads the busy answers SHQueryUserNotificationState gives', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(isBusyState)).toEqual([false, true, true, true, false, false, true]);
  });
});

describe('held time and wait deadlines', () => {
  it('does not count time a card was held while the person dictated, before it was first on screen', () => {
    const q = new CardQueue();
    q.setDictating(true, 0);
    const c = card({ kind: 'ask', createdAt: 0 });
    q.add(c, 0);
    // Still held at the original deadline: it moves out.
    expect(q.deadline(c.id, 0, 30_000, 30_000)).toBe(60_000);
    q.setDictating(false, 40_000);
    q.tick(41_000);
    expect(q.deadline(c.id, 0, 30_000, 41_000)).toBe(71_000);
  });

  it('never runs past 600 s from the call', () => {
    const q = new CardQueue();
    q.setDictating(true, 0);
    const c = card({ kind: 'ask', createdAt: 0 });
    q.add(c, 0);
    expect(q.deadline(c.id, 0, 300_000, 500_000)).toBe(MAX_WAIT_MS);
  });

  it('a deadline that has passed marks the card expired for card_status', () => {
    const q = new CardQueue();
    const c = card({ kind: 'ask', createdAt: 0 });
    q.add(c, 0);
    q.tick(0);
    expect(q.deadline(c.id, 0, 10_000, 10_000)).toBe(10_000);
    q.remove(c.id);
    expect(q.status(c.id, 10_000)).toEqual({ state: 'expired' });
  });
});

describe('snooze', () => {
  it('puts a card away until its time, then brings it back on top marked back from snooze', () => {
    const q = new CardQueue();
    const a = card({ createdAt: 1 });
    const b = card({ createdAt: 2 });
    q.add(a, 0);
    q.add(b, 0);
    q.tick(0);
    expect(q.snooze(a.id, 300_000, 0)).toBe(true);
    let v = q.view(0);
    expect(v.top?.id).toBe(b.id);
    expect(v.all.map((c) => c.id)).toEqual([b.id]);
    expect(v.extra?.snoozed).toEqual([{ id: a.id, title: a.title, source: a.source, until: 300_000, since: 0 }]);
    expect(q.status(a.id, 1)).toEqual({ state: 'snoozed', until: 300_000 });
    expect(q.nextDue(1)).toBe(300_000);
    q.tick(300_000);
    v = q.view(300_000);
    expect(v.top?.id).toBe(a.id);
    expect(v.extra?.back).toEqual([a.id]);
  });

  it('a returning card waits in the inbox instead when the person chose that', () => {
    const q = new CardQueue();
    q.returnTo = 'inbox';
    const a = card();
    q.add(a, 0);
    q.snooze(a.id, 1000, 0);
    q.tick(1000);
    const v = q.view(1000);
    expect(v.top).toBeNull();
    expect(v.extra).toMatchObject({ waiting: 1 });
    expect(q.inbox().map((c) => c.id)).toEqual([a.id]);
  });

  it('never snoozes a consent card', () => {
    const q = new CardQueue();
    const c = card({ urgency: 'consent', kind: 'consent' });
    q.add(c, 0);
    expect(q.snooze(c.id, 1000, 0)).toBe(false);
  });

  it('waking a card early (Now, Undo) brings it back at once; Undo leaves no tag', () => {
    const q = new CardQueue();
    const a = card();
    q.add(a, 0);
    q.snooze(a.id, 300_000, 0);
    q.wake(a.id, 10, false);
    expect(q.view(10).top?.id).toBe(a.id);
    expect(q.view(10).extra?.back).toEqual([]);
  });

  it('snoozed time moves a waiting deadline out, within 600 s of the call', () => {
    const q = new CardQueue();
    const c = card({ kind: 'ask', createdAt: 0 });
    q.add(c, 0);
    q.tick(0);
    q.snooze(c.id, 180_000, 10_000);
    expect(q.deadline(c.id, 0, 60_000, 60_000)).toBe(60_000 + 50_000);
    q.tick(180_000);
    expect(q.deadline(c.id, 0, 60_000, 180_000)).toBe(60_000 + 170_000);
  });

  it('moving the clock forward (QA) brings snoozed cards back sooner', () => {
    const q = new CardQueue();
    const a = card();
    q.add(a, 0);
    q.snooze(a.id, 300_000, 0);
    q.advance(300_000);
    q.tick(1);
    expect(q.view(1).top?.id).toBe(a.id);
  });
});

describe('card status', () => {
  it('says held, shown, and gone for a card that has left', () => {
    const q = new CardQueue();
    q.setDictating(true, 0);
    const c = card();
    q.add(c, 0);
    expect(q.status(c.id, 0)).toEqual({ state: 'held' });
    q.setDictating(false, 0);
    q.tick(AFTER());
    expect(q.status(c.id, AFTER())).toEqual({ state: 'shown' });
    q.remove(c.id);
    expect(q.status(c.id, AFTER())).toEqual({ state: 'gone' });
    expect(q.status('nope', 0)).toBeNull();
  });

  it('says gone for a card the same session replaced, and keeps a card Pane merged into', () => {
    const q = new CardQueue();
    const a = card({ key: 'session:s1' });
    const b = card({ key: 'session:s1' });
    q.add(a, 0);
    expect(q.add(b, 0)).toBe('replaced');
    expect(q.status(a.id, 0)).toEqual({ state: 'gone' });
    expect(q.status(b.id, 0)).toEqual({ state: 'shown' });
    q.add(card({ key: 'session:s1', kind: 'pane-blocked', origin: 'pane' }), 0);
    expect(q.status(b.id, 0)).toEqual({ state: 'shown' });
  });

  it('remembers an answer the inbox saw', () => {
    const q = new CardQueue();
    const c = card();
    q.add(c, 0);
    q.ended(c.id, 'answered', { text: 'Staging', choice: 'Staging' });
    q.remove(c.id);
    expect(q.status(c.id, 0)).toEqual({ state: 'answered', answer: { text: 'Staging', choice: 'Staging' } });
  });
});

describe('the round', () => {
  it('hides the pill card while a round is open and parks an answered card until it is committed', () => {
    const q = new CardQueue();
    const a = card();
    q.add(a, 0);
    q.tick(0);
    q.setRound(true);
    expect(q.view(0).top).toBeNull();
    q.setRound(false);
    q.park(a.id, true);
    expect(q.view(0).top).toBeNull();
    expect(q.view(0).all).toEqual([]);
    q.park(a.id, false);
    expect(q.view(0).top?.id).toBe(a.id);
  });

  it('puts the round summary on top of everything else', () => {
    const q = new CardQueue();
    const a = card();
    q.add(a, 0);
    const s = card({ kind: 'round-summary', urgency: 'info', origin: 'dictate', key: 'round-summary' });
    q.add(s, 0);
    q.tick(0);
    expect(q.view(0).top?.id).toBe(s.id);
    // It doesn't fade like other info cards; the inbox takes it away.
    q.tick(60_000);
    expect(q.view(60_000).top?.id).toBe(s.id);
  });

  it('lists the cards a round takes: needs-you cards, oldest first, info and consent left out', () => {
    const q = new CardQueue();
    const fyi = card({ urgency: 'info', createdAt: 1 });
    const consent = card({ urgency: 'consent', kind: 'consent', createdAt: 2 });
    const older = card({ createdAt: 3 });
    const newer = card({ createdAt: 4 });
    for (const c of [newer, fyi, older, consent]) q.add(c, 0);
    expect(q.roundCards().map((c) => c.id)).toEqual([older.id, newer.id]);
  });
});

function AFTER(): number {
  return 5000;
}

it('CLI answer time starts when shown and pauses across snooze, quiet return and round Undo', () => {
  const q = new CardQueue();
  const blocker = card({ createdAt: 0 });
  const request = card({ kind: 'ask', createdAt: 1, requestOwned: true });
  q.add(blocker, 0);
  q.add(request, 1);
  q.tick(1);
  expect(q.deadline(request.id, 1, 120_000, 900_000, true)).toBe(1_020_000);
  q.remove(blocker.id);
  q.tick(900_000);
  q.snooze(request.id, 2_000_000, 910_000);
  q.returnTo = 'inbox';
  q.wake(request.id, 2_000_000);
  expect(q.deadline(request.id, 1, 120_000, 2_500_000, true)).toBe(2_610_000);
  q.unquiet(request.id, 2_500_000);
  q.park(request.id, true, 2_510_000);
  q.park(request.id, false, 2_520_000);
  expect(q.deadline(request.id, 1, 120_000, 2_530_000, true)).toBe(2_620_000);
  q.snooze(request.id, 90_000_000, 2_530_000);
  expect(q.deadline(request.id, 1, 120_000, 86_400_002, true)).toBe(86_400_001);
});

it('resumes a quiet CLI card budget while displayed in a round and pauses it again when the round closes', () => {
  const q = new CardQueue();
  const request = card({ kind: 'ask', createdAt: 0, requestOwned: true });
  q.add(request, 0);
  q.tick(0);
  q.snooze(request.id, 1200, 200);
  q.returnTo = 'inbox';
  q.wake(request.id, 1200);
  q.setRound(true);
  q.markShown(request.id, 1300);
  expect(q.deadline(request.id, 0, 1000, 1500, true)).toBe(2100);
  expect(q.deadline(request.id, 0, 1000, 1800, true)).toBe(2100);
  q.setRound(false, 1800);
  expect(q.deadline(request.id, 0, 1000, 2500, true)).toBe(2800);
});

it('pauses the outgoing quiet CLI card when a round moves to MCP, then resumes on returning to it', () => {
  const q = new CardQueue();
  const cli = card({ kind: 'ask', createdAt: 0, requestOwned: true });
  const mcp = card({ kind: 'ask', createdAt: 1 });
  q.add(cli, 0);
  q.tick(0);
  q.snooze(cli.id, 1200, 200);
  q.returnTo = 'inbox';
  q.wake(cli.id, 1200);
  q.add(mcp, 1250);
  q.setRound(true);
  q.markShown(cli.id, 1300);
  q.markShown(mcp.id, 1800);
  expect(q.deadline(cli.id, 0, 1000, 2500, true)).toBe(2800);
  q.setRound(false, 2500);
  expect(q.deadline(cli.id, 0, 1000, 3000, true)).toBe(3300);
  q.setRound(true);
  q.markShown(cli.id, 3100);
  expect(q.deadline(cli.id, 0, 1000, 3200, true)).toBe(3400);
});
