// The pages the sheet window hosts, one per big surface: the wide decision sheet (L1), the round (L2), the lineup
// grid and lightbox (L4), the docked peek (L5). `stub` is P0's empty page, opened from QA. Pure.
export const SHEET_KINDS = ['stub', 'decide', 'round', 'lineup', 'peek'] as const;
export type SheetKind = (typeof SHEET_KINDS)[number];

export const isSheetKind = (x: unknown): x is SheetKind => SHEET_KINDS.includes(x as SheetKind);

/** What main sends a sheet page when it opens or its content changes. */
export interface SheetOpen {
  kind: SheetKind;
  /** The page's own data, from its feature: plain, already-checked data, never HTML. */
  payload: unknown;
}

/** Sheet sizes in CSS pixels: the wide sheet and docked peek are 760 wide, the round 480 (the approved mockups). */
export const SHEET_SIZES: Record<SheetKind, { width: number; height: number }> = {
  stub: { width: 480, height: 240 },
  decide: { width: 760, height: 460 },
  round: { width: 480, height: 420 },
  lineup: { width: 760, height: 520 },
  peek: { width: 760, height: 480 },
};
