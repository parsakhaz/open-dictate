// Decision cards (lane L1): whether they open expanded in the sheet. The expand and shrink controls set it; there
// is no Settings page field. Pure.
import { bool, obj } from './fields';

export interface DecideSettings {
  /** Decision cards open in the sheet with every question laid out, instead of compact on the pill. */
  expanded: boolean;
}

export const DEFAULT_DECIDE: DecideSettings = { expanded: false };

export function parseDecideSettings(x: unknown, d: DecideSettings = DEFAULT_DECIDE): DecideSettings {
  return { expanded: bool(obj(x).expanded, d.expanded) };
}
