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

/** The longest line either side reads, in characters. */
export const MAX_LINE = 1_000_000;
export const MAX_LINE_SIZE = '1 MB';

/** A line that outgrew the reader's limit: its first and last characters, enough to find whose it was. */
export interface LongLine {
  head: string;
  tail: string;
  length: number;
}

const ENDS = 200;

/**
 * Splits a byte stream into lines of JSON. A line that isn't JSON is dropped; one over `max` characters is skipped
 * whole and handed to `tooLong`, so the reader can still answer it.
 */
export function lineReader(onMessage: (m: unknown) => void, max = MAX_LINE, tooLong?: (line: LongLine) => void): (chunk: Buffer | string) => void {
  let buf = '';
  // The line being skipped, once it outgrew `max` before its end arrived.
  let skipping: LongLine | null = null;
  return (chunk) => {
    buf += chunk.toString();
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const piece = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (skipping) {
        const s = skipping;
        skipping = null;
        tooLong?.({ head: s.head, tail: `${s.tail}${piece}`.trimEnd().slice(-ENDS), length: s.length + piece.length });
        continue;
      }
      const line = piece.trim();
      if (!line) continue;
      if (line.length > max) {
        tooLong?.({ head: line.slice(0, ENDS), tail: line.slice(-ENDS), length: line.length });
        continue;
      }
      try {
        onMessage(JSON.parse(line));
      } catch {
        // not JSON: ignored
      }
    }
    if (buf.length > max || (skipping && buf)) {
      skipping ??= { head: buf.trimStart().slice(0, ENDS), tail: '', length: 0 };
      skipping.tail = `${skipping.tail}${buf}`.slice(-ENDS);
      skipping.length += buf.length;
      buf = '';
    }
  };
}

/** Megabytes, to one decimal, for the errors that name a size. */
export const megabytes = (chars: number) => `${(chars / 1_000_000).toFixed(1)} MB`;

export const frame = (m: unknown) => `${JSON.stringify(m)}\n`;
