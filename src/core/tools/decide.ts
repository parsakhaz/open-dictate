// decide: one to four questions in one grown card, answered by click, number keys or one spoken sentence. The
// definition, and the checks that turn an agent's arguments into something the card may show. Pure.
import { cleanText } from '../agenttext';
import { ASK_TIMEOUT, CARD_RULE, CAPS, cardMessage, ToolInputError } from '../agenttools';
import { fitPlain } from '../cardtext';
import type { ToolModule } from './types';

export const DECIDE_CAPS = { questions: 4, options: 4, header: 12, question: 120, label: 24, description: 80, preview: 1200, id: 40 } as const;
export const DECIDE_TIMEOUT_S = 300;

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
    id: { type: 'string', description: 'Your id for the answer, different for each question; default q1, q2…' },
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
  enabled: true,
  def: {
    name: 'decide',
    title: 'Ask several things at once',
    description: `Ask the person one to four questions in one card on Dictate's pill and wait for all the answers: clicks, number keys, or one spoken sentence. Give each option a short label and what picking it means; add a text or code preview only when seeing the change helps (it opens a wider sheet). ${CARD_RULE} Returns {answered: true, via, answers: [{id, header, picked, other?}], raw?, card_id} or {answered: false, reason, partial?, card_id}.`,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The outcome in plain words, cut at 60 characters.' },
        message: { type: 'string', description: 'What you are deciding and why, about 280 characters shown.' },
        questions: { type: 'array', minItems: 1, maxItems: 4, items: question },
        timeout_s: { type: 'number', minimum: 1, maximum: ASK_TIMEOUT.maxS, description: 'Seconds to wait; default 300, at most 600. On timeout the card stays up until the person acts: card_status reports a later answer.' },
      },
      required: ['title', 'questions'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
};

export interface Preview {
  kind: 'text' | 'code';
  content: string;
}

export interface DecideOption {
  label: string;
  description: string;
  preview: Preview | null;
}

export interface DecideQuestion {
  id: string;
  header: string;
  question: string;
  options: DecideOption[];
  multi: boolean;
  /** "Other… (hold to say)" is offered: words that match no option answer it. */
  other: boolean;
}

export interface DecideArgs {
  title: string;
  message: string;
  questions: DecideQuestion[];
  timeoutS: number;
  /** Some option has a preview: the wide sheet shows them. */
  previews: boolean;
  truncated: boolean;
}

const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {});

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

/** A preview keeps its lines and indentation (it is code), without escape codes or control characters; cut at its cap. */
export function cleanPreview(input: unknown): Preview | null {
  const p = obj(input);
  if (typeof p.content !== 'string') return null;
  const lines = p.content
    .replace(ESCAPES, '')
    .split(/\r\n|\r|\n/)
    .map((l) => l.replace(/\t/g, '  ').replace(CONTROL, '').trimEnd());
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  let content = lines.join('\n');
  if (!content) return null;
  const chars = [...content];
  if (chars.length > DECIDE_CAPS.preview) content = `${chars.slice(0, DECIDE_CAPS.preview - 1).join('').trimEnd()}…`;
  return { kind: p.kind === 'code' ? 'code' : 'text', content };
}

export function parseDecide(input: unknown): DecideArgs {
  const a = obj(input);
  const title = fitPlain(a.title, CAPS.title);
  if (!title.text) throw new ToolInputError('decide needs a title');
  const message = cardMessage(a.message);
  let truncated = title.truncated || message.truncated;
  if (!Array.isArray(a.questions) || a.questions.length < 1) throw new ToolInputError('decide needs one to four questions');
  if (a.questions.length > DECIDE_CAPS.questions) throw new ToolInputError('decide takes at most four questions; ask the rest in a second call');
  // The agent matches answers by its own ids, so a clash is refused rather than renamed (#27).
  const given = a.questions.map((raw) => cleanText(obj(raw).id, DECIDE_CAPS.id).text);
  given.forEach((id, i) => {
    const first = given.indexOf(id);
    if (id && first < i) throw new ToolInputError(`questions ${first + 1} and ${i + 1} share the id "${id}"; give each question its own id`);
  });
  const ids = new Set(given.filter(Boolean));
  const questions = a.questions.map((raw, i): DecideQuestion => {
    const q = obj(raw);
    const text = cleanText(q.question, DECIDE_CAPS.question);
    if (!text.text) throw new ToolInputError(`question ${i + 1} needs its question`);
    const header = cleanText(q.header, DECIDE_CAPS.header);
    truncated ||= text.truncated || header.truncated;
    const options: DecideOption[] = [];
    for (const o of Array.isArray(q.options) ? q.options : []) {
      const label = cleanText(obj(o).label, DECIDE_CAPS.label);
      if (!label.text || options.some((x) => x.label.toLowerCase() === label.text.toLowerCase())) continue;
      const description = cleanText(obj(o).description, DECIDE_CAPS.description);
      truncated ||= label.truncated || description.truncated;
      options.push({ label: label.text, description: description.text, preview: cleanPreview(obj(o).preview) });
    }
    if (options.length < 2) throw new ToolInputError(`question ${i + 1} needs two to four options with different labels`);
    if (options.length > DECIDE_CAPS.options) throw new ToolInputError(`question ${i + 1} has more than four options`);
    let id = given[i];
    if (!id) {
      id = `q${i + 1}`;
      while (ids.has(id)) id = `${id}_`;
      ids.add(id);
    }
    return { id, header: header.text || `Q${i + 1}`, question: text.text, options, multi: q.multi === true, other: q.other !== false };
  });
  const t = typeof a.timeout_s === 'number' && Number.isFinite(a.timeout_s) ? a.timeout_s : DECIDE_TIMEOUT_S;
  return {
    title: title.text,
    message: message.text,
    questions,
    timeoutS: Math.round(Math.min(ASK_TIMEOUT.maxS, Math.max(1, t))),
    previews: questions.some((q) => q.options.some((o) => o.preview)),
    truncated,
  };
}
