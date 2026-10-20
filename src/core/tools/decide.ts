// decide: one to four questions in one grown card, answered by click, number keys or one spoken sentence. The
// definition only; lane L1 parses the arguments, turns the tool on and registers its handler. Pure.
import { ASK_TIMEOUT, CARD_RULE } from '../agenttools';
import type { ToolModule } from './types';

const preview = {
  type: 'object',
  properties: { kind: { type: 'string', enum: ['text', 'code'] }, content: { type: 'string', maxLength: 1200, description: 'Plain text, shown as text.' } },
  required: ['kind', 'content'],
  additionalProperties: false,
};

const option = {
  type: 'object',
  properties: {
    label: { type: 'string', maxLength: 24, description: 'The chip, e.g. "Staging".' },
    description: { type: 'string', maxLength: 80, description: 'What picking it means.' },
    preview,
  },
  required: ['label'],
  additionalProperties: false,
};

const question = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Your id for the answer; default q1, q2…' },
    header: { type: 'string', maxLength: 12, description: 'One or two words naming the question, e.g. "Where".' },
    question: { type: 'string', maxLength: 120 },
    options: { type: 'array', minItems: 2, maxItems: 4, items: option },
    multi: { type: 'boolean', description: 'They may pick several. Default false.' },
    other: { type: 'boolean', description: 'Offer "Other… (hold to say)". Default true.' },
  },
  required: ['header', 'question', 'options'],
  additionalProperties: false,
};

export const decide: ToolModule = {
  enabled: false,
  def: {
    name: 'decide',
    title: 'Ask several things at once',
    description: `Ask the person one to four questions in one card on Dictate's pill and wait for all the answers: clicks, number keys, or one spoken sentence. ${CARD_RULE} Returns {answered: true, via, answers, raw?} or {answered: false, reason, partial?, card_id}.`,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The outcome in plain words, cut at 60 characters.' },
        message: { type: 'string', description: 'What you are deciding and why, about 280 characters shown.' },
        questions: { type: 'array', minItems: 1, maxItems: 4, items: question },
        timeout_s: { type: 'number', minimum: 1, maximum: ASK_TIMEOUT.maxS, description: 'Seconds to wait; default 300, at most 600.' },
      },
      required: ['title', 'questions'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
};
