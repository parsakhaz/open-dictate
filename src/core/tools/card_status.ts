// card_status: where a card an agent raised is now (held, shown, snoozed, answered…), and a late answer. The
// definition; the inbox feature (src/main/features/inbox.ts) answers it from the card queue. Pure.
import type { ToolModule } from './types';

export const cardStatus: ToolModule = {
  enabled: true,
  def: {
    name: 'card_status',
    title: 'Card status',
    description:
      'Where a card you raised is now. Pass the card_id a tool returned. Returns {state, until?, answer?}: held (waiting while the person is busy), shown, snoozed (until: when it comes back), answered (answer: what they said or picked, even after your call returned, e.g. a spoken reply to a notify, or the answer to a question that timed out or was snoozed), dismissed, expired (a request that ran out of time), cancelled, or gone (no longer on the pill: an info card that faded, or a card Dictate no longer knows how it ended). Unknown ids return {state: "unknown"}.',
    inputSchema: {
      type: 'object',
      properties: { card_id: { type: 'string', description: 'The card_id from notify, ask, decide, approve, lineup or peek.' } },
      required: ['card_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
};
