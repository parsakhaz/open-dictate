// The contract of a sheet page: one module per surface (pages.ts lists them). Main opens a page with its feature's
// data; the page draws it into its own element, as elements holding text nodes (never HTML from an agent), and
// talks back on its feature's IPC (`dictate:<feature>:<name>`).
export interface SheetPage {
  /** Draws the page with its data. Called again with new data while it stays open (main's sheet.update). */
  show(root: HTMLElement, payload: unknown): void;
  /** The page is closing: stop timers, drop listeners. */
  hide?(): void;
  /**
   * A key while the sheet has focus. Return true when the page used it; Esc closes the sheet unless the page uses
   * it first (to step back out of a lightbox, say).
   */
  key?(e: KeyboardEvent): boolean;
}
