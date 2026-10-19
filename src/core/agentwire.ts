// The local channel between the MCP bridge (one per agent session) and the running app: where it lives, and the
// messages on it. One JSON object per line. The bridge says hello with the token first; each connection is one
// agent session. Pure, apart from hashing.
import { createHash } from 'node:crypto';
import path from 'node:path';

export const CHANNEL_FILE = 'channel.json';
export const BRIDGE_FILE = 'dictate-mcp.js';

/** What the app writes next to the bridge: where to connect and the token to present. */
export interface ChannelInfo {
  version: 1;
  path: string;
  token: string;
  pid: number;
}

/** The ids Pane puts in the environment of every process in its tabs. */
export interface PaneIds {
  sessionId: string;
  panelId: string;
}

export interface ClientInfo {
  name: string;
  title?: string;
  version?: string;
}

export type BridgeToApp =
  | { t: 'hello'; token: string; client: ClientInfo; pane: PaneIds | null; cwd: string; pid: number }
  | { t: 'call'; id: number; tool: string; args: unknown }
  | { t: 'cancel'; id: number };

export type AppToBridge =
  | { t: 'hello'; ok: true; session: string }
  | { t: 'hello'; ok: false; error: string }
  | { t: 'result'; id: number; result: unknown }
  | { t: 'result'; id: number; error: string };

/**
 * A named pipe on Windows, otherwise a socket in a folder only this user can open. Both are derived from the
 * data folder, so a second profile (QA, tests) gets its own channel.
 */
export function channelPath(userData: string, platform: NodeJS.Platform, runtimeDir: string): string {
  const id = createHash('sha256').update(userData.toLowerCase()).digest('hex').slice(0, 12);
  if (platform === 'win32') return `\\\\.\\pipe\\dictate-agents-${id}`;
  // Unix socket paths are limited to ~104 bytes: keep it short.
  return path.posix.join(runtimeDir, `dictate-${id}`, 'agents.sock');
}

/** The ids from a bridge's environment, when it runs inside a Pane tab. */
export function paneIdsFrom(env: Record<string, string | undefined>): PaneIds | null {
  const s = env.PANE_SESSION_ID?.trim();
  const p = env.PANE_PANEL_ID?.trim();
  const ok = (x: string | undefined): x is string => !!x && /^[A-Za-z0-9_-]{1,80}$/.test(x);
  return ok(s) && ok(p) ? { sessionId: s, panelId: p } : null;
}

/** Splits a byte stream into lines of JSON; a line that isn't JSON, or one over `max` bytes, is dropped. */
export function lineReader(onMessage: (m: unknown) => void, max = 1_000_000): (chunk: Buffer | string) => void {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString();
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line || line.length > max) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        // not JSON: ignored
      }
    }
    if (buf.length > max) buf = '';
  };
}

export const frame = (m: unknown) => `${JSON.stringify(m)}\n`;
