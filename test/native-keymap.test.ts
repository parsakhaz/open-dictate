import { describe, expect, it } from 'vitest';
import { canonicalKeyCode } from '../src/native/keymap';

// Values from uiohook-napi 1.5.5's public UiohookKey map; the core uses stable VK identifiers.
describe('portable native key events', () => {
  it('keeps left and right modifiers distinct', () => {
    expect([29, 3613, 56, 3640, 42, 54, 3675, 3676].map(canonicalKeyCode)).toEqual([
      0xa2, 0xa3, 0xa4, 0xa5, 0xa0, 0xa1, 0x5b, 0x5c,
    ]);
  });

  it('maps letters, navigation and dedicated dictation keys without scan/VK collisions', () => {
    expect([30, 47, 2, 11, 1, 28, 57416, 57424, 3666, 91, 107].map(canonicalKeyCode)).toEqual([
      0x41, 0x56, 0x31, 0x30, 0x1b, 0x0d, 0x26, 0x28, 0x2d, 0x7c, 0x87,
    ]);
    expect(canonicalKeyCode(0xffff)).toBeNull();
  });

  it('accepts keypad navigation, Enter and the dedicated Pause/Menu keys', () => {
    expect([0x0e1c, 0xee48, 0xee50, 0xee47, 0xee4f, 0xee52, 0xee53, 0x0e45, 0x0e5d].map(canonicalKeyCode)).toEqual([
      0x0d, 0x26, 0x28, 0x24, 0x23, 0x2d, 0x2e, 0x13, 0x5d,
    ]);
  });
});
