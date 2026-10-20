// The pointer against the top card on the pill: whether the window takes clicks there, and whether the card opens
// to show its buttons. Main reads the pointer every 40 ms; the page says where the card is. Pure.

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The top card in the pill page (CSS pixels), which card it is, and how far down from its top its head (source, +N, ✕) reaches. */
export interface CardBox extends Rect {
  id: string | null;
  head: number;
}

export interface CardPointer {
  /** The pointer is over the card: the window takes clicks. */
  over: boolean;
  /** The card that opened under the pointer, while the pointer stays on it. */
  openFor: string | null;
}

export const inRect = (p: Point, r: Rect): boolean => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

/**
 * A card opens upward from its bottom edge, which stays put above the pill, so opening carries its head, and the ✕,
 * away from under a pointer resting there (#25). It opens only once the pointer is on its body, below the head, and
 * then stays open until the pointer leaves it or another card takes its place; a new card opens only by its own box.
 * `forced` is QA's hover without a pointer.
 */
export function nextCardPointer(prev: CardPointer, top: string | null, box: CardBox | null, p: Point | null, forced = false): CardPointer {
  const over = !!top && (forced || (!!box && !!p && inRect(p, box)));
  if (!top || !over) return { over: false, openFor: null };
  const onBody = forced || (!!box && !!p && box.id === top && p.y > box.y + box.head);
  return { over, openFor: onBody || prev.openFor === top ? top : null };
}

/**
 * Everywhere the card is drawn while its body eases from `from` px tall to `to`, given where it ends up. Its bottom edge
 * stays put, so growing it is already at its final top; shrinking, it still reaches its old top until it is done (#26).
 */
export function resizeReach(final: Rect, from: number, to: number): Rect {
  const above = Math.max(0, from - to);
  return { x: final.x, y: final.y - above, width: final.width, height: final.height + above };
}
