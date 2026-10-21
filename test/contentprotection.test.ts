import { expect, it } from 'vitest';
import { protectCapture } from '../src/main/contentprotection';

it('restores protection only after the last overlapping capture, in either release order', () => {
  for (const reverse of [false, true]) {
    let protectedNow = false;
    const w = { isDestroyed: () => false, isContentProtected: () => protectedNow, setContentProtection: (on: boolean) => { protectedNow = on; } };
    const releases = [protectCapture([w]), protectCapture([w])];
    if (reverse) releases.reverse();
    releases[0]();
    releases[0]();
    expect(protectedNow).toBe(true);
    releases[1]();
    expect(protectedNow).toBe(false);
  }
});

it('preserves pre-existing protection and tolerates window destruction', () => {
  let destroyed = false;
  const calls: boolean[] = [];
  const w = { isDestroyed: () => destroyed, isContentProtected: () => true, setContentProtection: (on: boolean) => calls.push(on) };
  const release = protectCapture([w, w]);
  release();
  expect(calls).toEqual([true, true]);
  const end = protectCapture([w]);
  destroyed = true;
  end();
  expect(calls).toEqual([true, true, true]);
});
