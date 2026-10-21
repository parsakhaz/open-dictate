import { describe, expect, it } from 'vitest';
import { applyPillRegion } from '../src/main/pillinput';
import { pillRegion } from '../src/core/pillregion';

describe('Windows pill input', () => {
  it('accepts a visible card immediately, replaces its region, and relinquishes input on dismiss', () => {
    const calls: unknown[] = [];
    const pill = { setIgnoreMouseEvents: (ignore: boolean) => calls.push(ignore), setShape: (r: unknown) => calls.push(r) };
    const card = [{ x: 100, y: 200, width: 400, height: 150 }];
    const replacement = [{ x: 100, y: 250, width: 400, height: 100 }];
    expect(applyPillRegion(pill, card, true)).toBe(false);
    expect(calls).toEqual([card, false]);
    calls.length = 0;
    expect(applyPillRegion(pill, replacement, true)).toBe(false);
    expect(calls).toEqual([replacement, false]);
    calls.length = 0;
    expect(applyPillRegion(pill, [], false)).toBe(true);
    expect(calls).toEqual([true, []]);
  });
  it('keeps inbox and Undo interactive after a card snoozes, but idle status passes clicks', () => {
    const pill = { setIgnoreMouseEvents: () => {}, setShape: () => {} };
    const badge = [{ x: 250, y: 340, width: 100, height: 30 }];
    expect(applyPillRegion(pill, badge, true)).toBe(false);
    expect(applyPillRegion(pill, badge, false)).toBe(true);
    expect(applyPillRegion(pill, [], true)).toBe(true);
  });
  it('rounds outward, clips to window bounds and rejects malformed regions', () => {
    expect(pillRegion([{ x: -2.5, y: 399.5, width: 700, height: 40 }, { x: 1, y: 1, width: -1, height: 5 }, { x: NaN }, null])).toEqual([{ x: 0, y: 399, width: 600, height: 21 }]);
    expect(pillRegion(null)).toEqual([]);
  });
});
