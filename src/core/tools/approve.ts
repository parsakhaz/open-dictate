// approve: a plan in a few bullets with Approve, or the person's spoken change. The definition, and the checks that
// turn an agent's arguments into something the card may show. Pure.
import { cleanText, safeLink } from '../agenttext';
import { ASK_TIMEOUT, CARD_RULE, ToolInputError } from '../agenttools';
import type { ToolModule } from './types';

export const APPROVE_CAPS = { title: 60, lines: 6, line: 100 } as const;
export const APPROVE_TIMEOUT_S = 600;

export const approve: ToolModule = {
  enabled: true,
  def: {
    name: 'approve',
    title: 'Ask for approval',
    description: `Ask the person to approve a plan on Dictate's pill: one click approves, or they say what to change. ${CARD_RULE} Returns {approved: true, card_id}, {approved: false, changes, raw, card_id}, or {answered: false, reason, card_id}.`,
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

export type Risk = 'low' | 'medium' | 'high';

export interface ApproveArgs {
  title: string;
  summary: string[];
  risk: Risk | null;
  link: { url: string; host: string } | null;
  timeoutS: number;
  truncated: boolean;
}

export function parseApprove(input: unknown): ApproveArgs {
  const a = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const title = cleanText(a.title, APPROVE_CAPS.title);
  if (!title.text) throw new ToolInputError('approve needs a title');
  let truncated = title.truncated;
  const summary: string[] = [];
  for (const line of Array.isArray(a.summary) ? a.summary : []) {
    const l = cleanText(line, APPROVE_CAPS.line);
    truncated ||= l.truncated;
    if (l.text) summary.push(l.text);
  }
  if (summary.length > APPROVE_CAPS.lines) {
    summary.length = APPROVE_CAPS.lines;
    truncated = true;
  }
  if (a.link !== undefined && a.link !== null && a.link !== '' && !safeLink(a.link)) throw new ToolInputError('link must be an https URL');
  const t = typeof a.timeout_s === 'number' && Number.isFinite(a.timeout_s) ? a.timeout_s : APPROVE_TIMEOUT_S;
  return {
    title: title.text,
    summary,
    risk: a.risk === 'low' || a.risk === 'medium' || a.risk === 'high' ? a.risk : null,
    link: safeLink(a.link),
    timeoutS: Math.round(Math.min(ASK_TIMEOUT.maxS, Math.max(1, t))),
    truncated,
  };
}
