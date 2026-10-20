// card_status: where a card an agent raised is now (held, shown, snoozed, answered…), and a late answer. The
// definition only; lane L2 turns it on and registers its handler. Pure.
import type { ToolModule } from './types';

export const cardStatus: ToolModule = {
  enabled: false,
  def: {
    name: 'card_status',
    title: 'Card status',
    description: 'Where a card you raised is now: held, shown, snoozed (with until), answered (with the answer, even one given after your call returned), dismissed or expired. Pass the card_id a tool returned.',
    inputSchema: {
      type: 'object',
      properties: { card_id: { type: 'string', description: 'The card_id from notify, ask, decide, approve, lineup or peek.' } },
      required: ['card_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
};
