import { describe, expect, it } from 'vitest';
import { splitPressEnter } from '../src/core/commands';

describe('splitPressEnter (B8)', () => {
  it('takes "press enter" off the very end, with the punctuation around it', () => {
    expect(splitPressEnter('Sounds good, see you then press enter')).toEqual({ text: 'Sounds good, see you then', enter: true });
    expect(splitPressEnter('Sounds good. Press enter.')).toEqual({ text: 'Sounds good.', enter: true });
    expect(splitPressEnter('ship it, press Enter!')).toEqual({ text: 'ship it', enter: true });
  });

  it('leaves it alone anywhere but the end, or inside another word', () => {
    expect(splitPressEnter('press enter to continue')).toEqual({ text: 'press enter to continue', enter: false });
    expect(splitPressEnter('then I express enterprise needs')).toEqual({ text: 'then I express enterprise needs', enter: false });
    expect(splitPressEnter('compress enter')).toEqual({ text: 'compress enter', enter: false });
  });

  it('keeps "press enter" as the text when nothing else was said', () => {
    expect(splitPressEnter('Press enter.')).toEqual({ text: 'Press enter.', enter: false });
  });
});
