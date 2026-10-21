import { pillRegion } from '../core/pillregion';

interface PillInput {
  setIgnoreMouseEvents(ignore: boolean, options?: { forward: boolean }): void;
  setShape(rects: ReturnType<typeof pillRegion>): void;
}

/** Windows: input ownership follows visible controls, independent of hover. */
export function applyPillRegion(pill: PillInput, rects: unknown, interactive: unknown): boolean {
  const region = pillRegion(rects);
  const passesClicks = interactive !== true || region.length === 0;
  // Empty shape resets the full window: stop input before removing the region.
  if (passesClicks) pill.setIgnoreMouseEvents(true, { forward: true });
  pill.setShape(region);
  if (!passesClicks) pill.setIgnoreMouseEvents(false);
  return passesClicks;
}
