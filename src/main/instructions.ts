// Keeps Dictate's block in the user-level instruction files of the agents it registers with: Claude Code's
// CLAUDE.md and Codex's AGENTS.md. Never a project's files. A file that can't be read as UTF-8, has unpaired
// markers or is read-only is skipped and logged; one file's failure never stops the other. No Electron here: the
// caller passes the environment, so tests run against temp folders.
import fs from 'node:fs';
import path from 'node:path';
import { editInstructions, instructionsState } from '../core/instructions';
import type { Logger } from './log';
import { findOnPath, homeDir, writeAtomic } from './registration';

export type InstructionsAgent = 'claude' | 'codex';
type Env = Record<string, string | undefined>;

export interface InstructionsOptions {
  /** Supplies HOME/USERPROFILE, CLAUDE_CONFIG_DIR, CODEX_HOME and PATH. */
  env: Env;
  platform?: NodeJS.Platform;
  log: Logger;
}

export interface InstructionsOutcome {
  agent: InstructionsAgent;
  file: string;
  action: 'added' | 'updated' | 'removed' | 'unchanged' | 'skipped' | 'not-found';
  detail?: string;
}

/** What Settings → Agents shows. */
export interface InstructionsFile {
  agent: InstructionsAgent;
  file: string;
  /** Its config folder exists or its CLI is on PATH. */
  found: boolean;
  state: 'absent' | 'current' | 'outdated';
  error?: string;
}

const LABEL: Record<InstructionsAgent, string> = { claude: 'Claude Code', codex: 'Codex' };

/** Each agent's user-level instruction file, and whether the agent is on this computer. */
function targets(opts: Pick<InstructionsOptions, 'env' | 'platform'>): { agent: InstructionsAgent; file: string; found: () => boolean }[] {
  const platform = opts.platform ?? process.platform;
  const home = homeDir(opts.env, platform);
  const claudeDir = opts.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const codexDir = opts.env.CODEX_HOME || path.join(home, '.codex');
  const on = (name: string) => !!findOnPath(name, opts.env, platform);
  return [
    { agent: 'claude', file: path.join(claudeDir, 'CLAUDE.md'), found: () => fs.existsSync(claudeDir) || on('claude') },
    { agent: 'codex', file: path.join(codexDir, 'AGENTS.md'), found: () => fs.existsSync(codexDir) || on('codex') },
  ];
}

/** The file's text, undefined when it is missing; throws when it isn't UTF-8, so its bytes can't be rewritten. */
function readText(file: string): string | undefined {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error("isn't UTF-8 text");
  return text;
}

function writable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.W_OK);
    // access() says yes to root even for a read-only file; the mode is what the person set.
    return process.platform === 'win32' || (fs.statSync(file).mode & 0o222) !== 0;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

function syncOne(file: string, enabled: boolean): Omit<InstructionsOutcome, 'agent' | 'file'> {
  const text = readText(file);
  const edit = editInstructions(text, enabled);
  if (edit.kind === 'unchanged') return { action: 'unchanged' };
  if (edit.kind === 'skip') return { action: 'skipped', detail: edit.reason };
  if (!writable(file)) return { action: 'skipped', detail: 'is read-only; left it unchanged' };
  // Nothing but the block was in it: an empty file says no more than a missing one.
  if (edit.action === 'removed' && !edit.text) fs.rmSync(file);
  else writeAtomic(file, edit.text);
  return { action: edit.action };
}

/**
 * Adds or refreshes the block for each agent found (creating the file when missing), or removes it from every
 * file that has it. Writes only when the block changed.
 */
export function syncInstructions(opts: InstructionsOptions, enabled: boolean): InstructionsOutcome[] {
  return targets(opts).map(({ agent, file, found }) => {
    let out: InstructionsOutcome;
    try {
      out = enabled && !found() ? { agent, file, action: 'not-found' } : { agent, file, ...syncOne(file, enabled) };
    } catch (err) {
      out = { agent, file, action: 'skipped', detail: `${(err as Error).message}; left it unchanged` };
    }
    if (out.action === 'skipped') opts.log('warn', `agents: ${LABEL[agent]}: ${file} ${out.detail}`);
    else if (out.action !== 'unchanged' && out.action !== 'not-found') opts.log('info', `agents: ${LABEL[agent]}: ${out.action} Dictate's instructions in ${file}`);
    return out;
  });
}

/** Which files hold the block. Reads only. */
export function instructionsStatus(opts: Pick<InstructionsOptions, 'env' | 'platform'>): InstructionsFile[] {
  return targets(opts).map(({ agent, file, found }) => {
    const s: InstructionsFile = { agent, file, found: found(), state: 'absent' };
    try {
      s.state = instructionsState(readText(file));
      if (!writable(file)) s.error = 'is read-only';
    } catch (err) {
      s.error = (err as Error).message;
    }
    return s;
  });
}
