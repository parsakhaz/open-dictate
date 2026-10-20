// QA helper: one agent session, run the way an agent runs it. Dictate's own executable starts the bridge from the
// data folder as Node, and MCP goes over its stdio. `env` adds PANE_SESSION_ID / PANE_PANEL_ID for a Pane tab.
const path = require('node:path');
const { spawn } = require('node:child_process');

// DICTATE_QA_ELECTRON: another copy of the same Electron, for a checkout whose own binary can't run yet.
const ELECTRON = process.env.DICTATE_QA_ELECTRON || path.join(__dirname, '..', 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

function agentSession(dataDir, { client = 'claude-code', title = 'Claude Code', env = {}, cwd = process.cwd() } = {}) {
  const base = { ...process.env };
  delete base.PANE_SESSION_ID;
  delete base.PANE_PANEL_ID;
  const proc = spawn(ELECTRON, [path.join(dataDir, 'agents', 'dictate-mcp.js')], { cwd, env: { ...base, ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'inherit'] });
  let next = 1;
  let buf = '';
  const waiting = new Map();
  proc.stdout.on('data', (d) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(m.id)?.(m);
      waiting.delete(m.id);
    }
  });
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const ready = request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: client, title, version: 'qa' } });
  return {
    /** A tool call: { result } with the structured answer, or { error } with the tool's error text. */
    async call(name, args = {}) {
      await ready;
      const r = await request('tools/call', { name, arguments: args });
      const res = r.result ?? {};
      return res.isError ? { error: res.content?.[0]?.text } : { result: res.structuredContent ?? res.content?.[0]?.text };
    },
    /** The whole tools/call result, content blocks included (peek's image block). */
    async raw(name, args = {}) {
      await ready;
      return (await request('tools/call', { name, arguments: args })).result ?? {};
    },
    async list() {
      await ready;
      return (await request('tools/list', {})).result.tools.map((t) => t.name);
    },
    close: () => new Promise((resolve) => {
      if (proc.exitCode !== null) return resolve();
      proc.on('exit', () => resolve());
      proc.stdin.end();
    }),
  };
}

module.exports = { agentSession, ELECTRON };
