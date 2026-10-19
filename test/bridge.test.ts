// dictate-bridge: the real bridge script, run over stdio the way an agent runs it, against a test channel.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { channelPath } from '../src/core/agentwire';
import { type AgentHandlers, AgentServer, type AgentSession } from '../src/main/agentserver';

let dir: string;
let bridgeJs: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dictate-bridge-'));
  bridgeJs = path.join(dir, 'dictate-mcp.js');
  await build({ entryPoints: ['src/bridge/dictate-mcp.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: bridgeJs, define: { DICTATE_VERSION: '"9.9.9"' }, logLevel: 'error' });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

interface Bridge {
  proc: ChildProcessWithoutNullStreams;
  request(method: string, params?: unknown): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }>;
  notify(method: string, params?: unknown): void;
  close(): Promise<void>;
}

const running: Bridge[] = [];
afterEach(async () => {
  for (const b of running.splice(0)) await b.close();
});

function startBridge(env: Record<string, string> = {}, cwd = dir): Bridge {
  const proc = spawn(process.execPath, [bridgeJs], { cwd, env: { PATH: process.env.PATH ?? '', DICTATE_AGENT_CHANNEL: path.join(dir, 'channel.json'), ...env } });
  let next = 1;
  let buf = '';
  const waiting = new Map<number, (m: never) => void>();
  proc.stdout.on('data', (d) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(m.id)?.(m as never);
    }
  });
  const b: Bridge = {
    proc,
    request: (method, params) =>
      new Promise((resolve) => {
        const id = next++;
        waiting.set(id, resolve);
        proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      }),
    notify: (method, params) => proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`),
    close: () =>
      new Promise((resolve) => {
        if (proc.exitCode !== null) return resolve();
        proc.on('exit', () => resolve());
        proc.stdin.end();
      }),
  };
  running.push(b);
  return b;
}

async function initialized(b: Bridge, name = 'claude-code') {
  const r = await b.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, title: 'Claude Code', version: '2.1' } });
  b.notify('notifications/initialized');
  return r;
}

const text = (r: { result?: Record<string, unknown> }) => (r.result!.content as { text: string }[])[0].text;

describe('the bridge without Dictate running', () => {
  it('answers the handshake and lists the six tools', async () => {
    const b = startBridge();
    const init = await initialized(b);
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'dictate', version: '9.9.9' }, capabilities: { tools: {} } });
    const list = await b.request('tools/list');
    const tools = list.result?.tools as { name: string; annotations: { readOnlyHint?: boolean } }[];
    expect(tools.map((t) => t.name)).toEqual(['notify', 'ask', 'status', 'propose_vocabulary', 'list_vocabulary', 'read_history']);
    expect(tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name)).toEqual(['status', 'list_vocabulary', 'read_history']);
  });

  it("says Dictate isn't running instead of hanging", async () => {
    const b = startBridge();
    await initialized(b);
    const r = await b.request('tools/call', { name: 'notify', arguments: { title: 'hi' } });
    expect(r.result?.isError).toBe(true);
    expect(text(r)).toMatch(/Dictate isn't running/);
  });

  it('rejects an unknown tool and an unknown method', async () => {
    const b = startBridge();
    await initialized(b);
    expect((await b.request('tools/call', { name: 'speak', arguments: {} })).error?.code).toBe(-32602);
    expect((await b.request('resources/list')).error?.code).toBe(-32601);
  });
});

describe('the bridge with Dictate running', () => {
  let server: AgentServer;
  const seen: { session: AgentSession; tool: string; args: unknown }[] = [];
  const closed: string[] = [];
  let handler: AgentHandlers['call'] = async (session, tool, args) => {
    seen.push({ session, tool, args });
    return { ok: true, tool };
  };

  beforeAll(async () => {
    server = new AgentServer(dir, channelPath(dir, process.platform, os.tmpdir()), { call: (...a) => handler(...a), closed: (s) => closed.push(s.id) });
    await server.start();
  });
  afterAll(() => server.stop());

  it('forwards calls with the Pane ids, the folder and the client name, never from the agent', async () => {
    const cwd = fs.mkdtempSync(path.join(dir, 'proj-'));
    const b = startBridge({ PANE_SESSION_ID: 'pane-1', PANE_PANEL_ID: 'panel-9' }, cwd);
    await initialized(b, 'codex-mcp-client');
    const r = await b.request('tools/call', { name: 'status', arguments: {} });
    expect(r.result?.structuredContent).toEqual({ ok: true, tool: 'status' });
    const last = seen.at(-1)!;
    expect(last.session.client.name).toBe('codex-mcp-client');
    expect(last.session.pane).toEqual({ sessionId: 'pane-1', panelId: 'panel-9' });
    expect(fs.realpathSync(last.session.cwd)).toBe(fs.realpathSync(cwd));
  });

  it('keeps one session per bridge, and reports when it closes', async () => {
    const b = startBridge();
    await initialized(b);
    await b.request('tools/call', { name: 'status', arguments: {} });
    await b.request('tools/call', { name: 'list_vocabulary', arguments: {} });
    const [x, y] = seen.slice(-2);
    expect(x.session.id).toBe(y.session.id);
    expect(x.session.pane).toBeNull();
    await b.close();
    await expect.poll(() => closed).toContain(x.session.id);
  });

  it('returns a handler error as a tool error', async () => {
    handler = async () => {
      throw new Error('History access is off in Dictate');
    };
    const b = startBridge();
    await initialized(b);
    const r = await b.request('tools/call', { name: 'read_history', arguments: {} });
    expect(r.result?.isError).toBe(true);
    expect(text(r)).toBe('History access is off in Dictate');
  });

  it('passes the agent cancelling a call on to the app', async () => {
    let aborted = false;
    handler = (_s, _t, _a, signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve({ answered: false, reason: 'cancelled' });
        });
      });
    const b = startBridge();
    await initialized(b);
    const pending = b.request('tools/call', { name: 'ask', arguments: { question: 'Staging or prod?' } });
    await new Promise((r) => setTimeout(r, 200));
    b.notify('notifications/cancelled', { requestId: 2 });
    await pending;
    expect(aborted).toBe(true);
  });

  it('refuses a bridge with the wrong token', async () => {
    const forged = path.join(dir, 'forged.json');
    const real = JSON.parse(fs.readFileSync(path.join(dir, 'channel.json'), 'utf8'));
    fs.writeFileSync(forged, JSON.stringify({ ...real, token: 'x'.repeat(real.token.length) }));
    const b = startBridge({ DICTATE_AGENT_CHANNEL: forged });
    await initialized(b);
    const r = await b.request('tools/call', { name: 'status', arguments: {} });
    expect(r.result?.isError).toBe(true);
    expect(text(r)).toMatch(/refused/);
  });
});
