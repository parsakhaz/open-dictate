// peek: a localhost page, a local HTML report or an allowlisted page as a card that grows into a docked view the
// person points at and talks over. The definition only; lane L5 turns it on and registers its handler. Pure.
import { ASK_TIMEOUT, CARD_RULE } from '../agenttools';
import type { ToolModule } from './types';

export const peek: ToolModule = {
  enabled: false,
  def: {
    name: 'peek',
    title: 'Show a page and listen',
    description: `Show the person a page on Dictate's pill (http://localhost, a local .html inside your working folder, or an https host they allowed) and wait for what they say about it, with the element they pointed at and a crop. ${CARD_RULE} Returns {answered: true, text, raw, pointed?, region?, url, crop} or {answered: false, reason, card_id}.`,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What to look at, cut at 60 characters.' },
        message: { type: 'string', description: 'About 280 characters shown.' },
        target: { type: 'string', description: 'http(s)://localhost or 127.0.0.1 (any port), an allowlisted https URL, or a local .html path inside your working folder.' },
        ask: { type: 'string', description: 'What you want them to tell you about it.' },
        wait: { type: 'boolean', description: 'false: return at once with card_id. Default true.' },
        keep_open: { type: 'boolean', description: 'Leave the view up for the next remark. Default false.' },
        timeout_s: { type: 'number', minimum: 1, maximum: ASK_TIMEOUT.maxS, description: 'Seconds to wait; default 600, at most 600.' },
      },
      required: ['title', 'target'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
};
