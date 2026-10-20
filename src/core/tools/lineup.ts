// lineup: two to six candidates (images or short texts) side by side; the person picks one, several or an order.
// The definition only; lane L4 turns it on and registers its handler. Pure.
import { ASK_TIMEOUT, CARD_RULE } from '../agenttools';
import type { ToolModule } from './types';

const candidate = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Your id, returned in picks.' },
    label: { type: 'string', maxLength: 24 },
    caption: { type: 'string', maxLength: 80 },
    image: { type: 'string', description: 'A PNG, JPEG, WebP or GIF (at most 10 MB) inside your working folder or the temp folder.' },
    text: { type: 'string', maxLength: 600, description: 'A short text candidate, instead of an image.' },
  },
  required: ['id', 'label'],
  additionalProperties: false,
};

export const lineup: ToolModule = {
  enabled: false,
  def: {
    name: 'lineup',
    title: 'Line up options',
    description: `Show the person two to six candidates side by side on Dictate's pill (mockups, images or short texts) and wait for their picks, by click, keys or voice. ${CARD_RULE} Returns {answered: true, picks, ranked, comment?, raw?} or {answered: false, reason, card_id}.`,
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
