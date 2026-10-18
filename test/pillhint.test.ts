import { describe, expect, it } from 'vitest';
import { finishHint, HINT_MS, HINT_SESSIONS, hintVisible } from '../src/core/pillhint';

const labels = { hotkey: 'Left Shift + Right Alt', toggle: 'Right Alt' };

describe('finishHint', () => {
  it('push-to-talk: release', () => {
    expect(finishHint('push-to-talk', undefined, labels)).toBe('Release to finish');
  });

  it('hands-free from a double-tap: tap the dictation key', () => {
    expect(finishHint('toggle', undefined, { hotkey: 'Right Alt', toggle: 'Off' })).toBe('Tap Right Alt to finish');
  });

  it('hands-free from the toggle combo: that combo, not the dictation key (it said "Left Shift + Right Alt")', () => {
    expect(finishHint('toggle', 'combo', labels)).toBe('Right Alt to finish');
  });
});

describe('hintVisible', () => {
  it('shows for the first seconds of the first few recordings only', () => {
    expect(hintVisible(0, 0)).toBe(true);
    expect(hintVisible(HINT_SESSIONS - 1, HINT_MS - 1)).toBe(true);
    expect(hintVisible(0, HINT_MS)).toBe(false);
    expect(hintVisible(HINT_SESSIONS, 0)).toBe(false);
  });
});
