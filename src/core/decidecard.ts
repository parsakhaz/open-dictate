// What a decision card holds while the person answers it: the questions, each one's answer so far and how it came,
// and which chips a spoken sentence just filled (they flash). The card body and the wide sheet draw it; the decide
// feature changes it on each click, key and sentence. Pure: each change returns a new value.
import { type Match, matchAnswers } from './decidematch';
import type { DecideQuestion } from './tools/decide';

export type Via = 'click' | 'keys' | 'voice';

export interface QAnswer {
  picked: string[];
  /** Their own words, for "Other… (hold to say)". */
  other?: string;
  via?: Via;
}

export interface DecideData {
  questions: DecideQuestion[];
  answers: QAnswer[];
  /** Some option has a preview: the wide sheet compares them. */
  previews: boolean;
  /** The questions a sentence just filled, and when: their chips flash. */
  flash?: { qs: number[]; at: number };
  /** The last sentence said to the card, returned as `raw`. */
  raw?: string;
}

/** What goes back to the agent for one question. */
export interface AnswerOut {
  id: string;
  header: string;
  picked: string[];
  other?: string;
}

export const newDecide = (questions: DecideQuestion[], previews: boolean): DecideData => ({ questions, answers: questions.map(() => ({ picked: [] })), previews });

export const isAnswered = (a: QAnswer | undefined): boolean => !!a && (a.picked.length > 0 || !!a.other);
export const answeredCount = (d: DecideData): number => d.answers.filter(isAnswered).length;
export const complete = (d: DecideData): boolean => answeredCount(d) === d.questions.length;

/** A click or key on an option: picks it (a pick-any question toggles it). An unknown question or label changes nothing. */
export function pick(d: DecideData, q: number, label: string, via: Via): DecideData {
  const question = d.questions[q];
  if (!question?.options.some((o) => o.label === label)) return d;
  const was = d.answers[q].picked;
  const picked = question.multi ? (was.includes(label) ? was.filter((l) => l !== label) : question.options.map((o) => o.label).filter((l) => l === label || was.includes(l))) : [label];
  return withAnswer(d, q, { picked, via });
}

/** Their own words for a question that offers "Other…"; the picks go. */
export function setOther(d: DecideData, q: number, text: string, via: Via): DecideData {
  const t = text.trim();
  if (!d.questions[q]?.other || !t) return d;
  return withAnswer(d, q, { picked: [], other: t, via });
}

function withAnswer(d: DecideData, q: number, a: QAnswer): DecideData {
  return { ...d, answers: d.answers.map((x, i) => (i === q ? a : x)) };
}

/** A sentence said over the card: what it matched is filled, by voice, and flashes. */
export function applyVoice(d: DecideData, text: string, raw: string, now: number, otherFor?: number): { data: DecideData; match: Match } {
  const match: Match = otherFor !== undefined && d.questions[otherFor]?.other ? { fills: [], other: { q: otherFor, text } } : matchAnswers(text, d.questions, d.answers.map(isAnswered));
  let next: DecideData = { ...d, raw };
  for (const f of match.fills) next = withAnswer(next, f.q, { picked: f.picked, via: 'voice' });
  if (match.other) next = setOther(next, match.other.q, match.other.text, 'voice');
  const qs = [...match.fills.map((f) => f.q), ...(match.other ? [match.other.q] : [])];
  return { data: qs.length ? { ...next, flash: { qs, at: now } } : next, match };
}

/** Every question's answer, an unanswered one with nothing picked; or only the answered ones (`partial`). */
export function answersOut(d: DecideData, partial = false): AnswerOut[] {
  return d.questions
    .map((q, i) => ({ q, a: d.answers[i] }))
    .filter(({ a }) => !partial || isAnswered(a))
    .map(({ q, a }) => ({ id: q.id, header: q.header, picked: a.picked, ...(a.other ? { other: a.other } : {}) }));
}
