// Coding agents reach the person through the pill: the MCP bridge is copied out of the app bundle into the data
// folder (so agent configs survive updates), and the local channel it talks to is opened here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BRIDGE_FILE, channelPath } from '../core/agentwire';
import { type AgentHandlers, AgentServer } from './agentserver';
import type { Logger } from './log';

export const agentsDir = (userData: string) => path.join(userData, 'agents');

/** Copies the bridge next to the channel file when it differs; returns where it is. */
export function installBridge(appRoot: string, userData: string, log: Logger): string {
  const from = path.join(appRoot, 'out', 'bridge', BRIDGE_FILE);
  const to = path.join(agentsDir(userData), BRIDGE_FILE);
  try {
    const src = fs.readFileSync(from);
    let same = false;
    try {
      same = fs.readFileSync(to).equals(src);
    } catch {
      // not there yet
    }
    if (!same) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      const tmp = `${to}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, src);
      fs.renameSync(tmp, to);
      log('info', `agents: bridge installed at ${to}`);
    }
  } catch (err) {
    log('warn', `agents: could not install the bridge (${(err as Error).message})`);
  }
  return to;
}

export async function startAgentChannel(userData: string, handlers: AgentHandlers, log: Logger): Promise<AgentServer | undefined> {
  const runtime = process.platform === 'win32' ? '' : process.env.XDG_RUNTIME_DIR || os.tmpdir();
  const server = new AgentServer(agentsDir(userData), channelPath(userData, process.platform, runtime), handlers);
  try {
    await server.start();
    log('info', 'agents: channel open');
    return server;
  } catch (err) {
    // Another copy of Dictate on this profile, or a pipe we can't create: agents are told Dictate isn't running.
    log('warn', `agents: channel did not open (${(err as Error).message})`);
    return undefined;
  }
}
