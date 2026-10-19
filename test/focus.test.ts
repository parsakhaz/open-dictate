import { describe, expect, it } from 'vitest';
import { focusForPaste } from '../src/main/focus';

describe('history paste target handoff', () => {
  it('waits for actual focus after the OS accepts an asynchronous activation request', async () => {
    let foreground = 99;
    let ticks = 0;
    expect(await focusForPaste(12, { current: () => foreground, exists: () => true, activate: () => true, sleep: async () => { if (++ticks === 2) foreground = 12; } })).toBe(true);
    expect(foreground).toBe(12);
  });

  it('reports failure if the target closes or focus never arrives, so the caller can copy instead', async () => {
    expect(await focusForPaste(12, { current: () => 99, exists: () => true, activate: () => true, sleep: async () => undefined })).toBe(false);
    expect(await focusForPaste(12, { current: () => 99, exists: () => false, activate: () => true, sleep: async () => undefined })).toBe(false);
  });
});
