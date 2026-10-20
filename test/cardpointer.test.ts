import { describe, expect, it } from 'vitest';
import { type CardBox, nextCardPointer, resizeReach } from '../src/core/cardpointer';

// A resting card 400 x 80 at (100, 308), its head (source, +N, ✕) the top 25 px.
const rest: CardBox = { x: 100, y: 308, width: 400, height: 80, id: 'k1', head: 25 };
const none = { over: false, openFor: null };
const x = { x: 477, y: 320 };
const title = { x: 300, y: 347 };

describe('the pointer on a card', () => {
  it('a pointer resting on the ✕ takes clicks but leaves the card closed, so the ✕ stays under it (#25)', () => {
    let s = nextCardPointer(none, 'k1', rest, x);
    expect(s).toEqual({ over: true, openFor: null });
    s = nextCardPointer(s, 'k1', rest, x);
    expect(s).toEqual({ over: true, openFor: null });
  });

  it('opens the card once the pointer is on its body, and keeps it open on the way up to the ✕', () => {
    let s = nextCardPointer(none, 'k1', rest, title);
    expect(s).toEqual({ over: true, openFor: 'k1' });
    // Open, the card is taller: its ✕ is higher, and the pointer goes there.
    const open: CardBox = { ...rest, y: 194, height: 194 };
    s = nextCardPointer(s, 'k1', open, { x: 477, y: 206 });
    expect(s).toEqual({ over: true, openFor: 'k1' });
  });

  it('closes when the pointer leaves, and a card that takes its place starts closed', () => {
    const open = nextCardPointer(none, 'k1', rest, title);
    expect(nextCardPointer(open, 'k1', rest, { x: 50, y: 50 })).toEqual(none);
    expect(nextCardPointer(open, 'k2', rest, x)).toEqual({ over: true, openFor: null });
    expect(nextCardPointer(open, null, null, title)).toEqual(none);
  });

  it("a new card doesn't open by the box of the card it replaced", () => {
    // k1 was dismissed; until the page says where k2 is, the pointer on k1's body doesn't open k2.
    expect(nextCardPointer(none, 'k2', rest, title)).toEqual({ over: true, openFor: null });
    expect(nextCardPointer(none, 'k2', { ...rest, id: 'k2' }, title)).toEqual({ over: true, openFor: 'k2' });
  });

  it('QA hover opens it without a pointer', () => {
    expect(nextCardPointer(none, 'k1', rest, null, true)).toEqual({ over: true, openFor: 'k1' });
  });
});

describe("a card's reach while it resizes (#26)", () => {
  // The bottom edge stays put above the pill: the card grows and shrinks at its top.
  const open = { x: 100, y: 194, width: 400, height: 194 };

  it('growing, it reaches its final top at once', () => {
    expect(resizeReach(open, 80, 194)).toEqual(open);
  });

  it('shrinking, it still reaches its old top until it is done', () => {
    expect(resizeReach({ x: 100, y: 308, width: 400, height: 80 }, 194, 80)).toEqual({ x: 100, y: 194, width: 400, height: 194 });
  });
});
