// Output guard (from voice-lab): rejects cleanup output that answers the speaker or rewrites the sentence. Pure.
import { DEFAULT_GUARD, type GuardResult, type GuardThresholds } from './types';

function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => w.length > 0);
}

export function checkOutput(raw: string, cleaned: string, t: GuardThresholds = DEFAULT_GUARD): GuardResult {
  const r = raw.trim();
  const c = cleaned.trim();
  if (r.length === 0) return { ok: true, lengthRatio: 1, wordOverlap: 1 };
  const lengthRatio = c.length / r.length;

  const rawWords = words(r);
  const pool = new Map<string, number>();
  for (const w of words(c)) pool.set(w, (pool.get(w) ?? 0) + 1);
  let kept = 0;
  for (const w of rawWords) {
    const n = pool.get(w) ?? 0;
    if (n > 0) {
      kept++;
      pool.set(w, n - 1);
    }
  }
  const wordOverlap = rawWords.length ? kept / rawWords.length : 1;

  const reasons: string[] = [];
  if (lengthRatio > t.maxLengthRatio) reasons.push(`length ratio ${lengthRatio.toFixed(2)} > ${t.maxLengthRatio.toFixed(2)}`);
  if (lengthRatio < t.minLengthRatio) reasons.push(`length ratio ${lengthRatio.toFixed(2)} < ${t.minLengthRatio.toFixed(2)}`);
  if (wordOverlap < t.minWordOverlap) reasons.push(`overlap ${wordOverlap.toFixed(2)} < ${t.minWordOverlap.toFixed(2)}`);
  return reasons.length
    ? { ok: false, lengthRatio, wordOverlap, reason: reasons.join(' · ') }
    : { ok: true, lengthRatio, wordOverlap };
}
