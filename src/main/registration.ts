// Gives Claude Code, Codex and Cursor Dictate's tools (or takes them away): finds each agent, edits its user-level
// config, and reports per agent. One agent's failure never stops the others or reaches the caller. Claude Code is
// changed only through its own CLI. No Electron here: the caller decides when (packaged builds only) and passes
// the environment, so tests run against temp folders and a fake CLI.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  asServerEntry,
  CLAUDE_REMOVE_ARGS,
  claudeAddArgs,
  claudeEntry,
  codexOwnership,
  type Edit,
  editCodex,
  editCursor,
  HAND_WRITTEN,
  jsonOwnership,
  type ServerEntry,
  SERVER_NAME,
  sameJsonEntry,
  serverEntry,
} from '../core/registration';
import type { Logger } from './log';

export type AgentId = 'claude' | 'codex' | 'cursor';
export type ClaudeRunner = (args: string[]) => Promise<void>;
type Env = Record<string, string | undefined>;

export interface AgentOptions {
  /** Supplies HOME/USERPROFILE, CODEX_HOME, CLAUDE_CONFIG_DIR and PATH. */
  env: Env;
  platform?: NodeJS.Platform;
  /** The executable agents run as Node (process.execPath of the packaged app; APPIMAGE for an AppImage). */
  executable: string;
  bridgePath: string;
  /** Runs `claude <args>`; found on PATH when omitted. */
  runClaude?: ClaudeRunner;
  log: Logger;
}

export interface AgentOutcome {
  agent: AgentId;
  action: 'added' | 'updated' | 'removed' | 'unchanged' | 'skipped' | 'not-found';
  detail?: string;
}

export interface AgentState {
  agent: AgentId;
  /** Its config folder exists or its CLI is on PATH. */
  found: boolean;
  /** A `dictate` MCP server is configured, by Dictate or by hand. */
  registered: boolean;
  ownedByDictate: boolean;
  handWritten: boolean;
  error?: string;
}

const LABEL: Record<AgentId, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };
const CLI_TIMEOUT_MS = 30_000;

function homeDir(env: Env, platform: NodeJS.Platform): string {
  return (platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME) || os.homedir();
}

function paths(opts: AgentOptions) {
  const platform = opts.platform ?? process.platform;
  const home = homeDir(opts.env, platform);
  const codexHome = opts.env.CODEX_HOME || path.join(home, '.codex');
  return {
    platform,
    home,
    claudeConfig: path.join(opts.env.CLAUDE_CONFIG_DIR || home, '.claude.json'),
    codexHome,
    codexConfig: path.join(codexHome, 'config.toml'),
    cursorHome: path.join(home, '.cursor'),
    cursorConfig: path.join(home, '.cursor', 'mcp.json'),
  };
}

/** The first `name` on PATH (on Windows also .exe/.cmd/.bat), then the native installers' ~/.local/bin. */
export function findOnPath(name: string, env: Env, platform: NodeJS.Platform = process.platform): string | undefined {
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  dirs.push(path.join(homeDir(env, platform), '.local', 'bin'));
  for (const dir of dirs)
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {
        // keep looking
      }
    }
  return undefined;
}

/** Runs a CLI; an npm .cmd shim can only be run by cmd.exe, with each argument quoted. */
export function cliRunner(executable: string, env: Env, platform: NodeJS.Platform = process.platform): ClaudeRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      const done = (err: Error | null, _out: string, stderr: string) =>
        err ? reject(new Error(`${path.basename(executable)} ${args.slice(0, 2).join(' ')} failed: ${stderr.trim() || err.message}`)) : resolve();
      const options = { env: env as NodeJS.ProcessEnv, timeout: CLI_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' as const };
      if (platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
        // Arguments are paths and KEY=value pairs without double quotes, so plain quoting is enough.
        const line = [executable, ...args].map((a) => `"${a}"`).join(' ');
        execFile('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...options, windowsVerbatimArguments: true }, done);
      } else execFile(executable, args, options, done);
    });
}

function readIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

const exists = (p: string) => fs.existsSync(p);

/** Temp file, then rename, following a symlinked config to its target and keeping its mode. */
function writeAtomic(file: string, text: string): void {
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch {
    // new file
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let mode: number | undefined;
  try {
    mode = fs.statSync(target).mode;
  } catch {
    // new file
  }
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function applyEdit(file: string, edit: Edit): Omit<AgentOutcome, 'agent'> {
  if (edit.kind === 'unchanged') return { action: 'unchanged' };
  if (edit.kind === 'skip') return { action: 'skipped', detail: `${file} ${edit.reason}` };
  writeAtomic(file, edit.text);
  return { action: edit.action };
}

async function syncClaude(file: string, run: ClaudeRunner | undefined, server: ServerEntry, enabled: boolean): Promise<Omit<AgentOutcome, 'agent'>> {
  let current: unknown;
  try {
    current = claudeEntry(readIfExists(file));
  } catch (err) {
    return { action: 'skipped', detail: `${file} is not valid JSON (${(err as Error).message}); left it unchanged` };
  }
  const owner = jsonOwnership(current);
  if (owner === 'hand-written') return { action: 'skipped', detail: `${file} ${HAND_WRITTEN}` };
  if (enabled ? owner === 'ours' && sameJsonEntry(current, server) : owner === 'absent') return { action: 'unchanged' };
  if (!run) return { action: 'skipped', detail: 'the claude CLI was not found' };
  if (!enabled) {
    await run(CLAUDE_REMOVE_ARGS);
    return { action: 'removed' };
  }
  // `claude mcp add` won't overwrite, so re-pointing is remove + add, putting the old entry back if the add fails.
  if (owner === 'ours') await run(CLAUDE_REMOVE_ARGS);
  try {
    await run(claudeAddArgs(server));
  } catch (err) {
    const previous = owner === 'ours' ? asServerEntry(current) : undefined;
    if (previous) await run(claudeAddArgs(previous)).catch(() => undefined);
    throw err;
  }
  return { action: owner === 'ours' ? 'updated' : 'added' };
}

async function settle(agent: AgentId, log: Logger, work: () => Promise<Omit<AgentOutcome, 'agent'>> | Omit<AgentOutcome, 'agent'>): Promise<AgentOutcome> {
  let out: AgentOutcome;
  try {
    out = { agent, ...(await work()) };
  } catch (err) {
    out = { agent, action: 'skipped', detail: (err as Error).message };
  }
  if (out.action === 'skipped') log('warn', `agents: ${LABEL[agent]}: ${out.detail}`);
  else if (out.action !== 'unchanged' && out.action !== 'not-found') log('info', `agents: ${LABEL[agent]}: ${out.action} the "${SERVER_NAME}" MCP server`);
  return out;
}

async function sync(opts: AgentOptions, enabled: boolean): Promise<AgentOutcome[]> {
  const p = paths(opts);
  const server = serverEntry(opts.executable, opts.bridgePath);
  const find = (name: string) => findOnPath(name, opts.env, p.platform);
  const notFound = { action: 'not-found' as const };
  return [
    await settle('claude', opts.log, () => {
      const run = opts.runClaude ?? (() => {
        const cli = find('claude');
        return cli ? cliRunner(cli, opts.env, p.platform) : undefined;
      })();
      if (!run && !exists(p.claudeConfig)) return notFound;
      return syncClaude(p.claudeConfig, run, server, enabled);
    }),
    await settle('codex', opts.log, () => {
      if (!exists(p.codexHome) && !find('codex')) return notFound;
      return applyEdit(p.codexConfig, editCodex(readIfExists(p.codexConfig), server, enabled));
    }),
    await settle('cursor', opts.log, () => {
      if (!exists(p.cursorHome) && !find('cursor') && !find('cursor-agent')) return notFound;
      return applyEdit(p.cursorConfig, editCursor(readIfExists(p.cursorConfig), server, enabled));
    }),
  ];
}

/** Adds Dictate to every agent found, or re-points it after an update. Call on each launch of a packaged build. */
export function registerAgents(opts: AgentOptions): Promise<AgentOutcome[]> {
  return sync(opts, true);
}

/** Removes the entries Dictate wrote; hand-written ones stay. */
export function unregisterAgents(opts: AgentOptions): Promise<AgentOutcome[]> {
  return sync(opts, false);
}

/** What the Agents settings page shows. Reads only. */
export async function agentStatus(opts: Pick<AgentOptions, 'env' | 'platform' | 'runClaude'>): Promise<AgentState[]> {
  const p = paths({ ...opts, executable: '', bridgePath: '', log: () => undefined });
  const find = (name: string) => !!findOnPath(name, opts.env, p.platform);
  const state = (agent: AgentId, found: boolean, read: () => ReturnType<typeof jsonOwnership>): AgentState => {
    const s: AgentState = { agent, found, registered: false, ownedByDictate: false, handWritten: false };
    try {
      const owner = read();
      s.registered = owner !== 'absent';
      s.ownedByDictate = owner === 'ours';
      s.handWritten = owner === 'hand-written';
    } catch (err) {
      s.error = (err as Error).message;
    }
    return s;
  };
  const cursorEntry = () => {
    const text = readIfExists(p.cursorConfig);
    if (!text?.trim()) return undefined;
    const config = JSON.parse(text.replace(/^﻿/, ''));
    return config?.mcpServers?.[SERVER_NAME];
  };
  return [
    state('claude', !!opts.runClaude || find('claude') || exists(p.claudeConfig), () => jsonOwnership(claudeEntry(readIfExists(p.claudeConfig)))),
    state('codex', exists(p.codexHome) || find('codex'), () => codexOwnership(readIfExists(p.codexConfig))),
    state('cursor', exists(p.cursorHome) || find('cursor') || find('cursor-agent'), () => jsonOwnership(cursorEntry())),
  ];
}
