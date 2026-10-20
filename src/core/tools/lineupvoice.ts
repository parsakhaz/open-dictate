// One spoken sentence over a lineup: "two and four, two first", "bold type", "none of these, too busy". Numbers, the
// candidates' labels and ordinals are picks in the order said; "X first" moves X to the front; "none" or "neither"
// is a no. The words that aren't picks come back as the comment. Deterministic, like decide's matcher (its own copy,
// so the lanes stay apart). Pure.

export interface SpokenPicks {
  /** Candidate indexes, in the order said. */
  picks: number[];
  /** "None of these", "neither". */
  none: boolean;
  /** What else was said, in the person's words. */
  comment: string;
}

const NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5, '6th': 6 };
const NONE = new Set(['none', 'neither', 'nothing', 'no']);
// Words that can sit between picks without being a comment: "I'd go with two and the fourth one, please".
const FILLER = new Set(
  'and then plus also the a an for number option options candidate candidates one ones i id i’d like want pick picks take keep go with both please ok okay star send those them these of me would choose prefer lets let’s let us my favourite favourites favorite favorites are is top it all'
    .split(' ')
    .concat(["i'd", "let's"]),
);

type Token = { kind: 'pick'; n: number } | { kind: 'ordinal'; n: number } | { kind: 'none' } | { kind: 'filler' } | { kind: 'word' };

const norm = (w: string) => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}’']+$/gu, '');

/** Splits on the punctuation that ends a thought; "and" and "then" stay inside. */
function clauses(text: string): string[] {
  return text
    .split(/[,.;:!?\n]+|\s+(?:but|although|though)\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tokens(words: string[], labels: string[][], count: number): { tok: Token; from: number; to: number }[] {
  const out: { tok: Token; from: number; to: number }[] = [];
  const lower = words.map(norm);
  for (let i = 0; i < words.length; ) {
    // The longest label that starts here.
    let hit = -1;
    let len = 0;
    labels.forEach((l, li) => {
      if (l.length > len && l.every((w, k) => lower[i + k] === w)) {
        hit = li;
        len = l.length;
      }
    });
    if (hit >= 0) {
      out.push({ tok: { kind: 'pick', n: hit + 1 }, from: i, to: i + len });
      i += len;
      continue;
    }
    const w = lower[i];
    const num = /^\d+$/.test(w) ? Number(w) : NUMBERS[w];
    let tok: Token;
    if (num !== undefined && num >= 1 && num <= count && !(w === 'one' && out.at(-1)?.tok.kind === 'ordinal')) tok = { kind: 'pick', n: num };
    else if (ORDINALS[w] !== undefined) tok = { kind: 'ordinal', n: ORDINALS[w] };
    else if (NONE.has(w)) tok = { kind: 'none' };
    else if (FILLER.has(w) || w === '') tok = { kind: 'filler' };
    else tok = { kind: 'word' };
    out.push({ tok, from: i, to: i + 1 });
    i++;
  }
  return out;
}

/** The picks and the comment in what the person said over a lineup of `labels` (in order). */
export function spokenPicks(text: string, labels: string[]): SpokenPicks {
  const count = labels.length;
  const labelWords = labels.map((l) => l.split(/\s+/).map(norm).filter(Boolean)).map((l) => (l.length ? l : ['\u0000']));
  const picks: number[] = [];
  const front: number[] = [];
  let none = false;
  const comment: string[] = [];
  for (const clause of clauses(text)) {
    const words = clause.split(/\s+/);
    const toks = tokens(words, labelWords, count);
    // The picks are the clause's leading run of picks, ordinals, "none" and filler; what follows is a comment.
    let end = 0;
    while (end < toks.length && toks[end].tok.kind !== 'word') end++;
    const run = toks.slice(0, end);
    const said = run.some((t) => t.tok.kind === 'pick' || t.tok.kind === 'none' || (t.tok.kind === 'ordinal' && t.tok.n <= count));
    if (!said) {
      comment.push(clause);
      continue;
    }
    run.forEach((t, k) => {
      const prev = run[k - 1]?.tok;
      if (t.tok.kind === 'pick') picks.push(t.tok.n);
      else if (t.tok.kind === 'none') none = true;
      // "two first": two goes to the front. "the second one", "first": the candidate itself.
      else if (t.tok.kind === 'ordinal') {
        if (prev?.kind === 'pick') {
          if (t.tok.n === 1) front.push(prev.n);
        } else if (t.tok.n <= count) picks.push(t.tok.n);
      }
    });
    if (end < toks.length) comment.push(words.slice(toks[end].from).join(' '));
  }
  const ordered: number[] = [];
  for (const n of [...front, ...picks]) if (!ordered.includes(n)) ordered.push(n);
  return { picks: none && !ordered.length ? [] : ordered.map((n) => n - 1), none: none && !ordered.length, comment: comment.join(', ').trim() };
}
