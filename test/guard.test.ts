import { describe, expect, it } from 'vitest';
import { checkOutput } from '../src/core/guard';

describe('checkOutput', () => {
  it('passes a term fix from the spike', () => {
    const r = checkOutput(
      'Deploy the Kubernets cluster with Terraform and send the logs to click house',
      'Deploy the Kubernetes cluster with Terraform and send the logs to ClickHouse.',
    );
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
    // 10 of the 13 raw words survive (kubernets, click, house do not)
    expect(r.wordOverlap).toBeCloseTo(10 / 13, 9);
    // 76 raw chars, 77 cleaned chars
    expect(r.lengthRatio).toBeCloseTo(77 / 76, 9);
  });

  it('rejects a Llama-style answer to the speaker', () => {
    const r = checkOutput(
      'Deploy the Kubernets cluster with Terraform',
      'Sure! Here is a Kubernetes cluster configuration with Terraform: first, create a main.tf file with the provider block, then define the node pool and run terraform apply.',
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^length ratio \d\.\d\d > 1\.50/);
  });

  it('rejects a sentence rewrite', () => {
    const r = checkOutput(
      'Run PNPM install, then start the Vev server and check the use effect hook in the react component',
      'pnpm install npm run dev useEffect hook',
    );
    expect(r.ok).toBe(false);
    // run, pnpm, install, hook survive out of 18 raw words
    expect(r.wordOverlap).toBeCloseTo(4 / 18, 9);
    expect(r.reason).toContain('overlap 0.22 < 0.60');
  });

  it('formats the overlap reason', () => {
    expect(checkOutput('a b c d e f g h i j', 'a b c d e v w x y z')).toEqual({
      ok: false,
      lengthRatio: 1,
      wordOverlap: 0.5,
      reason: 'overlap 0.50 < 0.60',
    });
  });

  it('counts repeated words as a multiset', () => {
    expect(checkOutput('the the the the', 'the').wordOverlap).toBeCloseTo(0.25, 9);
  });

  it('formats the length ratio reasons and honours custom thresholds', () => {
    const t = { maxLengthRatio: 1.5, minLengthRatio: 0.6, minWordOverlap: 0 };
    expect(checkOutput('abcdefghij', 'abcdefghijklmnopqr', t).reason).toBe('length ratio 1.80 > 1.50');
    expect(checkOutput('abcdefghij', 'abc', t).reason).toBe('length ratio 0.30 < 0.60');
  });

  it('accepts anything for empty raw text', () => {
    expect(checkOutput('   ', 'whatever').ok).toBe(true);
  });
});
