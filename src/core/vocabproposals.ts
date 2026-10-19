// Vocabulary that agents suggest: checked strictly, kept in a review queue with where it came from, and only
// reaching the cleanup prompt once the person approves it. Pure.
import { cleanText } from './agenttext';
import { VOCAB_LIMITS } from './agenttools';
import type { VocabTerm } from './types';
import { normalizeVocabulary } from './vocabulary';

export interface PendingTerm {
  term: string;
  aliases: string[];
  reason: string;
  /** Dictate's own source line for the agent that suggested it. */
  source: string;
  /** ISO time it was suggested. */
  at: string;
}

export interface Rejected {
  term: string;
  why: string;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const BAD = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Why one term or alias can't be used, or null when it can. */
function problem(s: unknown): string | null {
  if (typeof s !== 'string' || !s.trim()) return 'empty';
  if (BAD.test(s)) return 'must be one line, without control characters';
  if (s.includes('=>')) return 'must not contain =>';
  if ([...s.trim()].length > VOCAB_LIMITS.chars) return `longer than ${VOCAB_LIMITS.chars} characters`;
  return null;
}

/**
 * Checks an agent's suggestions against the approved vocabulary and the queue. Each bad term is rejected with a
 * reason; nothing is ever fixed up silently.
 */
export function checkProposals(input: unknown, approved: VocabTerm[], pending: PendingTerm[], source: string, now: Date): { accepted: PendingTerm[]; rejected: Rejected[] } {
  const items = Array.isArray(input) ? input : [];
  const accepted: PendingTerm[] = [];
  const rejected: Rejected[] = [];
  const known = new Set([...approved.map((t) => t.term.toLowerCase()), ...pending.map((t) => t.term.toLowerCase())]);
  for (const [i, raw] of items.entries()) {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const label = typeof o.term === 'string' ? o.term.slice(0, 60) : `item ${i + 1}`;
    if (i >= VOCAB_LIMITS.terms) {
      rejected.push({ term: label, why: `more than ${VOCAB_LIMITS.terms} terms in one request` });
      continue;
    }
    const p = problem(o.term);
    if (p) {
      rejected.push({ term: label, why: `term ${p}` });
      continue;
    }
    const aliases = Array.isArray(o.aliases) ? o.aliases : o.aliases === undefined ? [] : [o.aliases];
    const badAlias = aliases.map(problem).find((x) => x);
    if (badAlias) {
      rejected.push({ term: label, why: `an alias ${badAlias}` });
      continue;
    }
    if (aliases.length > VOCAB_LIMITS.aliases) {
      rejected.push({ term: label, why: `more than ${VOCAB_LIMITS.aliases} aliases` });
      continue;
    }
    const term = (o.term as string).trim();
    if (known.has(term.toLowerCase())) {
      rejected.push({ term: label, why: 'already in your vocabulary or waiting for review' });
      continue;
    }
    known.add(term.toLowerCase());
    accepted.push({ term, aliases: (aliases as string[]).map((a) => a.trim()), reason: cleanText(o.reason, 120).text, source, at: now.toISOString() });
  }
  return { accepted, rejected };
}

/** Approving moves a term into the vocabulary the prompt uses; rejecting just drops it. */
export function approveTerm(vocabulary: VocabTerm[], pending: PendingTerm[], term: string): { vocabulary: VocabTerm[]; pending: PendingTerm[] } {
  const p = pending.find((x) => x.term === term);
  if (!p) return { vocabulary, pending };
  return {
    vocabulary: normalizeVocabulary([...vocabulary, p.aliases.length ? { term: p.term, aliases: p.aliases } : { term: p.term }]),
    pending: pending.filter((x) => x !== p),
  };
}

export function rejectTerm(pending: PendingTerm[], term: string): PendingTerm[] {
  return pending.filter((x) => x.term !== term);
}

/** The saved queue, checked item by item (an old or hand-edited settings file never stops the app). */
export function parsePending(data: unknown): PendingTerm[] {
  if (!Array.isArray(data)) return [];
  const out: PendingTerm[] = [];
  for (const x of data) {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    if (problem(o.term) || !Array.isArray(o.aliases) || o.aliases.some((a) => problem(a))) continue;
    out.push({ term: (o.term as string).trim(), aliases: o.aliases as string[], reason: typeof o.reason === 'string' ? o.reason : '', source: typeof o.source === 'string' ? o.source : '', at: typeof o.at === 'string' ? o.at : '' });
  }
  return out.slice(0, 200);
}
