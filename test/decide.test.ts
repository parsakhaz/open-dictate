// Decision sheets and approval cards (L1): the agents' arguments checked, a spoken sentence matched onto the
// questions, and the card's answers as they go back.
import { describe, expect, it } from 'vitest';
import { ToolInputError } from '../src/core/agenttools';
import { answeredCount, answersOut, applyVoice, complete, newDecide, pick, setOther } from '../src/core/decidecard';
import { isApproval, matchAnswers } from '../src/core/decidematch';
import { approve, parseApprove } from '../src/core/tools/approve';
import { cleanPreview, decide, parseDecide } from '../src/core/tools/decide';

const opts = (...labels: string[]) => labels.map((label) => ({ label }));
const three = () =>
  parseDecide({
    title: 'Three calls before I ship the retry fix',
    questions: [
      { id: 'env', header: 'Target', question: 'Where should the fix go first?', options: opts('Staging', 'Production') },
      { header: 'Policy', question: 'How should failed charges retry?', options: opts('Backoff ×3', 'Once + email', "Don't retry") },
      { header: 'Notify', question: 'Who gets an apology email?', options: opts('Charged twice', 'Charge failed', 'Nobody'), multi: true },
    ],
  });

describe('decide arguments', () => {
  it('is turned on, as is approve', () => {
    expect(decide.enabled).toBe(true);
    expect(approve.enabled).toBe(true);
  });

  it('cleans every field, gives questions ids, and defaults to 300 s, at most 600', () => {
    const a = three();
    expect(a.questions.map((q) => q.id)).toEqual(['env', 'q2', 'q3']);
    expect(a.questions[2]).toMatchObject({ multi: true, other: true });
    expect(a.timeoutS).toBe(300);
    expect(a.previews).toBe(false);
    expect(parseDecide({ title: 't', questions: [{ header: 'h', question: 'q', options: opts('a', 'b') }], timeout_s: 9999 }).timeoutS).toBe(600);
    const dirty = parseDecide({ title: '<b>Ship</b>\u001b[31m it', questions: [{ header: 'A very long header', question: 'q', options: [{ label: 'x', description: 'd'.repeat(200) }, { label: 'y' }], other: false }] });
    expect(dirty.title).toBe('Ship it');
    expect(dirty.questions[0].header.length).toBeLessThanOrEqual(12);
    expect(dirty.questions[0].options[0].description.length).toBe(80);
    expect(dirty.questions[0].other).toBe(false);
    expect(dirty.truncated).toBe(true);
  });

  it('refuses no title, no questions, more than four, and fewer than two different options', () => {
    const q = { header: 'h', question: 'q', options: opts('a', 'b') };
    expect(() => parseDecide({ questions: [q] })).toThrow(ToolInputError);
    expect(() => parseDecide({ title: 't', questions: [] })).toThrow(/one to four/);
    expect(() => parseDecide({ title: 't', questions: [q, q, q, q, q] })).toThrow(/at most four/);
    expect(() => parseDecide({ title: 't', questions: [{ ...q, options: opts('Same', 'same') }] })).toThrow(/two to four/);
    expect(() => parseDecide({ title: 't', questions: [{ ...q, options: opts('a', 'b', 'c', 'd', 'e') }] })).toThrow(/more than four/);
  });

  it('keeps a preview as text with its lines and indentation, without escape codes, cut at 1,200 characters', () => {
    expect(cleanPreview({ kind: 'code', content: '\n- a = 1;\n+ a = {\n\tb: 2,\u001b[0m\n};\n\n' })).toEqual({ kind: 'code', content: '- a = 1;\n+ a = {\n  b: 2,\n};' });
    expect(cleanPreview({ kind: 'html', content: '<b>x</b>' })).toEqual({ kind: 'text', content: '<b>x</b>' });
    expect(cleanPreview({ kind: 'text', content: 'x'.repeat(2000) })?.content.length).toBe(1200);
    expect(cleanPreview({ kind: 'code' })).toBeNull();
    const a = parseDecide({ title: 't', questions: [{ header: 'h', question: 'q', options: [{ label: 'a', preview: { kind: 'code', content: 'x' } }, { label: 'b' }] }] });
    expect(a.previews).toBe(true);
  });
});

describe('approve arguments', () => {
  it('keeps six lines of plan, the risk, an https link, and waits 600 s by default', () => {
    const a = parseApprove({ title: 'Approve the plan', summary: ['one', '', 'two', 'three', 'four', 'five', 'six', 'seven'], risk: 'high', link: 'https://example.com/plan' });
    expect(a.summary).toEqual(['one', 'two', 'three', 'four', 'five', 'six']);
    expect(a).toMatchObject({ risk: 'high', link: { host: 'example.com' }, timeoutS: 600, truncated: true });
    expect(parseApprove({ title: 'x', risk: 'extreme' }).risk).toBeNull();
    expect(() => parseApprove({ title: 'x', link: 'http://example.com' })).toThrow(/https/);
    expect(() => parseApprove({ summary: ['x'] })).toThrow(/title/);
  });
});

describe('matching one sentence onto the questions', () => {
  const qs = three().questions;
  const none = [false, false, false];

  it('fills two questions from "staging, and once then email", leaving the third open', () => {
    expect(matchAnswers('Staging, and once, then email.', qs, none)).toEqual({ fills: [{ q: 0, picked: ['Staging'] }, { q: 1, picked: ['Once + email'] }] });
  });

  it('takes ordinals and numbers for the next unanswered question, in the order said', () => {
    expect(matchAnswers('the second one, then 3', qs, none).fills).toEqual([{ q: 0, picked: ['Production'] }, { q: 1, picked: ["Don't retry"] }]);
    expect(matchAnswers('option two', qs, [true, false, false]).fills).toEqual([{ q: 1, picked: ['Once + email'] }]);
    // "first" on its own is just a word ("staging first"), not the first option.
    expect(matchAnswers('staging first', qs, none).fills).toEqual([{ q: 0, picked: ['Staging'] }]);
  });

  it('collects several labels for a pick-any question, and number words in labels', () => {
    expect(matchAnswers('email the ones charged twice and the charge failed ones', qs, none).fills).toEqual([{ q: 2, picked: ['Charged twice', 'Charge failed'] }]);
    expect(matchAnswers('backoff three times', qs, none).fills).toEqual([{ q: 1, picked: ['Backoff ×3'] }]);
  });

  it('maps yes and no onto options that start with them', () => {
    const yn = parseDecide({ title: 't', questions: [{ header: 'Run', question: 'Run it?', options: opts('Yes, now', 'No') }, { header: 'Tell', question: 'Tell them?', options: opts('Yes', 'No') }] }).questions;
    expect(matchAnswers('yeah, and no', yn, [false, false]).fills).toEqual([{ q: 0, picked: ['Yes, now'] }, { q: 1, picked: ['No'] }]);
  });

  it('gives words that match nothing to the first open question that takes other', () => {
    expect(matchAnswers('ask legal first', qs, [true, false, false])).toEqual({ fills: [], other: { q: 1, text: 'ask legal first' } });
    const closed = qs.map((q) => ({ ...q, other: false }));
    expect(matchAnswers('ask legal first', closed, none)).toEqual({ fills: [] });
  });
});

describe('approval words', () => {
  it('approves only on words that do nothing but approve', () => {
    for (const t of ['Approve.', 'go ahead', 'Yes, looks good, thanks', 'OK', 'ship it please', 'LGTM']) expect(isApproval(t)).toBe(true);
    for (const t of ['Keep it to two retries and skip the email.', 'approve but skip the backfill', 'no', 'wait']) expect(isApproval(t)).toBe(false);
  });
});

describe('the decision card', () => {
  it('picks one per question, toggles a pick-any one, and returns answers in order', () => {
    let d = newDecide(three().questions, false);
    d = pick(d, 0, 'Staging', 'click');
    d = pick(d, 0, 'Production', 'click');
    d = pick(d, 2, 'Nobody', 'click');
    d = pick(d, 2, 'Charged twice', 'click');
    d = pick(d, 2, 'Nobody', 'click');
    d = pick(d, 1, 'Not an option', 'click');
    expect(answeredCount(d)).toBe(2);
    expect(complete(d)).toBe(false);
    expect(answersOut(d)).toEqual([
      { id: 'env', header: 'Target', picked: ['Production'] },
      { id: 'q2', header: 'Policy', picked: [] },
      { id: 'q3', header: 'Notify', picked: ['Charged twice'] },
    ]);
    expect(answersOut(d, true).map((a) => a.id)).toEqual(['env', 'q3']);
  });

  it('fills by voice, flashes what it filled, keeps raw, and takes other words for a chosen question', () => {
    const d0 = newDecide(three().questions, false);
    const { data } = applyVoice(d0, 'staging, and once then email', 'uh staging and once then email', 1000);
    expect(data.answers.slice(0, 2)).toEqual([{ picked: ['Staging'], via: 'voice' }, { picked: ['Once + email'], via: 'voice' }]);
    expect(data.flash).toEqual({ qs: [0, 1], at: 1000 });
    expect(data.raw).toBe('uh staging and once then email');
    const other = applyVoice(data, 'only the enterprise ones', 'raw', 2000, 2).data;
    expect(answersOut(other)[2]).toEqual({ id: 'q3', header: 'Notify', picked: [], other: 'only the enterprise ones' });
    expect(complete(other)).toBe(true);
    expect(setOther(other, 0, '   ', 'click')).toBe(other);
  });
});
