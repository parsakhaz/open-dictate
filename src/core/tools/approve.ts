// approve: a plan in a few bullets with Approve, or the person's spoken change. The definition only; lane L1 turns
// it on and registers its handler. Pure.
import { ASK_TIMEOUT, CARD_RULE } from '../agenttools';
import type { ToolModule } from './types';

export const approve: ToolModule = {
  enabled: false,
  def: {
    name: 'approve',
    title: 'Ask for approval',
    description: `Ask the person to approve a plan on Dictate's pill: one click approves, or they say what to change. ${CARD_RULE} Returns {approved: true}, {approved: false, changes, raw}, or {answered: false, reason, card_id}.`,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What they approve, in plain words, cut at 60 characters.' },
        summary: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 100 }, description: 'The plan in up to six short lines.' },
        risk: { type: 'string', enum: ['low', 'medium', 'high'], description: 'high: only a click approves.' },
        link: { type: 'string', description: 'Optional https link to the whole plan, opened only if they click it.' },
        timeout_s: { type: 'number', minimum: 1, maximum: ASK_TIMEOUT.maxS, description: 'Seconds to wait; default 600, at most 600.' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
};
