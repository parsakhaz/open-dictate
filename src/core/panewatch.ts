// Pane through its published CLI, runpane: how to launch it safely, the watch that follows agent states, and what
// each event means for the pill. Never Pane's raw daemon socket. Pure.
import path from 'node:path';
import { cleanMessage, cleanText } from './agenttext';
import { CAPS } from './agenttools';
import { fitPlain } from './cardtext';

export interface Launch {
  file: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * How to run runpane. On Windows the `.cmd` shim is read and its Pane executable run directly with the bundled
 * script, so nothing passes through cmd.exe's parsing (a dictated reply can hold & | ^ %). Elsewhere the shell
 * shim is run as a program. Null when Pane's CLI isn't installed.
 */
export function runpaneLaunch(paneDir: string, platform: NodeJS.Platform, read: (file: string) => string | null): Launch | null {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const bin = join(paneDir, 'bin');
  if (platform !== 'win32') {
    const shim = join(bin, 'runpane');
    return read(shim) === null ? null : { file: shim, args: [], env: { PANE_DIR: paneDir } };
  }
  const cmd = read(join(bin, 'runpane.cmd'));
  if (cmd === null) return null;
  const m = cmd.match(/^\s*"([^"]+\.exe)"\s+"([^"]+\.c?js)"\s+%\*\s*$/im);
  if (!m) return null;
  return { file: m[1], args: [m[2]], env: { PANE_DIR: paneDir, ELECTRON_RUN_AS_NODE: '1' } };
}

/** How long a tab stays blocked or ready before it becomes a card; tune on real use. */
export const WATCH_SETTLE = { blockedMs: 5000, readyMs: 10_000 };
export const WATCH_KINDS = ['agent.blocked', 'agent.ready', 'agent.busy', 'agent.report', 'panel.exited', 'pane.gone'];
export const CONSUMER = 'dictate';

export function watchArgs(): string[] {
  return [
    'watch', '--follow', '--as', CONSUMER, '--from', 'now', '--json',
    '--kinds', WATCH_KINDS.join(','),
    '--blocked-settle', String(WATCH_SETTLE.blockedMs),
    '--ready-settle', String(WATCH_SETTLE.readyMs),
    '--min-interval', '0',
    '--no-held-input',
  ];
}

export interface WatchEvent {
  kind: string;
  at: string;
  paneId: string;
  paneName: string;
  panelId?: string;
  panelTitle?: string;
  agentType?: string;
  report?: { state?: string; question?: string; summary?: string };
}

/**
 * One line of `runpane watch --json`. Cursor resets, drops, heartbeats, the start-up snapshot and anything from
 * before the watch attached are skipped, so a restart never replays old events as cards.
 */
export function parseWatchLine(line: string, attachedAt: number): WatchEvent | null {
  try {
    return parseWatchEntry(JSON.parse(line), attachedAt);
  } catch {
    return null;
  }
}

export function parseWatchEntry(entry: unknown, attachedAt: number): WatchEvent | null {
  const e = entry as Record<string, unknown>;
  if (!e || typeof e !== 'object' || typeof e.kind !== 'string' || e.kind.startsWith('_')) return null;
  if (e.baseline === true || e.replay === true) return null;
  const at = typeof e.at === 'string' ? Date.parse(e.at) : Number.NaN;
  if (!Number.isFinite(at) || at < attachedAt - 2000) return null;
  if (typeof e.paneId !== 'string') return null;
  const str = (x: unknown) => (typeof x === 'string' ? x : undefined);
  const r = e.report && typeof e.report === 'object' ? (e.report as Record<string, unknown>) : undefined;
  return {
    kind: e.kind,
    at: e.at as string,
    paneId: e.paneId,
    paneName: str(e.paneName) ?? 'Pane',
    panelId: str(e.panelId),
    panelTitle: str(e.panelTitle),
    agentType: str(e.agentType),
    ...(r ? { report: { state: str(r.state), question: str(r.question), summary: str(r.summary) } } : {}),
  };
}

export type PaneAction =
  /** The tab needs the person; `title`/`message` are set when a report said why, else they come from its last reply. */
  | { type: 'blocked'; paneId: string; panelId: string; title?: string; message?: string }
  | { type: 'finished'; paneId: string; panelId: string; title?: string; message?: string }
  /** The tab is working again (or answered in Pane): its card goes. */
  | { type: 'clear'; paneId: string; panelId: string }
  | { type: 'clear-pane'; paneId: string }
  | null;

/** Pane's words, shared with its own alerts. */
export const WORDS = { blocked: 'Needs your input', finished: 'Finished', failed: 'Failed' } as const;

export function actionFor(e: WatchEvent): PaneAction {
  if (e.kind === 'pane.gone') return { type: 'clear-pane', paneId: e.paneId };
  if (!e.panelId) return null;
  const at = { paneId: e.paneId, panelId: e.panelId };
  switch (e.kind) {
    case 'agent.blocked':
      return { type: 'blocked', ...at };
    case 'agent.ready':
      return { type: 'finished', ...at };
    case 'agent.busy':
    case 'panel.exited':
      return { type: 'clear', ...at };
    case 'agent.report': {
      const r = e.report ?? {};
      const summary = cleanMessage(r.summary, CAPS.kept).text || undefined;
      if (r.state === 'blocked') return { type: 'blocked', ...at, title: fitPlain(r.question, CAPS.title).text || WORDS.blocked, message: summary };
      if (r.state === 'failed') return { type: 'blocked', ...at, title: WORDS.failed, message: summary };
      if (r.state === 'done' || r.state === 'ready') return { type: 'finished', ...at, title: WORDS.finished, message: summary };
      return null;
    }
    default:
      return null;
  }
}

const AGENTS: Record<string, string> = { claude: 'Claude', 'claude-code': 'Claude', codex: 'Codex', 'codex-mcp-client': 'Codex', cursor: 'Cursor', 'cursor-vscode': 'Cursor' };

/** The agent's short name: Pane's agent type, else the MCP client's title or name ("Claude Code" and claude-code read Claude). */
function agentName(agentType: string | undefined, client: { name: string; title?: string } | undefined): string {
  const known = (s: string | undefined) => (s ? AGENTS[s.toLowerCase().replace(/\s+/g, '-')] : undefined);
  const name = known(agentType) || (client && (known(client.title) || client.title || known(client.name) || client.name)) || agentType;
  return cleanText(name, 20).text || 'Agent';
}

/** "<repo> / <name>", either one alone when the other is missing or the same. */
function project(repo: string | undefined, name: string | undefined): string {
  const parts = [cleanText(repo, 30).text, cleanText(name, 40).text].filter(Boolean);
  return [...new Set(parts)].join(' / ');
}

/** In Pane: "<agent> · <repo> / <Pane name>", e.g. "Claude · bloom-mono / P0 No-reply mode". */
export function paneSourceLine(tab: { paneName: string; repoName?: string; agentType?: string }, client?: { name: string; title?: string }): string {
  return `${agentName(tab.agentType, client)} · ${project(tab.repoName, tab.paneName) || 'Pane tab'}`;
}

/** Outside Pane: "<agent> · <folder>", or "<agent> · <repo> / <worktree>" for a folder under a repo's worktrees. */
export function clientSourceLine(client: { name: string; title?: string }, cwd: string): string {
  const dirs = cwd.split(/[\\/]/).filter(Boolean);
  const name = dirs.at(-1);
  const where = dirs.at(-2) === 'worktrees' ? project(dirs.at(-3), name) : project(undefined, name);
  return where ? `${agentName(undefined, client)} · ${where}` : agentName(undefined, client);
}

/** A Pane Session, as `runpane sessions list|get|create --json` gives it: its chat panel is `panelIds[agent]`. */
export interface PaneSession {
  id: string;
  name: string;
  archived: boolean;
  agent: string;
  /** The hidden Pane that owns the Session's chat (what its panels report as their Pane). */
  internalSessionId: string;
  panelIds: Record<string, string>;
}

export function parseSession(x: unknown): PaneSession | null {
  const s = x as Record<string, unknown>;
  if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !s.id) return null;
  const panelIds: Record<string, string> = {};
  if (s.panelIds && typeof s.panelIds === 'object') for (const [k, v] of Object.entries(s.panelIds)) if (typeof v === 'string' && v) panelIds[k] = v;
  return {
    id: s.id,
    name: typeof s.name === 'string' ? s.name : '',
    archived: s.archived === true,
    agent: typeof s.agent === 'string' ? s.agent : 'claude',
    internalSessionId: typeof s.internalSessionId === 'string' ? s.internalSessionId : '',
    panelIds,
  };
}

/** The Session's chat panel: the one for its current agent. */
export function sessionPanel(s: PaneSession): string | null {
  return s.panelIds[s.agent] ?? null;
}

/** The pane:// link that opens one tab; Pane validates it. */
export function paneLink(paneId: string, panelId: string): string {
  return `pane://open?pane=${encodeURIComponent(paneId)}&panel=${encodeURIComponent(panelId)}`;
}

/** Restart delays for a watch that ended: quick at first, then at most once a minute while Pane is away. */
export function backoffMs(failures: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, failures - 1));
}
