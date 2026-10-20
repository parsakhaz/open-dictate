// One spoken sentence onto a decision card's questions, deterministically: option labels, ordinals ("the second
// one"), option numbers and yes/no, in question order. Nothing is guessed: words that match no option go to the open
// question's "other" only when nothing matched at all, and the agent always gets the raw words too. Pure.
import type { DecideQuestion } from './tools/decide';

export interface Match {
  /** The questions filled, in question order, with what was picked. */
  fills: { q: number; picked: string[] }[];
  /** No option matched: the words answer this question's "other". */
  other?: { q: number; text: string };
}

const NUMBER_WORDS: Record<string, string> = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };
const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, '1st': 1, '2nd': 2, '3rd': 3, '4th': 4 };
/** Words that never decide a label match on their own ("Once + email" is said "once, then email"). */
const FILLER = new Set(['and', 'the', 'a', 'an', 'of', 'to', 'then', 'or', 'with', 'for', 'it', 'on', 'in']);
const PICKERS = new Set(['option', 'number', 'choice', 'pick']);
const YES = new Set(['yes', 'yeah', 'yep', 'yup', 'sure']);
const NO = new Set(['no', 'nope', 'nah']);
/** How many other words may sit between a label's words ("once, then email"). */
const GAP = 2;

/** Lower case words: "&" and "+" read as "and", everything else that isn't a letter or digit splits. */
export function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[&+]/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** A word for comparing labels: number words as digits, a plural's "s" dropped. */
const norm = (w: string) => NUMBER_WORDS[w] ?? (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const isNum = (w: string) => /^\d+$/.test(w);

/** The words a label needs heard: its letters-words without filler, else whatever it has. */
function needed(label: string): string[] {
  const all = words(label).map(norm);
  const lettered = all.filter((w) => !isNum(w));
  const meaningful = lettered.filter((w) => !FILLER.has(w));
  return meaningful.length ? meaningful : lettered.length ? lettered : all;
}

interface Mention {
  start: number;
  end: number;
  /** A label heard: every (question, option) it names. */
  options?: { q: number; o: number }[];
  /** An option number or ordinal heard, 1-based. */
  index?: number;
}

/** Where `need` is heard in `said`, in order with at most GAP words between, from the earliest start. */
function find(said: string[], need: string[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (let i = 0; i < said.length; i++) {
    if (said[i] !== need[0]) continue;
    let at = i;
    let ok = true;
    for (const w of need.slice(1)) {
      let j = at + 1;
      while (j < said.length && j - at - 1 <= GAP && said[j] !== w) j++;
      if (j >= said.length || said[j] !== w) {
        ok = false;
        break;
      }
      at = j;
    }
    if (ok) out.push({ start: i, end: at });
  }
  return out;
}

function mentions(text: string, questions: DecideQuestion[]): Mention[] {
  const raw = words(text);
  const said = raw.map(norm);
  const found: Mention[] = [];
  // Labels first, longest first, so "charge failed" wins over "failed".
  const labels = new Map<string, { need: string[]; options: { q: number; o: number }[] }>();
  questions.forEach((q, qi) => {
    q.options.forEach((o, oi) => {
      const need = needed(o.label);
      if (!need.length) return;
      const k = need.join(' ');
      const e = labels.get(k) ?? { need, options: [] };
      e.options.push({ q: qi, o: oi });
      labels.set(k, e);
    });
  });
  const taken = new Array(said.length).fill(false);
  const free = (s: number, e: number) => taken.slice(s, e + 1).every((t) => !t);
  const take = (s: number, e: number) => taken.fill(true, s, e + 1);
  for (const l of [...labels.values()].sort((a, b) => b.need.length - a.need.length)) {
    for (const at of find(said, l.need)) {
      if (!free(at.start, at.end)) continue;
      take(at.start, at.end);
      found.push({ ...at, options: l.options });
    }
  }
  // Yes and no, for options that start with them.
  for (let i = 0; i < said.length; i++) {
    if (taken[i]) continue;
    const set = YES.has(said[i]) ? 'yes' : NO.has(said[i]) ? 'no' : null;
    if (!set) continue;
    const options: { q: number; o: number }[] = [];
    questions.forEach((q, qi) => {
      q.options.forEach((o, oi) => {
        if (words(o.label)[0] === set) options.push({ q: qi, o: oi });
      });
    });
    if (options.length) {
      take(i, i);
      found.push({ start: i, end: i, options });
    }
  }
  // Ordinals ("the second", "second one") and numbers (a digit, or "option two").
  for (let i = 0; i < raw.length; i++) {
    if (taken[i]) continue;
    const w = raw[i];
    const next = raw[i + 1];
    if (ORDINALS[w] && (raw[i - 1] === 'the' || next === 'one' || (next !== undefined && PICKERS.has(next)))) {
      const end = next === 'one' || (next !== undefined && PICKERS.has(next)) ? i + 1 : i;
      if (!free(i, end)) continue;
      take(i, end);
      found.push({ start: i, end, index: ORDINALS[w] });
    } else if (isNum(w) && Number(w) >= 1 && Number(w) <= 4) {
      take(i, i);
      found.push({ start: i, end: i, index: Number(w) });
    } else if (PICKERS.has(w) && next && NUMBER_WORDS[next] && !taken[i + 1]) {
      take(i, i + 1);
      found.push({ start: i, end: i + 1, index: Number(NUMBER_WORDS[next]) });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/**
 * Fills what it can, in the order it was said. A label goes to the first question it names that this sentence hasn't
 * answered yet (several labels may go to a pick-any question); an ordinal or number to the next question still
 * unanswered. `answered`: which questions already have an answer (from a click).
 */
export function matchAnswers(text: string, questions: DecideQuestion[], answered: boolean[]): Match {
  const touched = new Map<number, string[]>();
  for (const m of mentions(text, questions)) {
    if (m.options) {
      const fresh = m.options.find((c) => !touched.has(c.q));
      const multi = m.options.find((c) => questions[c.q].multi && touched.has(c.q));
      const c = fresh ?? multi;
      if (!c) continue;
      const label = questions[c.q].options[c.o].label;
      const was = touched.get(c.q) ?? [];
      touched.set(c.q, questions[c.q].multi ? [...new Set([...was, label])] : [label]);
    } else if (m.index) {
      const k = m.index;
      const q = questions.findIndex((x, i) => !touched.has(i) && !answered[i] && x.options.length >= k);
      if (q >= 0) touched.set(q, [questions[q].options[k - 1].label]);
    }
  }
  const fills = [...touched.entries()].sort((a, b) => a[0] - b[0]).map(([q, picked]) => ({ q, picked }));
  if (fills.length) return { fills };
  const words_ = text.trim();
  const q = questions.findIndex((x, i) => x.other && !answered[i]);
  return words_ && q >= 0 ? { fills: [], other: { q, text: words_ } } : { fills: [] };
}

const LEAD = new Set(['ok', 'okay', 'yes', 'yeah', 'yep', 'sure', 'alright', 'right', 'so', 'um', 'uh', 'great', 'cool', 'fine']);
const TRAIL = new Set(['please', 'thanks', 'thank', 'you', 'now', 'then']);
const APPROVALS = new Set(['approve', 'approved', 'approve it', 'approve that', 'approve this', 'i approve', 'go ahead', 'go for it', 'looks good', 'look good', 'lgtm', 'ship it', 'do it', 'sounds good', 'that works', 'all good', 'yes']);

/** The words only approve ("approve", "go ahead", "yes, looks good please"): anything else is a change request. */
export function isApproval(text: string): boolean {
  const w = words(text);
  let s = 0;
  let e = w.length;
  let lead = false;
  while (s < e && LEAD.has(w[s])) {
    s++;
    lead = true;
  }
  while (e > s && TRAIL.has(w[e - 1])) e--;
  const core = w.slice(s, e).join(' ');
  return core ? APPROVALS.has(core) : lead;
}
