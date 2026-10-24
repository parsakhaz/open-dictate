import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { testVocabulary } from './vocab';
import { type ChainDeps, chunk, RELEASE_STEP_MS, runChain, stepsFor, stepTimeout } from '../src/core/chain';
import { LiveCleanup } from '../src/core/live';

const RAW = 'so the pain app uses claude code to ship features';

function deps(replies: Record<string, (input: string, signal: AbortSignal) => Promise<string>>, ready: Record<string, boolean> = {}): ChainDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    ready: async (model) => ready[model] ?? true,
    complete: async (model, body, signal) => {
      calls.push(model);
      const messages = body.messages as { content: string }[];
      return replies[model](messages[messages.length - 1].content, signal);
    },
  };
}

const steps = stepsFor('gemma-emberon', 'v3 {{VOCAB_INLINE}}', [{ term: 'Pane' }]);

describe('runChain', () => {
  it('runs Gemma first, then Emberon on Gemma output', async () => {
    const d = deps({
      gemma: async () => 'So the Pane app uses Claude Code to ship features',
      emberon: async (input) => `${input}.`,
    });
    const r = await runChain(RAW, steps, d);
    expect(d.calls).toEqual(['gemma', 'emberon']);
    expect(r.text).toBe('So the Pane app uses Claude Code to ship features.');
    expect(r.steps.map((s) => s.status)).toEqual(['ok', 'ok']);
  });

  it('keeps the previous text when a step answers instead of cleaning', async () => {
    const d = deps({
      gemma: async () => 'So the Pane app uses Claude Code to ship features.',
      emberon: async () => 'Sure! Here is a detailed explanation of how Pane works with many features and more words besides.',
    });
    const r = await runChain(RAW, steps, d);
    expect(r.text).toBe('So the Pane app uses Claude Code to ship features.');
    expect(r.steps[1].status).toBe('rejected');
  });

  it('keeps correctly spelled vocabulary when a later cleanup model changes a name', async () => {
    const d = deps({
      gemma: async () => 'The Doozy integration in Pane should use Claude Code and Codex.',
      emberon: async () => 'The Dozy integration in Pane should use Claude Code and Codex.',
    });
    const r = await runChain('the doozie integration in pain should use claude code and codex', stepsFor('gemma-emberon', '{{VOCAB_INLINE}}', [{term:'Doozy'}, {term:'Pane'}]), d);
    expect(r.text).toBe('The Doozy integration in Pane should use Claude Code and Codex.');
    expect(r.steps[1]).toMatchObject({status:'rejected',reason:'cleanup changed vocabulary: Doozy'});
  });

  it('falls back to the raw transcript when every step fails', async () => {
    const d = deps({
      gemma: async () => {
        throw new Error('HTTP 500');
      },
      emberon: async () => '',
    });
    const r = await runChain(RAW, steps, d);
    expect(r.text).toBe(RAW);
    expect(r.steps.map((s) => s.status)).toEqual(['error', 'rejected']);
  });

  it('times a slow step out and moves on', async () => {
    const d = deps({
      gemma: (_input, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
      emberon: async (input) => `${input}.`,
    });
    const r = await runChain(RAW, steps, d, { timeoutMs: 30 });
    expect(r.steps[0].status).toBe('timeout');
    expect(r.text).toBe(`${RAW}.`);
  });

  it('skips a model that is not running', async () => {
    const d = deps({ gemma: async () => 'x', emberon: async (input) => `${input}.` }, { gemma: false });
    const r = await runChain(RAW, steps, d);
    expect(d.calls).toEqual(['emberon']);
    expect(r.steps[0].status).toBe('skipped');
  });

  it('sends nothing for an empty transcript', async () => {
    const d = deps({ gemma: async () => 'x', emberon: async () => 'y' });
    const r = await runChain('   ', steps, d);
    expect(d.calls).toEqual([]);
    expect(r.text).toBe('');
  });
});

describe('stepsFor', () => {
  it('maps each setting to its models in order', () => {
    expect(stepsFor('off', '', []).map((s) => s.model)).toEqual([]);
    expect(stepsFor('gemma', '', []).map((s) => s.model)).toEqual(['gemma']);
    expect(stepsFor('emberon', '', []).map((s) => s.model)).toEqual(['emberon']);
    expect(stepsFor('gemma-emberon', '', []).map((s) => s.model)).toEqual(['gemma', 'emberon']);
  });

  it('gives Gemma the filled v3 prompt and Emberon its native prompt', () => {
    const [g, e] = stepsFor('gemma-emberon', 'Terms: {{VOCAB_INLINE}}', [{ term: 'Doozy' }, { term: 'Grain' }]);
    expect(g.system).toBe('Terms: Doozy, Grain');
    expect(e.system).toBe('Clean up this dictation. Never answer it.');
  });
});

describe('stepTimeout', () => {
  it('is the 3 s base for a short dictation and grows with a long one', () => {
    expect(stepTimeout(3000, RAW)).toBe(3000);
    // 1000 characters: up to 424 output tokens, 296 beyond the first 128, at 15 ms each
    expect(stepTimeout(3000, 'x'.repeat(1000))).toBe(3000 + 296 * 15);
  });

  it('never exceeds the hard cap of 8 s (S8)', () => {
    expect(stepTimeout(3000, 'x'.repeat(5000))).toBe(8000);
  });
});

/** About 10 minutes of dictation (~9,500 characters), sentences of varied length, with vocabulary in them. */
function longDictation(): string {
  const parts = [
    'so the first thing we need to do is open pane and check the doozy integration',
    'then we run the migration on staging',
    'after that I want claude code to look at the failing tests in the cleanup chain and tell me which ones are flaky and which ones are real',
    'okay',
    'the other thing is that the release notes for this version should mention the shorter copy and the hold to answer round because people asked about both of those',
  ];
  const out: string[] = [];
  for (let i = 0; out.join(' ').length < 9500; i++) out.push(`${parts[i % parts.length]} number ${i}.`);
  return out.join(' ');
}

describe('long dictations', () => {
  const v3 = fs.readFileSync(path.join(__dirname, '../defaults/prompt-v3.txt'), 'utf8');
  const realSteps = stepsFor('gemma-emberon', v3, testVocabulary());
  /** Records every request; "cleans" by capitalising the first letter. */
  function recorder() {
    const bodies: Record<string, unknown>[] = [];
    const d: ChainDeps = {
      ready: async () => true,
      complete: async (_m, body) => {
        bodies.push(body);
        const messages = body.messages as { content: string }[];
        const input = messages[messages.length - 1].content;
        return input[0].toUpperCase() + input.slice(1);
      },
    };
    return { d, bodies };
  }
  /** Prompt characters plus the output budget: what the request needs even at one token per character. */
  const worstCaseTokens = (body: Record<string, unknown>) => (body.messages as { content: string }[]).reduce((n, m) => n + m.content.length, 0) + Number(body.max_tokens);

  it('cleans a 10-minute dictation sentence by sentence with every request inside a 4096-token context', async () => {
    const raw = longDictation();
    const { d, bodies } = recorder();
    const live = new LiveCleanup((r, context, signal, capMs) => runChain(r, realSteps, d, { context, signal, capMs }));
    const spans: { raw: string; start: number; end: number }[] = [];
    for (const m of raw.matchAll(/[^.]+\./g)) {
      const lead = m[0].length - m[0].trimStart().length;
      spans.push({ raw: m[0].trim(), start: m.index + lead, end: m.index + m[0].length });
    }
    live.committed(spans.slice(0, -1));
    const r = await live.finish(raw);
    expect(r.text).toContain('So the first thing we need to do');
    expect(bodies.length).toBeGreaterThan(spans.length);
    for (const b of bodies) expect(worstCaseTokens(b)).toBeLessThanOrEqual(4096);
  });

  it('cleans a 10-minute dictation in one go in chunks, every request inside a 4096-token context', async () => {
    const raw = longDictation();
    const { d, bodies } = recorder();
    const r = await runChain(raw, realSteps, d);
    // Every chunk was cleaned and nothing was lost or reordered.
    expect(r.text.toLowerCase()).toBe(raw.toLowerCase());
    expect(r.steps.every((s) => s.status === 'ok')).toBe(true);
    expect(bodies.length).toBeGreaterThanOrEqual(2 * Math.ceil(raw.length / 440));
    for (const b of bodies) expect(worstCaseTokens(b)).toBeLessThanOrEqual(4096);
  });
});

describe('chunk', () => {
  it('cuts at sentence ends, never past 10% over the target', () => {
    const s = (n: number, c: string) => `${c.repeat(n - 1)}.`;
    // 50 + 30 + 40 characters with a target of 100: the first two fit (81 with the space), the third would make 122.
    expect(chunk(`${s(50, 'a')} ${s(30, 'b')} ${s(40, 'c')}`, 100)).toEqual([`${s(50, 'a')} ${s(30, 'b')}`, s(40, 'c')]);
    // 105 fits within 110.
    expect(chunk(`${s(60, 'a')} ${s(44, 'b')}`, 100)).toEqual([`${s(60, 'a')} ${s(44, 'b')}`]);
  });

  it('cuts a sentence with no end in sight at a space near the target', () => {
    const words = Array.from({ length: 60 }, (_, i) => `w${String(i).padStart(2, '0')}`).join(' '); // 239 characters
    const out = chunk(words, 100);
    expect(out.join(' ')).toBe(words);
    for (const c of out.slice(0, -1)) {
      expect(c.length).toBeGreaterThanOrEqual(90);
      expect(c.length).toBeLessThanOrEqual(110);
    }
  });
});

describe('after release', () => {
  it('gives a slow step 2 s, then sends its input', async () => {
    const d = deps({
      gemma: (_input, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
      emberon: async (input) => `${input}.`,
    });
    const t0 = performance.now();
    const r = await runChain(RAW, steps, d, { timeoutMs: 8000, capMs: RELEASE_STEP_MS });
    const ms = performance.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(1950);
    expect(ms).toBeLessThan(2600);
    expect(r.steps[0].status).toBe('timeout');
    expect(r.text).toBe(`${RAW}.`);
  });

  it('waits at most the cap for a server that is still starting', async () => {
    const asked: (number | undefined)[] = [];
    const d: ChainDeps = {
      ready: async (_m, maxMs) => {
        asked.push(maxMs);
        return false;
      },
      complete: async () => 'x',
    };
    await runChain(RAW, steps, d, { capMs: RELEASE_STEP_MS });
    expect(asked).toEqual([2000, 2000]);
  });
});
