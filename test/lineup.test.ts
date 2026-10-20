import { describe, expect, it } from 'vitest';
import { ToolInputError } from '../src/core/agenttools';
import { isListed } from '../src/core/tools';
import { answerFor, looksLikeUrl, parseLineup } from '../src/core/tools/lineup';
import { spokenPicks } from '../src/core/tools/lineupvoice';

const four = [
  { id: 'a', label: 'Centred', image: 'C:/work/a.png' },
  { id: 'b', label: 'Split', image: 'C:/work/b.png' },
  { id: 'c', label: 'Photo', image: 'C:/work/c.png' },
  { id: 'd', label: 'Bold type', caption: 'Loud yellow', image: 'C:/work/d.png' },
];

describe('lineup arguments', () => {
  it('is listed by the bridge', () => {
    expect(isListed('lineup')).toBe(true);
  });

  it('keeps ids, labels and paths, and defaults to many picks over 600 s', () => {
    const a = parseLineup({ title: 'Pick a hero', candidates: four });
    expect(a.candidates.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(a.candidates[3]).toEqual({ id: 'd', label: 'Bold type', caption: 'Loud yellow', image: 'C:/work/d.png' });
    expect(a).toMatchObject({ pick: 'many', max: 4, timeoutS: 600, truncated: false });
  });

  it('cleans agent text: tags, control characters, caps', () => {
    const a = parseLineup({ title: '<b>Pick</b>\u0007 one', candidates: [{ id: 'x', label: 'A very long label that goes on and on', text: 'Copy\nvariant' }, { id: 'y', label: 'B', text: 'Other' }] });
    expect(a.title).toBe('Pick one');
    expect(a.candidates[0].label.length).toBeLessThanOrEqual(24);
    expect(a.candidates[0].text).toBe('Copy\nvariant');
    expect(a.truncated).toBe(true);
  });

  it('refuses too few or too many candidates, duplicate ids, both or neither of image and text', () => {
    const bad = [
      { title: 'x', candidates: four.slice(0, 1) },
      { title: 'x', candidates: [...four, ...four.map((c) => ({ ...c, id: `${c.id}2` }))].slice(0, 7) },
      { title: 'x', candidates: [four[0], { ...four[1], id: 'a' }] },
      { title: 'x', candidates: [four[0], { id: 'b', label: 'B' }] },
      { title: 'x', candidates: [four[0], { id: 'b', label: 'B', image: 'b.png', text: 'b' }] },
      { title: '', candidates: four },
    ];
    for (const b of bad) expect(() => parseLineup(b)).toThrow(ToolInputError);
  });

  it('refuses remote images and URL candidates', () => {
    for (const image of ['https://example.com/a.png', 'http://localhost:5173/a.png', 'file:///C:/a.png', 'data:image/png;base64,AAAA']) {
      expect(() => parseLineup({ title: 'x', candidates: [four[0], { id: 'b', label: 'B', image }] })).toThrow(/local files/);
    }
    expect(() => parseLineup({ title: 'x', candidates: [four[0], { id: 'b', label: 'B', url: 'http://localhost/' }] })).toThrow(/URL candidates/);
  });

  it('tells Windows drives and relative paths from URLs', () => {
    expect(looksLikeUrl('C:\\work\\a.png')).toBe(false);
    expect(looksLikeUrl('C:/work/a.png')).toBe(false);
    expect(looksLikeUrl('mockups/a.png')).toBe(false);
    expect(looksLikeUrl('https://x/a.png')).toBe(true);
  });

  it('one means at most one pick; max is kept within the candidates', () => {
    expect(parseLineup({ title: 'x', candidates: four, pick: 'one', max: 3 }).max).toBe(1);
    expect(parseLineup({ title: 'x', candidates: four, max: 9 }).max).toBe(4);
    expect(parseLineup({ title: 'x', candidates: four, pick: 'rank', max: 2 })).toMatchObject({ pick: 'rank', max: 2 });
    expect(parseLineup({ title: 'x', candidates: four, timeout_s: 5000 }).timeoutS).toBe(600);
  });
});

describe('lineup answers', () => {
  const args = parseLineup({ title: 'x', candidates: four });

  it('returns ids in the order picked, ranked when there are several', () => {
    expect(answerFor(args, [1, 3])).toEqual({ answered: true, picks: ['b', 'd'], ranked: true });
    expect(answerFor(args, [3])).toEqual({ answered: true, picks: ['d'], ranked: false });
  });

  it('drops repeats and unknown indexes, and stops at max', () => {
    expect(answerFor({ ...args, max: 2 }, [3, 3, 9, -1, 0, 1]).picks).toEqual(['d', 'a']);
  });

  it('no picks is a "none of these", with what was said', () => {
    expect(answerFor(args, [], { comment: 'too busy', raw: 'none of these, too busy' })).toEqual({ answered: true, picks: [], ranked: false, none: true, comment: 'too busy', raw: 'none of these, too busy' });
  });

  it('one is never ranked', () => {
    expect(answerFor({ ...args, pick: 'one', max: 1 }, [2, 1])).toEqual({ answered: true, picks: ['c'], ranked: false });
  });
});

describe('spoken picks', () => {
  const labels = ['Centred', 'Split', 'Photo', 'Bold type'];
  const say = (t: string) => spokenPicks(t, labels);

  it('numbers in the order said', () => {
    expect(say('two and four')).toEqual({ picks: [1, 3], none: false, comment: '' });
    expect(say('Four and two.')).toEqual({ picks: [3, 1], none: false, comment: '' });
    expect(say('2 and 4')).toEqual({ picks: [1, 3], none: false, comment: '' });
  });

  it('"X first" moves X to the front', () => {
    expect(say('two and four, four first').picks).toEqual([3, 1]);
    expect(say('two and four, two first').picks).toEqual([1, 3]);
  });

  it('labels and ordinals', () => {
    expect(say('bold type and split').picks).toEqual([3, 1]);
    expect(say("I'd go with the second one").picks).toEqual([1]);
    expect(say('first and third').picks).toEqual([0, 2]);
  });

  it('what is not a pick becomes the comment', () => {
    expect(say("two and four, make two's button bigger")).toEqual({ picks: [1, 3], none: false, comment: "make two's button bigger" });
    expect(say('four but the headline is too loud')).toEqual({ picks: [3], none: false, comment: 'the headline is too loud' });
    expect(say('three make it warmer')).toEqual({ picks: [2], none: false, comment: 'make it warmer' });
  });

  it('none of these, with why', () => {
    expect(say('None of these, too busy, try calmer')).toEqual({ picks: [], none: true, comment: 'too busy, try calmer' });
    expect(say('neither')).toEqual({ picks: [], none: true, comment: '' });
  });

  it('numbers beyond the lineup and words alone are no picks', () => {
    expect(say('six')).toEqual({ picks: [], none: false, comment: 'six' });
    expect(say('they all look the same')).toEqual({ picks: [], none: false, comment: 'they all look the same' });
  });
});
