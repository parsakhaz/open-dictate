// dictate-bridge: the real bridge script, run over stdio the way an agent runs it, against a test channel.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { channelPath } from '../src/core/agentwire';
import { listedTools } from '../src/core/tools';
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
  /** Writes `line` as is and waits for the answer to `id`. */
  raw(id: number, line: string): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }>;
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
    raw: (id, line) =>
      new Promise((resolve) => {
        waiting.set(id, resolve);
        proc.stdin.write(`${line}\n`);
      }),
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
  it('answers the handshake and lists the six built-in tools, then the surfaces turned on', async () => {
    const b = startBridge();
    const init = await initialized(b);
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'dictate', version: '9.9.9' }, capabilities: { tools: {} } });
    const list = await b.request('tools/list');
    const tools = list.result?.tools as { name: string; annotations: { readOnlyHint?: boolean } }[];
    // Each lane turns its tools on in its own module; this list follows them.
    expect(tools.map((t) => t.name)).toEqual(listedTools().map((t) => t.name));
    const builtIn = tools.slice(0, 6);
    expect(builtIn.map((t) => t.name)).toEqual(['notify', 'ask', 'status', 'propose_vocabulary', 'list_vocabulary', 'read_history']);
    expect(builtIn.filter((t) => t.annotations.readOnlyHint).map((t) => t.name)).toEqual(['status', 'list_vocabulary', 'read_history']);
  });

  it('tells every agent how to write a card: the approved rule, in the instructions and in notify and ask', async () => {
    const b = startBridge();
    const init = await initialized(b);
    const rule =
      'In plain words, say what this work is for (the outcome, not the file), what just happened, and what you need from them.';
    const instructions = (init.result as { instructions: string }).instructions;
    expect(instructions).toContain('The person is juggling many tasks and has lost the thread.');
    expect(instructions).toContain(rule);
    expect(instructions).toContain("Don't repeat where you are: Dictate adds that. Always notify (needs_you) or ask when you truly need them.");
    expect(instructions).toContain('Bad: "Approve the migration?"');
    expect(instructions).toContain('Good: "Pill cards now stay up while you answer"');
    const tools = (await b.request('tools/list')).result?.tools as { name: string; description: string }[];
    const plain = 'Write plain text only: no Markdown, headings, lists or code blocks; line breaks are fine.';
    expect(instructions).toContain(plain);
    for (const name of ['notify', 'ask']) {
      expect(tools.find((t) => t.name === name)?.description).toContain(rule);
      expect(tools.find((t) => t.name === name)?.description).toContain(plain);
    }
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

  // 100 terms x 50 aliases x 500 characters: about 2.5 MB, as in #23.
  const bigVocab = () => ({ terms: Array.from({ length: 100 }, (_, i) => ({ term: `term${i}`, aliases: Array.from({ length: 50 }, () => 'a'.repeat(500)) })) });

  it('answers a call over 1 MB with an error instead of dropping it, then keeps working (#23)', async () => {
    handler = async (_s, tool) => ({ ok: true, tool });
    const b = startBridge();
    await initialized(b);
    const big = await b.request('tools/call', { name: 'propose_vocabulary', arguments: bigVocab() });
    expect(big.error?.code).toBe(-32600);
    expect(big.error?.message).toMatch(/2\.5 MB.*at most 1 MB/);
    // The MCP SDK writes the id last.
    const idLast = await b.raw(77, JSON.stringify({ method: 'tools/call', params: { name: 'propose_vocabulary', arguments: bigVocab() }, jsonrpc: '2.0', id: 77 }));
    expect(idLast.error?.code).toBe(-32600);
    expect((await b.request('tools/call', { name: 'status', arguments: {} })).result?.structuredContent).toEqual({ ok: true, tool: 'status' });
  });

  it('returns an answer too big for the channel as a tool error (#23)', async () => {
    handler = async () => ({ text: 'x'.repeat(2_000_000) });
    const b = startBridge();
    await initialized(b);
    const r = await b.request('tools/call', { name: 'read_history', arguments: {} });
    expect(r.result?.isError).toBe(true);
    expect(text(r)).toMatch(/answer.*2\.0 MB.*at most 1 MB/);
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
