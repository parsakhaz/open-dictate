import { describe, expect, it } from 'vitest';
import type { Turn } from '../src/core/chain';
import { LiveCleanup, type PieceRunner, Segmenter } from '../src/core/live';

const S = { stableMs: 300, pauseMs: 700, chunkMs: 1200 };

describe('Segmenter', () => {
  it('commits a sentence once the next one has started and the text held still', () => {
    const g = new Segmenter(S);
    expect(g.update('Deploy the cluster.', 0)).toEqual([]);
    // The next sentence has started, but the text must hold for stableMs.
    expect(g.update('Deploy the cluster. Then', 1000)).toEqual([]);
    expect(g.update('Deploy the cluster. Then send', 1400).map((s) => s.raw)).toEqual(['Deploy the cluster.']);
    expect(g.update('Deploy the cluster. Then send the logs? And', 2600)).toEqual([]);
    expect(g.update('Deploy the cluster. Then send the logs? And done', 3000).map((s) => s.raw)).toEqual(['Then send the logs?']);
  });

  it('splits at a pause when the speech stopped and the text held for a recognizer chunk', () => {
    const g = new Segmenter(S);
    g.update('so the first thing', 0);
    g.update('so the first thing we do', 1000);
    g.silence(1100);
    expect(g.tick(1900)).toEqual([]); // silent 800 ms, but the text changed only 900 ms ago
    expect(g.tick(2300).map((s) => s.raw)).toEqual(['so the first thing we do']);
    // the pause is used up: more silence commits nothing new
    expect(g.tick(4000)).toEqual([]);
    g.update('so the first thing we do is deploy', 5000);
    expect(g.tick(5100)).toEqual([]);
  });

  it('reports a committed sentence the recognizer revised, and everything after it', () => {
    const g = new Segmenter(S);
    g.update('Run the tests. Then', 0);
    g.update('Run the tests. Then fix', 400);
    g.update('Run the tests. Then fix it. Ok', 800);
    expect(g.update('Run the tests. Then fix it. Ok now', 1200).map((s) => s.raw)).toEqual(['Then fix it.']);
    const r = g.update('Run the test. Then fix it. Ok now', 1300);
    expect(r).toEqual([]);
    expect(g.takeRevised().map((s) => s.raw)).toEqual(['Run the tests.', 'Then fix it.']);
    expect(g.committed).toEqual([]);
  });

  it('a single sentence is never committed before release', () => {
    const g = new Segmenter(S);
    g.update('Deploy the Kubernetes cluster', 0);
    g.update('Deploy the Kubernetes cluster with Terraform.', 1000);
    expect(g.tick(5000)).toEqual([]);
    expect(g.committed).toEqual([]);
  });
});

/** A fake chain: "cleans" by upper-casing the first letter and tagging with the context size. */
function runner(opts: { fail?: string; delay?: number } = {}) {
  const calls: { raw: string; context: Turn[] }[] = [];
  const run: PieceRunner = async (raw, context, signal) => {
    calls.push({ raw, context });
    if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
    if (signal.aborted) return { text: raw, steps: [{ model: 'gemma', status: 'skipped', ms: 0, reason: 'cancelled' }], turns: [] };
    if (opts.fail && raw.includes(opts.fail)) return { text: raw, steps: [{ model: 'gemma', status: 'timeout', ms: 3000 }], turns: [{ model: 'gemma', input: raw, output: raw }] };
    const out = `<${raw}>`;
    return { text: out, steps: [{ model: 'gemma', status: 'ok', ms: 5 }], turns: [{ model: 'gemma', input: raw, output: out }] };
  };
  return { run, calls };
}

const sent = (raw: string, start: number) => ({ raw, start, end: start + raw.length });

describe('LiveCleanup', () => {
  it('cleans sentences in order while the person speaks, with the earlier ones as context, and only the rest at release', async () => {
    const { run, calls } = runner();
    const l = new LiveCleanup(run);
    l.committed([sent('One.', 0)]);
    l.committed([sent('Two two.', 5)]);
    const r = await l.finish('One. Two two. Three');
    expect(calls.map((c) => c.raw)).toEqual(['One.', 'Two two.', 'Three']);
    expect(calls.map((c) => c.context.length)).toEqual([0, 1, 2]);
    expect(r.text).toBe('<One.> <Two two.> <Three>');
    expect(r.early).toBe(2);
  });

  it('a single-sentence dictation is one request with no context, exactly as without live cleanup', async () => {
    const { run, calls } = runner();
    const r = await new LiveCleanup(run).finish('Deploy the cluster with Terraform.');
    expect(calls).toEqual([{ raw: 'Deploy the cluster with Terraform.', context: [] }]);
    expect(r.text).toBe('<Deploy the cluster with Terraform.>');
  });

  it('redoes a sentence the recognizer revised after it was sent, discarding its result', async () => {
    const { run, calls } = runner({ delay: 5 });
    const l = new LiveCleanup(run);
    l.committed([sent('Run the tests.', 0)]);
    l.revised([sent('Run the tests.', 0)]);
    const r = await l.finish('Run the test. Then stop.');
    expect(r.text).toBe('<Run the test. Then stop.>');
    expect(r.redone).toBe(1);
    expect(calls.at(-1)?.raw).toBe('Run the test. Then stop.');
  });

  it('also catches a revision that only shows in the final transcript', async () => {
    const { run } = runner();
    const l = new LiveCleanup(run);
    l.committed([sent('Run the tests.', 0)]);
    const r = await l.finish('Run the test. Then stop.');
    expect(r.text).toBe('<Run the test. Then stop.>');
    expect(r.redone).toBe(1);
  });

  it('a sentence whose cleanup fails keeps its raw text; the others are still cleaned', async () => {
    const { run } = runner({ fail: 'Two' });
    const l = new LiveCleanup(run);
    l.committed([sent('One.', 0), sent('Two.', 5)]);
    const r = await l.finish('One. Two. Three.');
    expect(r.text).toBe('<One.> Two. <Three.>');
    expect(r.steps.some((s) => s.status === 'timeout')).toBe(true);
  });

  it('Esc cancels everything, including requests in flight', async () => {
    const { run } = runner({ delay: 20 });
    const l = new LiveCleanup(run);
    l.committed([sent('One.', 0), sent('Two.', 5)]);
    l.cancel();
    await expect(l.finish('One. Two. Three.')).rejects.toThrow(/cancelled/);
  });

  it('joins pieces with single spaces, whatever spacing the pieces have', async () => {
    const run: PieceRunner = async (raw) => ({ text: ` ${raw.toUpperCase()}  `, steps: [], turns: [] });
    const l = new LiveCleanup(run);
    l.committed([sent('a b.', 0)]);
    expect((await l.finish('a b.   c d')).text).toBe('A B. C D');
  });
});
