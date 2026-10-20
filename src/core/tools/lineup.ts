// lineup: two to six candidates (images or short texts) side by side; the person picks one, several or an order.
// The definition and its arguments' rules; main checks the image files (src/main/features/lineup.ts). Pure.
import { cleanMessage, cleanText } from '../agenttext';
import { ASK_TIMEOUT, CARD_RULE, CAPS, ToolInputError } from '../agenttools';
import type { ToolModule } from './types';

export const LINEUP = { min: 2, max: 6, id: 40, label: 24, caption: 80, text: 600, imageBytes: 10 * 1024 * 1024, defaultTimeoutS: 600 } as const;

export type PickMode = 'one' | 'many' | 'rank';

export interface LineupCandidate {
  id: string;
  label: string;
  caption: string;
  /** The path as the agent sent it; main checks and reads it. */
  image?: string;
  text?: string;
}

export interface LineupArgs {
  title: string;
  message: string;
  candidates: LineupCandidate[];
  pick: PickMode;
  /** How many picks at most (1 for one). */
  max: number;
  timeoutS: number;
  truncated: boolean;
}

/** What the call returns once the person answers. */
export type LineupAnswer = { answered: true; picks: string[]; ranked: boolean; none?: true; comment?: string; raw?: string };

const candidate = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Your id, returned in picks.' },
    label: { type: 'string', maxLength: 24 },
    caption: { type: 'string', maxLength: 80 },
    image: { type: 'string', description: 'A PNG, JPEG, WebP, GIF or SVG (at most 10 MB) inside your working folder or the temp folder.' },
    text: { type: 'string', maxLength: 600, description: 'A short text candidate, instead of an image.' },
  },
  required: ['id', 'label'],
  additionalProperties: false,
};

export const lineup: ToolModule = {
  enabled: true,
  def: {
    name: 'lineup',
    title: 'Line up options',
    description: `Show the person two to six candidates side by side on Dictate's pill (mockups, images or short texts) and wait for their picks, by click, keys or voice. Each candidate has an image path or a text. Images must be local files in your working folder or the temp folder; no URLs. ${CARD_RULE} Returns {answered: true, picks, ranked, none?, comment?, raw?} with picks as your ids in the order chosen (ranked when that order means something), or {answered: false, reason, card_id}.`,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What they are picking, cut at 60 characters.' },
        message: { type: 'string', description: 'About 280 characters shown.' },
        candidates: { type: 'array', minItems: 2, maxItems: 6, items: candidate },
        pick: { type: 'string', enum: ['one', 'many', 'rank'], description: 'Default many (favourites).' },
        max: { type: 'number', minimum: 1, maximum: 6 },
        timeout_s: { type: 'number', minimum: 1, maximum: ASK_TIMEOUT.maxS, description: 'Seconds to wait; default 600, at most 600.' },
      },
      required: ['title', 'candidates'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
};

const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {});

/** Anything with a scheme ("https://", "file:", "data:") is a URL, not a local path. A Windows drive ("C:\") isn't. */
export function looksLikeUrl(s: string): boolean {
  return /^[a-z][a-z0-9+.-]+:/i.test(s) && !/^[a-z]:[\\/]/i.test(s);
}

export function parseLineup(input: unknown): LineupArgs {
  const a = obj(input);
  const title = cleanText(a.title, CAPS.title);
  if (!title.text) throw new ToolInputError('lineup needs a title');
  const message = cleanMessage(a.message, CAPS.message);
  if (!Array.isArray(a.candidates) || a.candidates.length < LINEUP.min || a.candidates.length > LINEUP.max) {
    throw new ToolInputError(`lineup needs ${LINEUP.min} to ${LINEUP.max} candidates`);
  }
  let truncated = title.truncated || message.truncated;
  const ids = new Set<string>();
  const candidates = a.candidates.map((raw, i): LineupCandidate => {
    const c = obj(raw);
    const n = i + 1;
    const id = cleanText(c.id, LINEUP.id).text;
    if (!id) throw new ToolInputError(`candidate ${n} needs an id`);
    if (ids.has(id)) throw new ToolInputError(`candidate ids must differ ("${id}" twice)`);
    ids.add(id);
    const label = cleanText(c.label, LINEUP.label);
    if (!label.text) throw new ToolInputError(`candidate ${n} needs a label`);
    const caption = cleanText(c.caption, LINEUP.caption);
    truncated ||= label.truncated || caption.truncated;
    if (c.url !== undefined) throw new ToolInputError(`candidate ${n}: URL candidates aren't supported yet; send an image file or a text`);
    const hasImage = typeof c.image === 'string' && c.image.trim() !== '';
    const hasText = typeof c.text === 'string' && c.text.trim() !== '';
    if (hasImage === hasText) throw new ToolInputError(`candidate ${n} needs exactly one of image or text`);
    if (hasImage) {
      const image = (c.image as string).trim();
      if (looksLikeUrl(image)) throw new ToolInputError(`candidate ${n}: images must be local files, not URLs`);
      return { id, label: label.text, caption: caption.text, image };
    }
    const text = cleanMessage(c.text, LINEUP.text);
    truncated ||= text.truncated;
    return { id, label: label.text, caption: caption.text, text: text.text };
  });
  const pick: PickMode = a.pick === 'one' || a.pick === 'rank' ? a.pick : 'many';
  const askedMax = typeof a.max === 'number' && Number.isFinite(a.max) ? Math.round(a.max) : candidates.length;
  const max = pick === 'one' ? 1 : Math.min(candidates.length, Math.max(1, askedMax));
  const t = typeof a.timeout_s === 'number' && Number.isFinite(a.timeout_s) ? a.timeout_s : LINEUP.defaultTimeoutS;
  return { title: title.text, message: message.text, candidates, pick, max, timeoutS: Math.round(Math.min(ASK_TIMEOUT.maxS, Math.max(1, t))), truncated };
}

/**
 * The person's picks (candidate indexes, in the order chosen) as the call returns them: your ids, at most `max`,
 * and ranked when more than one was picked in an order that means something.
 */
export function answerFor(args: Pick<LineupArgs, 'candidates' | 'pick' | 'max'>, picks: number[], extra: { comment?: string; raw?: string } = {}): LineupAnswer {
  const seen = new Set<number>();
  const ids: string[] = [];
  for (const i of picks) {
    if (!Number.isInteger(i) || i < 0 || i >= args.candidates.length || seen.has(i)) continue;
    seen.add(i);
    ids.push(args.candidates[i].id);
    if (ids.length === args.max) break;
  }
  return {
    answered: true,
    picks: ids,
    ranked: args.pick !== 'one' && ids.length > 1,
    ...(ids.length ? {} : { none: true as const }),
    ...(extra.comment ? { comment: extra.comment } : {}),
    ...(extra.raw ? { raw: extra.raw } : {}),
  };
}
