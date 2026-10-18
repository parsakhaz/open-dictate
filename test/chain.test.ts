import { describe, expect, it } from 'vitest';
import { type ChainDeps, runChain, stepsFor, stepTimeout } from '../src/core/chain';

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
