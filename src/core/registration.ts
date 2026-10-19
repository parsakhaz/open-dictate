// Registering Dictate's MCP bridge with coding agents: the entries, the edits to Codex's TOML and Cursor's JSON,
// who owns an existing entry, and "Copy setup" snippets for agents Dictate doesn't write. Pure: no fs, no Electron.

export const SERVER_NAME = 'dictate';
/** In the entry's env: marks entries Dictate wrote. An entry without it was written by hand and is left alone. */
export const MARKER_ENV = 'DICTATE_MCP';
/** First line inside Codex's table, so the table can be found and replaced as text. */
export const CODEX_MARKER = '# Managed by Dictate ("Let coding agents use Dictate"). Dictate rewrites this table on launch.';
/** ask can wait 600 s; Codex gives up on a tool after 60 s unless told otherwise. */
export const CODEX_TOOL_TIMEOUT_SEC = 660;
/** Codex starts MCP servers with a scrubbed environment; these let the bridge say which Pane tab it is in. */
export const PANE_ENV_VARS = ['PANE_SESSION_ID', 'PANE_PANEL_ID'];

export interface ServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The bridge, run by Dictate's own executable as Node. `marked` adds the ownership marker. */
export function serverEntry(executable: string, bridgePath: string, marked = true): ServerEntry {
  return { command: executable, args: [bridgePath], env: { ELECTRON_RUN_AS_NODE: '1', ...(marked ? { [MARKER_ENV]: '1' } : {}) } };
}

export type Ownership = 'absent' | 'ours' | 'hand-written';

/** The outcome of editing one config file. */
export type Edit =
  | { kind: 'unchanged' }
  | { kind: 'write'; text: string; action: 'added' | 'updated' | 'removed' }
  | { kind: 'skip'; reason: string };

export const HAND_WRITTEN = `has a "${SERVER_NAME}" MCP server written by hand; left it unchanged`;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Sorted-key JSON, so two entries compare equal whatever order their keys were written in. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObject(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

/** Ownership of a JSON entry (Claude Code, Cursor). */
export function jsonOwnership(entry: unknown): Ownership {
  if (entry === undefined) return 'absent';
  return isObject(entry) && isObject(entry.env) && entry.env[MARKER_ENV] === '1' ? 'ours' : 'hand-written';
}

/** Whether a stdio JSON entry already runs `server` exactly. */
export function sameJsonEntry(entry: unknown, server: ServerEntry): boolean {
  if (!isObject(entry) || (entry.type !== undefined && entry.type !== 'stdio')) return false;
  const { type: _type, ...rest } = entry;
  return canonical({ args: [], env: {}, ...rest }) === canonical(server);
}

// ---------- Claude Code (through its CLI) ----------

/** `claude mcp add` arguments. Values carry no quotes, so a .cmd shim can quote each one plainly. */
export function claudeAddArgs(server: ServerEntry): string[] {
  const env = Object.entries(server.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return ['mcp', 'add', SERVER_NAME, '--scope', 'user', ...env, '--', server.command, ...server.args];
}

export const CLAUDE_REMOVE_ARGS = ['mcp', 'remove', SERVER_NAME, '--scope', 'user'];

/** The user-scope `dictate` entry in ~/.claude.json; throws when the file is not JSON. */
export function claudeEntry(text: string | undefined): unknown {
  if (!text?.trim()) return undefined;
  const config: unknown = JSON.parse(text.replace(/^﻿/, ''));
  return isObject(config) && isObject(config.mcpServers) ? config.mcpServers[SERVER_NAME] : undefined;
}

/** An existing entry as something `claude mcp add` can put back. */
export function asServerEntry(entry: unknown): ServerEntry | undefined {
  if (!isObject(entry) || typeof entry.command !== 'string') return undefined;
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  const env = isObject(entry.env) ? Object.fromEntries(Object.entries(entry.env).map(([k, v]) => [k, String(v)])) : {};
  return { command: entry.command, args, env };
}

// ---------- Cursor (~/.cursor/mcp.json) ----------

/** Adds, re-points or removes Dictate's entry in Cursor's mcp.json; other keys are kept. */
export function editCursor(text: string | undefined, server: ServerEntry, enabled: boolean): Edit {
  let config: Record<string, unknown> = {};
  if (text?.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^﻿/, ''));
    } catch (err) {
      return { kind: 'skip', reason: `is not valid JSON (${(err as Error).message}); left it unchanged` };
    }
    if (!isObject(parsed)) return { kind: 'skip', reason: 'is not a JSON object; left it unchanged' };
    config = parsed;
  }
  if (config.mcpServers !== undefined && !isObject(config.mcpServers)) return { kind: 'skip', reason: 'has an mcpServers that is not an object; left it unchanged' };
  const servers = { ...((config.mcpServers as Record<string, unknown> | undefined) ?? {}) };
  const existing = servers[SERVER_NAME];
  const owner = jsonOwnership(existing);
  if (owner === 'hand-written') return { kind: 'skip', reason: HAND_WRITTEN };
  if (enabled && owner === 'ours' && sameJsonEntry(existing, server) && (existing as { type?: unknown }).type === 'stdio') return { kind: 'unchanged' };
  if (!enabled && owner === 'absent') return { kind: 'unchanged' };
  if (enabled) servers[SERVER_NAME] = { type: 'stdio', ...server };
  else delete servers[SERVER_NAME];
  const next = { ...config, mcpServers: servers };
  const action = !enabled ? 'removed' : owner === 'absent' ? 'added' : 'updated';
  return { kind: 'write', text: `${JSON.stringify(next, null, 2)}\n`, action };
}

// ---------- Codex (config.toml, edited as text) ----------

/** What Codex should read back from Dictate's table. */
export function codexEntry(server: ServerEntry) {
  return { command: server.command, args: server.args, env: server.env, env_vars: PANE_ENV_VARS, tool_timeout_sec: CODEX_TOOL_TIMEOUT_SEC };
}

function renderCodexTable(server: ServerEntry): string[] {
  const e = codexEntry(server);
  const list = (xs: string[]) => `[${xs.map((x) => JSON.stringify(x)).join(', ')}]`;
  const env = Object.entries(e.env)
    .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
    .join(', ');
  return [
    `[mcp_servers.${SERVER_NAME}]`,
    CODEX_MARKER,
    `command = ${JSON.stringify(e.command)}`,
    `args = ${list(e.args)}`,
    `env = { ${env} }`,
    `env_vars = ${list(e.env_vars)}`,
    `tool_timeout_sec = ${e.tool_timeout_sec}`,
  ];
}

interface CodexState {
  ownership: Ownership;
  /** Lines [start, end) of Dictate's table, when it is ours. */
  range?: { start: number; end: number };
  entry: unknown;
  /** Everything but the dictate entry, to prove an edit touched nothing else. */
  rest: string;
}

const isDictate = (p: string[]) => p[0] === 'mcp_servers' && p[1] === SERVER_NAME;

/** Throws when the text isn't TOML this reader understands. */
function codexState(text: string): CodexState {
  const { data, headers } = readToml(text);
  const servers = isObject(data.mcp_servers) ? { ...data.mcp_servers } : undefined;
  const entry = servers?.[SERVER_NAME];
  if (servers) {
    delete servers[SERVER_NAME];
    if (Object.keys(servers).length) data.mcp_servers = servers;
    else delete data.mcp_servers;
  }
  const rest = canonical(data);
  if (entry === undefined) return { ownership: 'absent', entry, rest };
  const lines = text.split('\n');
  const at = headers.findIndex((h) => !h.array && h.path.length === 2 && isDictate(h.path));
  const marked = at >= 0 && lines[headers[at].line + 1]?.trim() === CODEX_MARKER;
  const envMarked = isObject(entry) && isObject(entry.env) && entry.env[MARKER_ENV] === '1';
  if (at < 0 || !(marked || envMarked)) return { ownership: 'hand-written', entry, rest };
  const start = headers[at].line;
  const next = headers.slice(at + 1).find((h) => !isDictate(h.path));
  let end = next ? next.line : lines.length;
  // End at the table's last key, so comments that introduce the next table stay with it.
  while (end > start + 1 && /^\s*(#.*)?$/.test(lines[end - 1])) end--;
  return { ownership: 'ours', range: { start, end }, entry, rest };
}

/** Ownership of the `dictate` table in Codex's config.toml; throws when it can't be read. */
export function codexOwnership(text: string | undefined): Ownership {
  return codexState(text ?? '').ownership;
}

/**
 * Adds, re-points or removes Dictate's table in config.toml as a text edit, so comments and every other table
 * keep their bytes; the result is parsed and compared before it is returned for writing.
 */
export function editCodex(text: string | undefined, server: ServerEntry, enabled: boolean): Edit {
  const current = text ?? '';
  let before: CodexState;
  try {
    before = codexState(current);
  } catch (err) {
    return { kind: 'skip', reason: `could not be read as TOML (${(err as Error).message}); left it unchanged` };
  }
  if (before.ownership === 'hand-written') return { kind: 'skip', reason: HAND_WRITTEN };
  const crlf = current.includes('\r\n');
  const eol = crlf ? '\r\n' : '\n';
  const block = renderCodexTable(server).map((l) => (crlf ? `${l}\r` : l));
  const lines = current.split('\n');
  const { range } = before;
  let next: string;
  if (enabled && range) next = [...lines.slice(0, range.start), ...block, ...lines.slice(range.end)].join('\n');
  else if (enabled) next = current.trim() ? `${current}${current.endsWith('\n') ? eol : eol + eol}${block.join('\n')}\n` : `${block.join('\n')}\n`;
  else if (range) {
    lines.splice(range.start, range.end - range.start);
    // Drop the blank lines the table leaves behind: doubled ones where it was, a leading one at the top.
    const blank = (i: number) => i >= 0 && i < lines.length && !lines[i].trim();
    let j = range.start;
    while (blank(j) && (j === 0 ? lines.length > 1 : blank(j - 1))) {
      if (j === 0) lines.splice(0, 1);
      else lines.splice(--j, 1);
    }
    next = lines.join('\n');
  } else next = current;
  if (next === current) return { kind: 'unchanged' };
  let after: CodexState;
  try {
    after = codexState(next);
  } catch {
    return { kind: 'skip', reason: 'could not be edited safely (the result would not parse); left it unchanged' };
  }
  const expected = enabled ? canonical(codexEntry(server)) : undefined;
  if (after.rest !== before.rest || (after.entry === undefined ? undefined : canonical(after.entry)) !== expected) {
    return { kind: 'skip', reason: "could not be edited without changing more than Dictate's table; left it unchanged" };
  }
  return { kind: 'write', text: next, action: !enabled ? 'removed' : range ? 'updated' : 'added' };
}

// ---------- A small TOML reader: enough to check an edit, not a general-purpose parser ----------

interface TomlHeader {
  path: string[];
  array: boolean;
  /** Zero-based line of the header. */
  line: number;
}

/** Parses TOML 1.0 into plain objects (dates stay strings). Throws on anything it doesn't understand. */
export function parseToml(text: string): Record<string, unknown> {
  return readToml(text).data;
}

function readToml(src: string): { data: Record<string, unknown>; headers: TomlHeader[] } {
  const s = src.replace(/^﻿/, ' ');
  let i = 0;
  const root: Record<string, unknown> = {};
  const headers: TomlHeader[] = [];
  const declared = new Set<object>();
  const frozen = new Set<object>();
  let current = root;

  const lineAt = (p: number) => s.slice(0, p).split('\n').length - 1;
  const fail = (m: string): never => {
    throw new Error(`${m} on line ${lineAt(i) + 1}`);
  };
  const ws = () => {
    while (s[i] === ' ' || s[i] === '\t') i++;
  };
  const newline = () => {
    if (s[i] === '\r' && s[i + 1] === '\n') i += 2;
    else if (s[i] === '\n') i++;
    else return false;
    return true;
  };
  const comment = () => {
    if (s[i] !== '#') return;
    while (i < s.length && s[i] !== '\n' && !(s[i] === '\r' && s[i + 1] === '\n')) i++;
  };
  const endOfLine = () => {
    ws();
    comment();
    if (i < s.length && !newline()) fail('expected the end of the line');
  };
  /** Whitespace, newlines and comments, as allowed inside arrays. */
  const gap = () => {
    for (;;) {
      ws();
      comment();
      if (!newline()) return;
    }
  };

  const readEscape = (): string => {
    const c = s[i++];
    const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\', e: '\x1b' };
    if (c in simple) return simple[c];
    if (c === 'u' || c === 'U') {
      const n = c === 'u' ? 4 : 8;
      const hex = s.slice(i, i + n);
      if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== n) fail('bad unicode escape');
      i += n;
      return String.fromCodePoint(Number.parseInt(hex, 16));
    }
    return fail('bad escape');
  };

  const string = (): string => {
    const q = s[i];
    const multi = s.startsWith(q.repeat(3), i);
    i += multi ? 3 : 1;
    if (multi) newline();
    let out = '';
    for (;;) {
      if (i >= s.length) fail('unterminated string');
      const c = s[i];
      if (multi && s.startsWith(q.repeat(3), i)) {
        let n = 3;
        while (s[i + n] === q && n < 5) n++;
        out += q.repeat(n - 3);
        i += n;
        return out;
      }
      if (!multi && c === q) {
        i++;
        return out;
      }
      if (!multi && (c === '\n' || c === '\r')) fail('newline in a string');
      if (q === '"' && c === '\\') {
        i++;
        if (multi && /^[ \t]*\r?\n/.test(s.slice(i, i + 100))) {
          while (/[ \t\r\n]/.test(s[i] ?? '')) i++;
          continue;
        }
        out += readEscape();
        continue;
      }
      out += c;
      i++;
    }
  };

  const keyPart = (): string => {
    if (s[i] === '"' || s[i] === "'") {
      if (s.startsWith(s[i].repeat(3), i)) fail('a key cannot be a multi-line string');
      return string();
    }
    const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i, i + 256));
    if (!m) return fail('expected a key');
    i += m[0].length;
    return m[0];
  };
  const key = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      ws();
      parts.push(keyPart());
      ws();
      if (s[i] !== '.') return parts;
      i++;
    }
  };

  /** The table at `path` under `from`, created when missing. */
  const descend = (from: Record<string, unknown>, path: string[]): Record<string, unknown> => {
    let t = from;
    for (const k of path) {
      let v = t[k];
      if (v === undefined) t[k] = v = {};
      if (Array.isArray(v) && !frozen.has(v)) v = v[v.length - 1];
      if (!isObject(v) || frozen.has(v)) fail(`"${k}" is not a table`);
      t = v as Record<string, unknown>;
    }
    return t;
  };

  const value = (): unknown => {
    const c = s[i];
    if (c === '"' || c === "'") return string();
    if (c === '[') {
      i++;
      const arr: unknown[] = [];
      for (;;) {
        gap();
        if (s[i] === ']') break;
        arr.push(value());
        gap();
        if (s[i] === ',') i++;
        else if (s[i] !== ']') fail('expected , or ] in an array');
      }
      i++;
      frozen.add(arr);
      return arr;
    }
    if (c === '{') {
      i++;
      const t: Record<string, unknown> = {};
      ws();
      if (s[i] === '}') i++;
      else
        for (;;) {
          keyValue(t);
          ws();
          if (s[i] === ',') i++;
          else if (s[i] === '}') {
            i++;
            break;
          } else fail('expected , or } in an inline table');
        }
      frozen.add(t);
      return t;
    }
    const rest = s.slice(i, i + 64);
    const date = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|^\d{2}:\d{2}:\d{2}(?:\.\d+)?/.exec(rest);
    const word = /^(?:true|false|[+-]?(?:inf|nan)|0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|[+-]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?)/.exec(rest);
    const m = date ?? word;
    if (!m || !/^(?:[\s,\]}#]|$)/.test(rest.slice(m[0].length))) return fail('expected a value');
    i += m[0].length;
    const t = m[0];
    if (date) return t;
    if (t === 'true' || t === 'false') return t === 'true';
    if (/inf$/.test(t)) return t.startsWith('-') ? -Infinity : Infinity;
    if (/nan$/.test(t)) return Number.NaN;
    return Number(t.replace(/_/g, ''));
  };

  const keyValue = (into: Record<string, unknown>) => {
    const path = key();
    if (s[i] !== '=') fail('expected =');
    i++;
    ws();
    const v = value();
    const t = descend(into, path.slice(0, -1));
    const last = path[path.length - 1];
    if (last in t) fail(`"${path.join('.')}" is defined twice`);
    t[last] = v;
  };

  while (i < s.length) {
    ws();
    if (s[i] === '[') {
      const line = lineAt(i);
      const array = s[i + 1] === '[';
      i += array ? 2 : 1;
      const path = key();
      if (!s.startsWith(array ? ']]' : ']', i)) fail('expected ]');
      i += array ? 2 : 1;
      headers.push({ path, array, line });
      const parent = descend(root, path.slice(0, -1));
      const last = path[path.length - 1];
      if (array) {
        const list = parent[last] ?? [];
        if (!Array.isArray(list) || frozen.has(list)) fail(`"${path.join('.')}" is not an array of tables`);
        parent[last] = list;
        current = {};
        (list as unknown[]).push(current);
      } else {
        const t = descend(parent, [last]);
        if (declared.has(t)) fail(`[${path.join('.')}] is defined twice`);
        declared.add(t);
        current = t;
      }
      endOfLine();
    } else if (s[i] === '#' || s[i] === '\n' || s[i] === '\r' || i >= s.length) endOfLine();
    else {
      keyValue(current);
      endOfLine();
    }
  }
  return { data: root, headers };
}

// ---------- "Copy setup" for agents Dictate doesn't write ----------

export interface Snippet {
  agent: string;
  /** Where it goes, for display (~ is the home folder). */
  file: string;
  /** JSON to merge into that file. */
  text: string;
  note?: string;
}

/** Pasteable entries for other agents. They carry no ownership marker: once pasted, they are the person's. */
export function setupSnippets(server: ServerEntry, platform: NodeJS.Platform): Snippet[] {
  const { [MARKER_ENV]: _marker, ...env } = server.env;
  const { command, args } = server;
  const json = (v: unknown) => JSON.stringify(v, null, 2);
  const win = platform === 'win32';
  const entry = { command, args, env };
  return [
    {
      agent: 'Gemini CLI',
      file: '~/.gemini/settings.json',
      // ask can wait 600 s; Gemini's timeout is in milliseconds.
      text: json({ mcpServers: { [SERVER_NAME]: { ...entry, timeout: CODEX_TOOL_TIMEOUT_SEC * 1000 } } }),
    },
    {
      agent: 'VS Code',
      file: 'mcp.json (Command Palette: "MCP: Open User Configuration")',
      text: json({ servers: { [SERVER_NAME]: { type: 'stdio', ...entry } } }),
    },
    { agent: 'Copilot CLI', file: '~/.copilot/mcp-config.json', text: json({ mcpServers: { [SERVER_NAME]: { type: 'local', ...entry, tools: ['*'] } } }) },
    {
      agent: 'Windsurf',
      file: win ? '%APPDATA%\\devin\\mcp_config.json' : '~/.config/devin/mcp_config.json',
      text: json({ mcpServers: { [SERVER_NAME]: entry } }),
      note: 'Older Windsurf builds read ~/.codeium/windsurf/mcp_config.json.',
    },
    {
      agent: 'opencode',
      file: '~/.config/opencode/opencode.json',
      text: json({ mcp: { [SERVER_NAME]: { type: 'local', command: [command, ...args], environment: env, enabled: true } } }),
    },
    { agent: 'Zed', file: win ? '%APPDATA%\\Zed\\settings.json' : '~/.config/zed/settings.json', text: json({ context_servers: { [SERVER_NAME]: entry } }) },
    { agent: 'Amp', file: '~/.config/amp/settings.json', text: json({ 'amp.mcpServers': { [SERVER_NAME]: entry } }) },
  ];
}
