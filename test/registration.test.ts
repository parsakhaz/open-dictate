import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CODEX_MARKER, codexEntry, editCodex, parseToml, serverEntry, setupSnippets } from '../src/core/registration';
import { type AgentOptions, agentStatus, registerAgents, unregisterAgents } from '../src/main/registration';

let home: string;
let logs: string[];
let claudeCalls: string[][];
const EXE = 'C:\\Program Files\\Dictate\\Dictate.exe';
const BRIDGE = 'C:\\Users\\me\\AppData\\Roaming\\dictate\\agents\\dictate-mcp.js';

const claudeJson = () => path.join(home, '.claude.json');
const codexToml = () => path.join(home, '.codex', 'config.toml');
const cursorJson = () => path.join(home, '.cursor', 'mcp.json');
const read = (f: string) => fs.readFileSync(f, 'utf8');
const readJ = (f: string) => JSON.parse(read(f));

/** Acts like `claude mcp add/remove --scope user`: edits mcpServers in ~/.claude.json. */
async function fakeClaude(args: string[]): Promise<void> {
  claudeCalls.push(args);
  const config = fs.existsSync(claudeJson()) ? readJ(claudeJson()) : {};
  config.mcpServers ??= {};
  const name = args[2];
  if (args[1] === 'remove') {
    if (!config.mcpServers[name]) throw new Error(`No MCP server named ${name}`);
    delete config.mcpServers[name];
  } else {
    if (config.mcpServers[name]) throw new Error(`MCP server ${name} already exists`);
    const env: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) if (args[i] === '-e') env[args[i + 1].split('=')[0]] = args[i + 1].split('=')[1];
    const rest = args.slice(args.indexOf('--') + 1);
    config.mcpServers[name] = { type: 'stdio', command: rest[0], args: rest.slice(1), env };
  }
  fs.writeFileSync(claudeJson(), JSON.stringify(config, null, 2));
}

function opts(over: Partial<AgentOptions> = {}): AgentOptions {
  return {
    env: { HOME: home, USERPROFILE: home, PATH: '' },
    executable: EXE,
    bridgePath: BRIDGE,
    runClaude: fakeClaude,
    log: (_l, m) => logs.push(m),
    ...over,
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dictate-reg-'));
  fs.mkdirSync(path.join(home, '.codex'));
  fs.mkdirSync(path.join(home, '.cursor'));
  logs = [];
  claudeCalls = [];
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const CODEX_FIXTURE = `# my Codex config
model = "gpt-5.5" # inline comment

[mcp_servers.other]
command = "npx"
args = ["-y", "other-mcp"]   # keep this spacing

# a comment introducing profiles
[profiles.fast]
model_reasoning_effort = "low"
notes = """
[not.a.table]
"""
`;

describe('parseToml', () => {
  it('reads tables, dotted keys, strings, arrays, inline tables and numbers', () => {
    const t = parseToml(`a.b = 1\n[x."y z"]\ns = 'lit'\nm = """\nline\\tx"""\narr = [\n 1, # c\n 2,\n]\nit = { k = "v", n.m = true }\n[[aot]]\nq = 1979-05-27 07:32:00Z\n[[aot]]\nf = 1_000.5\n`);
    expect(t).toEqual({
      a: { b: 1 },
      x: { 'y z': { s: 'lit', m: 'line\tx', arr: [1, 2], it: { k: 'v', n: { m: true } } } },
      aot: [{ q: '1979-05-27 07:32:00Z' }, { f: 1000.5 }],
    });
  });

  it('rejects broken TOML and duplicate keys', () => {
    expect(() => parseToml('a = ')).toThrow();
    expect(() => parseToml('a = "x"\na = "y"')).toThrow();
    expect(() => parseToml('[t]\n[t]')).toThrow();
    expect(() => parseToml('s = """never closed')).toThrow();
  });
});

describe('editCodex', () => {
  const server = serverEntry(EXE, BRIDGE);

  it('appends the managed table and keeps every other byte', () => {
    const e = editCodex(CODEX_FIXTURE, server, true);
    expect(e.kind).toBe('write');
    if (e.kind !== 'write') return;
    expect(e.text.startsWith(CODEX_FIXTURE)).toBe(true);
    expect(e.text).toContain(`[mcp_servers.dictate]\n${CODEX_MARKER}\n`);
    expect(parseToml(e.text).mcp_servers).toMatchObject({ dictate: codexEntry(server) });
    expect(codexEntry(server)).toMatchObject({ env_vars: ['PANE_SESSION_ID', 'PANE_PANEL_ID'], tool_timeout_sec: 660 });
    expect(editCodex(e.text, server, true).kind).toBe('unchanged');
    const off = editCodex(e.text, server, false);
    expect(off).toEqual({ kind: 'write', action: 'removed', text: CODEX_FIXTURE });
  });

  it('keeps CRLF line endings', () => {
    const crlf = CODEX_FIXTURE.replace(/\n/g, '\r\n');
    const e = editCodex(crlf, server, true);
    if (e.kind !== 'write') throw new Error(e.kind);
    expect(e.text.replace(/\r\n/g, '')).not.toContain('\n');
    expect(editCodex(e.text, server, false)).toMatchObject({ text: crlf });
  });

  it('refuses when the result would not parse', () => {
    expect(editCodex('s = """open', server, true).kind).toBe('skip');
  });
});

describe('registerAgents', () => {
  it('adds Dictate to Claude Code, Codex and Cursor, keeping everything else', async () => {
    fs.writeFileSync(codexToml(), CODEX_FIXTURE);
    fs.writeFileSync(cursorJson(), JSON.stringify({ mcpServers: { other: { command: 'x' } }, extra: 1 }));
    const out = await registerAgents(opts());
    expect(out.map((o) => [o.agent, o.action])).toEqual([
      ['claude', 'added'],
      ['codex', 'added'],
      ['cursor', 'added'],
    ]);
    expect(claudeCalls).toEqual([['mcp', 'add', 'dictate', '--scope', 'user', '-e', 'ELECTRON_RUN_AS_NODE=1', '-e', 'DICTATE_MCP=1', '--', EXE, BRIDGE]]);
    expect(read(codexToml()).startsWith(CODEX_FIXTURE)).toBe(true);
    const cursor = readJ(cursorJson());
    expect(cursor.extra).toBe(1);
    expect(cursor.mcpServers.other).toEqual({ command: 'x' });
    expect(cursor.mcpServers.dictate).toEqual({ type: 'stdio', command: EXE, args: [BRIDGE], env: { ELECTRON_RUN_AS_NODE: '1', DICTATE_MCP: '1' } });
    expect(fs.readdirSync(path.join(home, '.codex'))).toEqual(['config.toml']); // no temp files left
  });

  it('writes nothing the second time', async () => {
    await registerAgents(opts());
    const mtimes = [codexToml(), cursorJson(), claudeJson()].map((f) => fs.statSync(f).mtimeMs);
    claudeCalls = [];
    const out = await registerAgents(opts());
    expect(out.every((o) => o.action === 'unchanged')).toBe(true);
    expect(claudeCalls).toEqual([]);
    expect([codexToml(), cursorJson(), claudeJson()].map((f) => fs.statSync(f).mtimeMs)).toEqual(mtimes);
  });

  it('re-points every entry after an update', async () => {
    await registerAgents(opts());
    const exe2 = 'C:\\Program Files\\Dictate 2\\Dictate.exe';
    claudeCalls = [];
    const out = await registerAgents(opts({ executable: exe2 }));
    expect(out.map((o) => o.action)).toEqual(['updated', 'updated', 'updated']);
    expect(claudeCalls.map((c) => c[1])).toEqual(['remove', 'add']);
    expect(readJ(claudeJson()).mcpServers.dictate.command).toBe(exe2);
    expect(readJ(cursorJson()).mcpServers.dictate.command).toBe(exe2);
    expect((parseToml(read(codexToml())).mcp_servers as Record<string, { command: string }>).dictate.command).toBe(exe2);
    expect(read(codexToml()).match(/\[mcp_servers\.dictate\]/g)).toHaveLength(1);
  });

  it('never touches a dictate entry written by hand, on write or remove', async () => {
    const hand = { mcpServers: { dictate: { command: 'node', args: ['mine.js'] } } };
    fs.writeFileSync(claudeJson(), JSON.stringify(hand));
    fs.writeFileSync(cursorJson(), JSON.stringify(hand));
    const toml = `${CODEX_FIXTURE}\n[mcp_servers.dictate]\ncommand = "node"\nargs = ["mine.js"]\n`;
    fs.writeFileSync(codexToml(), toml);
    for (const run of [registerAgents, unregisterAgents]) {
      const out = await run(opts());
      expect(out.map((o) => o.action)).toEqual(['skipped', 'skipped', 'skipped']);
      expect(out.every((o) => /by hand/.test(o.detail ?? ''))).toBe(true);
    }
    expect(claudeCalls).toEqual([]);
    expect(readJ(claudeJson())).toEqual(hand);
    expect(readJ(cursorJson())).toEqual(hand);
    expect(read(codexToml())).toBe(toml);
    const status = await agentStatus(opts());
    expect(status.map((s) => [s.agent, s.registered, s.ownedByDictate, s.handWritten])).toEqual([
      ['claude', true, false, true],
      ['codex', true, false, true],
      ['cursor', true, false, true],
    ]);
  });

  it('skips and logs a broken file, never overwriting it', async () => {
    fs.writeFileSync(cursorJson(), '{ "mcpServers": ');
    fs.writeFileSync(codexToml(), 'model = \n');
    const out = await registerAgents(opts());
    expect(out.find((o) => o.agent === 'cursor')?.action).toBe('skipped');
    expect(out.find((o) => o.agent === 'codex')?.action).toBe('skipped');
    expect(read(cursorJson())).toBe('{ "mcpServers": ');
    expect(read(codexToml())).toBe('model = \n');
    expect(logs.some((m) => m.includes('mcp.json'))).toBe(true);
    expect(logs.some((m) => m.includes('config.toml'))).toBe(true);
    const status = await agentStatus(opts());
    expect(status.find((s) => s.agent === 'cursor')?.error).toBeTruthy();
  });

  it('reports a Claude CLI failure without throwing, and restores the old entry on a failed update', async () => {
    await registerAgents(opts());
    const failingAdd = async (args: string[]) => {
      if (args[1] === 'add' && args.at(-2) !== EXE) throw new Error('boom');
      await fakeClaude(args);
    };
    const out = await registerAgents(opts({ executable: 'D:\\new.exe', runClaude: failingAdd }));
    expect(out[0]).toMatchObject({ agent: 'claude', action: 'skipped', detail: expect.stringContaining('boom') });
    expect(readJ(claudeJson()).mcpServers.dictate.command).toBe(EXE);
  });

  it('leaves agents that are not installed alone', async () => {
    fs.rmSync(path.join(home, '.codex'), { recursive: true });
    fs.rmSync(path.join(home, '.cursor'), { recursive: true });
    const out = await registerAgents(opts({ runClaude: undefined }));
    expect(out.map((o) => o.action)).toEqual(['not-found', 'not-found', 'not-found']);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("registers with the home folder's .codex when CODEX_HOME is under a .cache folder", async () => {
    const codexHome = path.join(home, '.cache', 'agent-farm', 'codex');
    fs.mkdirSync(codexHome, { recursive: true });
    await registerAgents(opts({ env: { HOME: home, USERPROFILE: home, PATH: '', CODEX_HOME: codexHome } }));
    expect(fs.existsSync(path.join(codexHome, 'config.toml'))).toBe(false);
    expect(fs.existsSync(codexToml())).toBe(true);
  });

  it('uses CODEX_HOME and CLAUDE_CONFIG_DIR when set', async () => {
    const codexHome = path.join(home, 'ch');
    const claudeDir = path.join(home, 'cc');
    fs.mkdirSync(codexHome);
    fs.mkdirSync(claudeDir);
    const env = { HOME: home, USERPROFILE: home, PATH: '', CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeDir };
    fs.writeFileSync(path.join(claudeDir, '.claude.json'), JSON.stringify({ mcpServers: { dictate: { command: 'x' } } }));
    const out = await registerAgents(opts({ env }));
    expect(out[0].action).toBe('skipped'); // the hand-written one in CLAUDE_CONFIG_DIR was found
    expect(fs.existsSync(path.join(codexHome, 'config.toml'))).toBe(true);
    expect(fs.existsSync(codexToml())).toBe(false);
  });
});

describe('unregisterAgents', () => {
  it("removes only Dictate's entries", async () => {
    fs.writeFileSync(codexToml(), CODEX_FIXTURE);
    fs.writeFileSync(cursorJson(), JSON.stringify({ mcpServers: { other: { command: 'x' } } }, null, 2));
    await registerAgents(opts());
    claudeCalls = [];
    const out = await unregisterAgents(opts());
    expect(out.map((o) => o.action)).toEqual(['removed', 'removed', 'removed']);
    expect(claudeCalls).toEqual([['mcp', 'remove', 'dictate', '--scope', 'user']]);
    expect(read(codexToml())).toBe(CODEX_FIXTURE);
    expect(readJ(cursorJson())).toEqual({ mcpServers: { other: { command: 'x' } } });
    expect(readJ(claudeJson()).mcpServers).toEqual({});
    claudeCalls = [];
    expect((await unregisterAgents(opts())).map((o) => o.action)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    expect(claudeCalls).toEqual([]);
  });
});

describe('agentStatus', () => {
  it('says which agents are found and whether Dictate registered itself', async () => {
    fs.rmSync(path.join(home, '.cursor'), { recursive: true });
    await registerAgents(opts());
    const status = await agentStatus(opts());
    expect(status).toEqual([
      { agent: 'claude', found: true, registered: true, ownedByDictate: true, handWritten: false },
      { agent: 'codex', found: true, registered: true, ownedByDictate: true, handWritten: false },
      { agent: 'cursor', found: false, registered: false, ownedByDictate: false, handWritten: false },
    ]);
  });
});

describe('setupSnippets', () => {
  it('gives each other agent a pasteable entry without the ownership marker', () => {
    const snippets = setupSnippets(serverEntry(EXE, BRIDGE), 'win32');
    expect(snippets.map((s) => s.agent)).toEqual(['Gemini CLI', 'VS Code', 'Copilot CLI', 'Windsurf', 'opencode', 'Zed', 'Amp']);
    for (const s of snippets) {
      const json = JSON.parse(s.text);
      expect(s.text).not.toContain('DICTATE_MCP');
      expect(s.text).toContain('dictate-mcp.js');
      expect(json).toBeTruthy();
      expect(s.file).toBeTruthy();
    }
    const by = (a: string) => JSON.parse(snippets.find((s) => s.agent === a)!.text);
    expect(by('VS Code').servers.dictate.type).toBe('stdio');
    expect(by('opencode').mcp.dictate).toEqual({ type: 'local', command: [EXE, BRIDGE], environment: { ELECTRON_RUN_AS_NODE: '1' }, enabled: true });
    expect(by('Zed').context_servers.dictate.command).toBe(EXE);
    expect(by('Amp')['amp.mcpServers'].dictate.args).toEqual([BRIDGE]);
  });
});
