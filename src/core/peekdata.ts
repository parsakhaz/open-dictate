// What main sends peek's card body and its docked sheet page: plain, already-checked data, never HTML. Pure.

/** A live thumbnail as RGBA pixels (base64): the pill draws it on a canvas. */
export interface PeekThumb {
  width: number;
  height: number;
  rgba: string;
}

export interface PeekCardData {
  /** Host and path, e.g. "localhost:5173/pricing", or the file name. */
  url: string;
  /** localhost or a local file (green dot), or an allowed https host. */
  local: boolean;
  file: boolean;
  /** What the agent wants to hear about it. */
  ask: string;
  thumb: PeekThumb | null;
  /** The thumbnail is still loading, or the page failed to load (its reason). */
  loading: boolean;
  failed?: string;
  /** It has a Pane tab to open the page beside. */
  canPane: boolean;
  /** The docked view is open for this card. */
  docked: boolean;
}

export interface PeekConfirm {
  /** The region's crop as a PNG data URL (the sheet allows data: images). */
  image: string;
  size: { width: number; height: number };
  words: string;
  under: { selector: string; text: string } | null;
  to: string;
}

export interface PeekSheetPayload {
  cardId: string;
  source: string;
  title: string;
  ask: string;
  url: string;
  local: boolean;
  /** A move off the page waiting on the person: Allow once or Stay. */
  blocked: { kind: 'navigate' | 'popup'; host: string; url: string } | null;
  /** The page left the agent's page after an Allow once: Back returns. */
  away: boolean;
  /** A dragged region waiting for Enter. */
  confirm: PeekConfirm | null;
  /** The key is held over the page: "Talking about …". */
  talking: string | null;
  /** QA screenshots: the page as an image under the chrome, since the docked window is separate. */
  snapshot?: string;
}

/** The sheet page's own messages back to main (`dictate:peek:<name>`). */
export type PeekSheetAction = 'shrink' | 'close' | 'browser' | 'allow' | 'stay' | 'home' | 'send' | 'drop';
