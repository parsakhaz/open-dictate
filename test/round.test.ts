import { describe, expect, it } from 'vitest';
import { parseCommand, Round, type RoundResult, sentAnswer, snoozeLength, summaryLine } from '../src/core/round';

const L = [3, 5, 10];

describe('spoken round commands', () => {
  it('reads a whole utterance of approve, next, skip, open or done as a command', () => {
    expect(parseCommand('Approve.')).toEqual({ type: 'approve' });
    expect(parseCommand('next')).toEqual({ type: 'skip' });
    expect(parseCommand('Skip it, please')).toEqual({ type: 'skip' });
    expect(parseCommand('Open')).toEqual({ type: 'open' });
    expect(parseCommand("That's all.")).toEqual({ type: 'end' });
  });

  it("snoozes for the card's next length, or the one said", () => {
    expect(parseCommand('Snooze.')).toEqual({ type: 'snooze' });
    expect(parseCommand('snooze ten')).toEqual({ type: 'snooze', minutes: 10 });
    expect(parseCommand('Snooze for 20 minutes')).toEqual({ type: 'snooze', minutes: 20 });
    expect(parseCommand('snooze twenty five')).toEqual({ type: 'snooze', minutes: 25 });
    expect(parseCommand('Later.')).toEqual({ type: 'snooze' });
    expect(parseCommand('snooze a thousand')).toBeNull();
  });

  it('a bare number one to four picks that choice', () => {
    expect(parseCommand('Two.')).toEqual({ type: 'choose', n: 2 });
    expect(parseCommand('option 4')).toEqual({ type: 'choose', n: 4 });
    expect(parseCommand('five')).toBeNull();
  });

  it('anything else is the answer', () => {
    expect(parseCommand('Approve it but only on staging')).toBeNull();
    expect(parseCommand('behind a link')).toBeNull();
    expect(parseCommand('next week')).toBeNull();
  });
});

describe("a card's snooze length", () => {
  it('is 3 the first time, then 5, then 10 from then on', () => {
    expect([0, 1, 2, 3, 7].map((n) => snoozeLength(L, n))).toEqual([3, 5, 10, 10, 10]);
  });
});

const r = (id: string, action: RoundResult['action'], extra: Partial<RoundResult> = {}): RoundResult => ({ id, action, title: id, tab: 't', ...extra });

describe('Round', () => {
  it('goes through the cards in order with "n of m" and chips', () => {
    const round = new Round(['a', 'b', 'c'], 0);
    expect(round.current()).toBe('a');
    round.act(r('a', 'approved'));
    expect(round.position()).toEqual({ n: 2, of: 3 });
    expect(round.chips().map((c) => c.state)).toEqual(['done', 'now', 'next']);
    round.act(r('b', 'skipped'));
    round.act(r('c', 'snoozed'));
    expect(round.done()).toBe(true);
  });

  it('Undo takes back the last action and puts its card in front again', () => {
    const round = new Round(['a', 'b'], 0);
    round.act(r('a', 'approved'));
    round.act(r('b', 'snoozed'));
    expect(round.undo()?.id).toBe('b');
    expect(round.current()).toBe('b');
    expect(round.done()).toBe(false);
  });

  it('a chip brings its card forward; cards that arrive join the end; a card that left is passed', () => {
    const round = new Round(['a', 'b', 'c'], 0);
    round.jump('c');
    expect(round.current()).toBe('c');
    round.add(['d', 'a']);
    expect(round.chips().map((c) => c.id)).toEqual(['c', 'a', 'b', 'd']);
    round.drop('c');
    expect(round.current()).toBe('a');
  });
});

describe('the round summary', () => {
  it('counts what the round did, with the time a snoozed card comes back', () => {
    const line = summaryLine([r('a', 'approved'), r('b', 'approved'), r('c', 'approved'), r('d', 'answered'), r('e', 'snoozed', { until: 1 })], () => '14:45');
    expect(line).toBe('Round done: 3 approved, 1 answered, 1 snoozed until 14:45');
    expect(summaryLine([], () => '')).toBe('Round done: nothing changed');
  });

  it('writes the answer each card sent: a choice, words, an approval or every question of a decision', () => {
    expect(sentAnswer({ choice: 'Run it' })).toBe('Run it');
    expect(sentAnswer({ text: 'Under the summary' })).toBe('Under the summary');
    expect(sentAnswer({ approved: true })).toBe('Approved');
    expect(sentAnswer({ approved: false, changes: 'Only on staging' })).toBe('Only on staging');
    const answers = [
      { id: 'env', header: 'Target', picked: ['Staging'] },
      { id: 'q2', header: 'Notify', picked: ['Charged twice', 'Charge failed'] },
      { id: 'q3', header: 'Policy', picked: [], other: 'Retry twice' },
    ];
    expect(sentAnswer({ answers })).toBe('Target: Staging · Notify: Charged twice, Charge failed · Policy: Retry twice');
    expect(sentAnswer({ answers: [answers[0]] })).toBe('Staging');
    expect(sentAnswer(undefined)).toBeUndefined();
  });
});
