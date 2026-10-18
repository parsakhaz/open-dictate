// The user's technical-term vocabulary: normalising, merging defaults, the file format.
// Copied from voice-lab. Pure.
import type { VocabTerm, VocabularyFile } from './types';

/** Adds default terms and aliases the user's list lacks. Never removes or renames anything the user has. */
export function mergeVocabularyDefaults(user: VocabTerm[], defaults: VocabTerm[]): VocabTerm[] {
  return normalizeVocabulary([...user, ...defaults]);
}

function dedupeStrings(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of xs) {
    const x = raw.trim();
    const key = x.toLowerCase();
    if (!x || seen.has(key)) continue;
    seen.add(key);
    out.push(x);
  }
  return out;
}

export function normalizeVocabulary(terms: VocabTerm[]): VocabTerm[] {
  const byKey = new Map<string, { term: string; aliases: string[] }>();
  for (const t of terms) {
    const term = t.term.trim();
    if (!term) continue;
    const key = term.toLowerCase();
    const existing = byKey.get(key);
    if (existing) existing.aliases.push(...(t.aliases ?? []));
    else byKey.set(key, { term, aliases: [...(t.aliases ?? [])] });
  }
  return [...byKey.values()].map(({ term, aliases }) => {
    const a = dedupeStrings(aliases);
    return a.length ? { term, aliases: a } : { term };
  });
}

function isTerm(x: unknown): x is VocabTerm {
  if (typeof x !== 'object' || x === null) return false;
  const t = x as Record<string, unknown>;
  if (typeof t.term !== 'string') return false;
  return t.aliases === undefined || (Array.isArray(t.aliases) && t.aliases.every((a) => typeof a === 'string'));
}

export function parseVocabularyFile(text: string): { terms: VocabTerm[]; error?: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { terms: [], error: `vocabulary file is not valid JSON: ${(e as Error).message}` };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { terms: [], error: 'vocabulary file must be a JSON object' };
  const f = data as Partial<VocabularyFile>;
  if (f.version !== 1) return { terms: [], error: `vocabulary file has unsupported version ${JSON.stringify(f.version)}` };
  if (!Array.isArray(f.terms)) return { terms: [], error: 'vocabulary file has no "terms" array' };
  const bad = f.terms.findIndex((t) => !isTerm(t));
  if (bad >= 0) return { terms: [], error: `vocabulary term ${bad + 1} is malformed` };
  return { terms: normalizeVocabulary(f.terms) };
}

export function serializeVocabulary(terms: VocabTerm[], seed?: number): string {
  const file: VocabularyFile = { version: 1, ...(seed ? { seed } : {}), terms: normalizeVocabulary(terms) };
  return `${JSON.stringify(file, null, 2)}\n`;
}
