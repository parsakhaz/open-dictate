// Shared CLI input validation and discovery; MCP continues to use the same parsers.
import { parseAsk, parseNotify } from './agenttools';
import { type Origin, REQUEST_KINDS, REQUEST_LIMITS, RequestError, type RequestInput } from './requests';
import { listedTools } from './tools';
import { parseApprove } from './tools/approve';
import { parseDecide } from './tools/decide';
import { parseLineup } from './tools/lineup';
import { parsePeekArgs } from './tools/peek';

export function object(x: unknown): Record<string, unknown> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new RequestError('invalid_input', 'Expected a JSON object');
  return x as Record<string, unknown>;
}
export function originOf(x: unknown): Origin {
  const a = object(x);
  for (const [key, value] of Object.entries(a))
    if (
      !['id', 'machine', 'agent', 'workspace', 'pane_id', 'panel_id'].includes(key) ||
      typeof value !== 'string' ||
      value.length > 500 ||
      [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
      throw new RequestError('invalid_input', 'Origin fields must be bounded single-line strings');
  if (typeof a.id !== 'string' || !a.id.trim() || a.id.length > 200) throw new RequestError('invalid_input', 'Origin needs a stable bounded id');
  return a as Origin;
}
export function validateRequest(raw: unknown, cwd: string): RequestInput {
  const a = object(raw);
  if (!REQUEST_KINDS.includes(a.kind as RequestInput['kind']))
    throw new RequestError('invalid_input', 'Only notify, ask, decide, approve, lineup and peek are supported');
  const kind = a.kind as RequestInput['kind'];
  const args = object(a.args);
  const parsers = {
    notify: parseNotify,
    ask: parseAsk,
    decide: parseDecide,
    approve: parseApprove,
    lineup: parseLineup,
    peek: parsePeekArgs,
  };
  let effective: ReturnType<(typeof parsers)[typeof kind]>;
  try {
    effective = parsers[kind](args);
  } catch {
    throw new RequestError('invalid_input', `Invalid ${kind} arguments; consult dictate schema ${kind} --json`);
  }
  const { truncated, ...normalized } = effective;
  // peek.wait is an MCP observation option; CLI always owns and captures the full result.
  if (kind === 'peek') Object.assign(normalized, { wait: true });
  if (a.retry_key !== undefined && (typeof a.retry_key !== 'string' || !a.retry_key.trim()))
    throw new RequestError('invalid_input', 'Retry key must be a nonempty string');
  if (a.instance !== undefined && typeof a.instance !== 'string') throw new RequestError('invalid_input', 'Instance must be a string');
  return {
    kind,
    args: structuredClone(args),
    effective: normalized,
    warnings: truncated ? ['Input was truncated by the shared MCP runtime parser.'] : [],
    cwd,
    ...(a.origin !== undefined ? { origin: originOf(a.origin) } : {}),
    ...(a.retry_key !== undefined ? { retry_key: a.retry_key as string } : {}),
    ...(a.instance !== undefined ? { instance: a.instance as string } : {}),
  };
}
export function requestSchema(kind?: string) {
  if (kind && kind !== 'request' && !REQUEST_KINDS.includes(kind as RequestInput['kind'])) throw new RequestError('invalid_input', 'Unknown schema');
  return {
    schema_version: 1,
    retention: 'app_lifetime_only',
    restart: 'Requests and results are lost on app restart. Never automatically replay a stale-instance operation.',
    kinds: REQUEST_KINDS,
    inputs: Object.fromEntries(
      listedTools()
        .filter((t) => REQUEST_KINDS.includes(t.name as RequestInput['kind']) && (!kind || kind === 'request' || kind === t.name))
        .map((t) => [t.name, t.inputSchema]),
    ),
    create: {
      kind: 'attention kind',
      args: 'exact MCP arguments',
      origin: 'optional bounded display metadata',
      retry_key: 'optional stable key; requires saved instance',
      instance: 'status.instance_id',
    },
    receipt: [
      'schema_version',
      'request_id',
      'instance_id',
      'kind',
      'state',
      'terminal',
      'card_id',
      'created_at',
      'updated_at',
      'presentation',
      'warnings',
      'origin',
      'destination',
      'lifetime',
      'hard_expires_at',
      'terminal_retention_ms',
      'retry_retention',
    ],
    result: {
      notify: ['status', 'reason', 'text', 'raw', 'choice', 'replaced_by'],
      ask: ['answered', 'text', 'raw', 'choice', 'reason', 'card_id'],
      decide: ['answered', 'via', 'answers', 'raw', 'partial', 'reason', 'card_id'],
      approve: ['approved', 'changes', 'raw', 'answered', 'reason', 'card_id'],
      lineup: ['answered', 'picks', 'ranked', 'none', 'comment', 'raw', 'reason', 'card_id'],
      peek: ['answered', 'text', 'raw', 'url', 'pointed', 'region', 'crop', 'crop_absence', 'reason', 'card_id'],
    },
    errors: [
      'invalid_input',
      'app_unavailable',
      'authentication_failed',
      'unsupported_version',
      'transport_failure',
      'state_lost',
      'instance_changed',
      'not_found',
      'retry_conflict',
      'result_expired',
      'capacity_exceeded',
    ],
    exit_codes: {
      success: 0,
      input: 2,
      transport: 3,
      state: 4,
      interrupted: 130,
    },
    limits: REQUEST_LIMITS,
    timeouts: {
      observer_default_s: 45,
      observer_max_s: 600,
      zero: 'poll',
      answer: 'MCP timeout_s; held/snoozed time pauses CLI answer budget',
      absolute_lifetime_s: 86400,
    },
    normalization:
      'Uses current MCP runtime parsers, which may truncate or clamp inputs more permissively than the advertised schemas. Multiple lineup picks remain ranked in many mode.',
  };
}
