// What the pill's cards are drawn from (sent by main), and the contract of a card body: one module per card kind,
// listed in bodies.ts. A body draws everything under the card's head (source, +N, ✕), as elements holding text
// nodes; never HTML from an agent.
import type { CardKind } from '../../core/cards';

export interface CardDto {
  id: string;
  kind: CardKind;
  urgency: 'info' | 'needs_you' | 'consent';
  source: string;
  sourceDetail?: string;
  title: string;
  message: string;
  choices: string[];
  linkHost: string | null;
  canOpen: boolean;
  canReply: boolean;
  /** A surface card's own data (decide's questions, lineup's thumbnails). */
  data?: unknown;
}

export interface CardsView {
  top: CardDto | null;
  more: number;
  list: CardDto[];
  replying: boolean;
  /** The card whose "Hold to reply" was clicked, until the next dictation. */
  armed?: string;
  /** The queue's own summary (the inbox's held and snoozed counts), for the pill's extras. */
  extra?: Record<string, unknown>;
}

/**
 * Something on the pill beyond the top card and its list: the inbox's badge, held capsule, snooze chips, toast and
 * shelf (L2). Its clickable areas go to main as `dictate:extra-rects` (CSS pixels in the pill window), so the
 * pill preserves hover disclosure there, and stays up while there are any.
 */
export interface PillExtra {
  /** Once, when the pill page loads: its own elements, above the cards. */
  mount?(root: HTMLElement): void;
  /** The cards changed. */
  update?(view: CardsView): void;
  /** Appended to every card's body after its kind's own parts (snooze chips on an expanded card). */
  cardParts?(c: CardDto, ctx: BodyContext): HTMLElement[];
}

export type Action =
  | { id: string; action: 'open' | 'dismiss' | 'link' | 'review' | 'arm-reply' }
  | { id: string; action: 'choose'; value: string }
  | { id: string; action: 'consent'; value: 'once' | 'session' | 'deny' }
  /** One of a surface card's own buttons, handled by its kind in main. */
  | { id: string; action: 'kind'; name: string; value?: unknown };

export interface BodyContext {
  /** The pointer is over the card: buttons show. */
  expanded: boolean;
  /** The card is being answered by voice right now. */
  replying: boolean;
  /** Reply was clicked on this card: the next dictation answers it. */
  armed: boolean;
  /** A card button: sends the action and redraws. */
  button(label: string, a: Action, cls?: string): HTMLElement;
  act(a: Action): void;
}

export interface CardBody {
  /** The card's body: title, message and whatever the kind adds, in order. */
  parts(c: CardDto, ctx: BodyContext): HTMLElement[];
}
