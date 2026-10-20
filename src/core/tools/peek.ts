// peek: a localhost page, a local HTML report or an allowlisted page as a card that grows into a docked view the
// person points at and talks over. The definition, its arguments, which pages it may show and where they may go.
// The handler lives with the feature (src/main/features/peek.ts). Pure.
import path from 'node:path';
import { cleanMessage, cleanText } from '../agenttext';
import { ASK_TIMEOUT, CARD_RULE, ToolInputError } from '../agenttools';
import { obj } from '../sections/fields';
import type { ToolModule } from './types';

export const peek: ToolModule = {
  enabled: true,
  def: {
    name: 'peek',
    title: 'Show a page and listen',
    description: `Show the person a page on Dictate's pill (http://localhost, a local .html inside your working folder, or an https host they allowed) and wait for what they say about it, with the element they pointed at and a crop. It arrives as a card; the page opens big only when they choose Peek. ${CARD_RULE} Returns {answered: true, text, raw, pointed?, region?, url, crop?, card_id} (crop is a PNG file path) or {answered: false, reason, card_id}.`,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What to look at, cut at 60 characters.' },
        message: { type: 'string', description: 'About 280 characters shown.' },
        target: { type: 'string', description: 'http(s)://localhost or 127.0.0.1 (any port), an allowlisted https URL, or a local .html path inside your working folder.' },
        ask: { type: 'string', description: 'What you want them to tell you about it.' },
        wait: { type: 'boolean', description: 'false: return at once with card_id; their words then go to your Pane tab. Default true.' },
        keep_open: { type: 'boolean', description: 'Leave the view up for the next remark. Default false.' },
        timeout_s: { type: 'number', minimum: 1, maximum: ASK_TIMEOUT.maxS, description: 'Seconds to wait; default 600, at most 600.' },
      },
      required: ['title', 'target'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
};

export interface PeekArgs {
  title: string;
  message: string;
  target: string;
  ask: string;
  wait: boolean;
  keepOpen: boolean;
  timeoutS: number;
  truncated: boolean;
}

export function parsePeekArgs(input: unknown): PeekArgs {
  const a = obj(input);
  const title = cleanText(a.title, 60);
  if (!title.text) throw new ToolInputError('peek needs a title');
  if (typeof a.target !== 'string' || !a.target.trim()) throw new ToolInputError('peek needs a target: a localhost URL, an allowed https URL or a local .html path');
  const message = cleanMessage(a.message, 280);
  const ask = cleanText(a.ask, 120);
  const t = typeof a.timeout_s === 'number' && Number.isFinite(a.timeout_s) ? a.timeout_s : ASK_TIMEOUT.maxS;
  return {
    title: title.text,
    message: message.text,
    target: a.target.trim(),
    ask: ask.text,
    wait: a.wait !== false,
    keepOpen: a.keep_open === true,
    timeoutS: Math.round(Math.min(ASK_TIMEOUT.maxS, Math.max(1, t))),
    truncated: title.truncated || message.truncated || ask.truncated,
  };
}

/** What a peek shows: a web page by URL, or an HTML file inside the agent's working folder (served by Dictate's protocol). */
export type PeekTarget = { kind: 'web'; url: string; origin: string; host: string; local: boolean } | { kind: 'file'; file: string; root: string };

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export const isLocalHost = (hostname: string) => LOCAL_HOSTS.includes(hostname.toLowerCase()) || hostname.toLowerCase().endsWith('.localhost');

/** The host or one of its parents is on the person's list ("rungrain.com" allows "app.rungrain.com"). */
export function hostAllowed(hostname: string, hosts: string[]): boolean {
  const h = hostname.toLowerCase();
  return hosts.some((a) => h === a || h.endsWith(`.${a}`));
}

/** A URL a peek may load: http(s) on this computer, or https on an allowed host. Never file:, data: or anything else. */
export function urlAllowed(url: string, hosts: string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (isLocalHost(u.hostname)) return u.protocol === 'http:' || u.protocol === 'https:';
  return u.protocol === 'https:' && hostAllowed(u.hostname, hosts);
}

/** `p` is `root` or inside it (both resolved). */
export function inside(root: string, p: string, paths: typeof path = path): boolean {
  const rel = paths.relative(paths.resolve(root), paths.resolve(p));
  return rel === '' || (!!rel && !rel.startsWith('..') && !paths.isAbsolute(rel));
}

/**
 * Checks an agent's target against the rules: localhost (any port), an allowed https host, or a .html file inside
 * its working folder. Throws a ToolInputError that says what was refused.
 */
export function checkTarget(target: string, o: { cwd: string; hosts: string[]; paths?: typeof path }): PeekTarget {
  const paths = o.paths ?? path;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    let u: URL;
    try {
      u = new URL(target);
    } catch {
      throw new ToolInputError('peek: that target is not a valid URL');
    }
    if (u.protocol === 'file:') throw new ToolInputError('peek: pass a local file as a path inside your working folder, not a file:// URL');
    if (!urlAllowed(u.href, o.hosts)) {
      if (u.protocol === 'http:' && !isLocalHost(u.hostname)) throw new ToolInputError('peek: remote pages load over https only');
      throw new ToolInputError(`peek: ${u.hostname} is not on the person's peek list (Settings → Agents → Peek); only they can add it`);
    }
    return { kind: 'web', url: u.href, origin: u.origin, host: u.host, local: isLocalHost(u.hostname) };
  }
  if (!o.cwd) throw new ToolInputError('peek: a local file needs a working folder, and this session has none');
  const file = paths.resolve(o.cwd, target);
  if (!inside(o.cwd, file, paths)) throw new ToolInputError('peek: that file is outside your working folder');
  if (!/\.html?$/i.test(file)) throw new ToolInputError('peek: a local file must be an .html page');
  return { kind: 'file', file, root: paths.resolve(o.cwd) };
}

/**
 * Where a link, redirect or script may take the page: on within its own origin, or (any other allowed-looking
 * http(s) address) only after the person's "Allow once". Anything else never loads.
 */
export function navigation(from: string, to: string): 'go' | 'ask' | 'refuse' {
  let a: URL;
  let b: URL;
  try {
    a = new URL(from);
    b = new URL(to);
  } catch {
    return 'refuse';
  }
  if (a.origin === b.origin && a.origin !== 'null') return 'go';
  return b.protocol === 'http:' || b.protocol === 'https:' ? 'ask' : 'refuse';
}

/** What the card and the docked view's chip show for a page: host and path, without the scheme. */
export function shortUrl(url: string, cap = 48): string {
  let s = url;
  try {
    const u = new URL(url);
    s = u.protocol === 'dictate-peek:' ? decodeURIComponent(u.pathname.split('/').pop() ?? '') : `${u.host}${u.pathname === '/' ? '' : u.pathname}${u.search}`;
  } catch {
    // shown as given
  }
  return s.length > cap ? `${s.slice(0, cap - 1)}…` : s;
}
