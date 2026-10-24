import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BLOCK_BEGIN, BLOCK_END, editInstructions, instructionsState, renderBlock } from '../src/core/instructions';
import { instructionsStatus, syncInstructions } from '../src/main/instructions';

/** A user's own CLAUDE.md, with Pane's managed section in it: none of these bytes may change. */
const PANE = [
  '<!-- pane-memories:start -->',
  '## Pane memories',
  '',
  '<!-- pane-memories:store 5e8211b1 -->',
  '### Scoped notes in Pane',
  'Before answering each user turn, check PANE_NOTES_FILE.',
  '',
  '<!-- pane-memories:end -->',
  '',
  '## Mobile releases',
  '- Bump `runtimeVersion` for native changes.',
  '',
].join('\n');

const BOM = String.fromCharCode(0xfeff);
const write = (text: string | undefined, enabled = true) => {
  const e = editInstructions(text, enabled);
  if (e.kind !== 'write') throw new Error(`expected a write, got ${JSON.stringify(e)}`);
  return e;
};

describe('the block', () => {
  it('is three or four lines between the markers and names the tools and the plain-words rule', () => {
    const lines = renderBlock();
    expect(lines[0]).toBe(BLOCK_BEGIN);
    expect(lines.at(-1)).toBe(BLOCK_END);
    const body = lines.slice(1, -1);
    expect(body.length).toBeGreaterThanOrEqual(3);
    expect(body.length).toBeLessThanOrEqual(4);
    const text = body.join('\n');
    expect(text).toContain('`notify`');
    expect(text).toContain('`needs_you`');
    expect(text).toContain('`ask`');
    expect(text).toContain('`info`');
    for (const tool of ['decide', 'approve', 'lineup', 'peek', 'card_status']) expect(text).toContain(`\`${tool}\``);
    expect(text).toContain('The person is juggling many tasks and has lost the thread.');
  });
});

describe('editInstructions', () => {
  it('creates the content of a missing or empty file', () => {
    const e = write(undefined);
    expect(e.action).toBe('added');
    expect(e.text).toBe(`${renderBlock().join('\n')}\n`);
    expect(write('').text).toBe(e.text);
  });

  it("appends after the user's content, a blank line apart, keeping every byte before it", () => {
    const e = write(PANE);
    expect(e.action).toBe('added');
    expect(e.text).toBe(`${PANE}\n${renderBlock().join('\n')}\n`);
  });

  it('adds a line break first when the file does not end with one', () => {
    expect(write('# Mine').text).toBe(`# Mine\n\n${renderBlock().join('\n')}`);
    expect(write('a\r\nb').text).toBe(`a\r\nb\r\n\r\n${renderBlock().join('\r\n')}`);
  });

  it('leaves a file whose block is current unchanged', () => {
    expect(editInstructions(write(PANE).text, true)).toEqual({ kind: 'unchanged' });
    expect(editInstructions(PANE, false)).toEqual({ kind: 'unchanged' });
    expect(editInstructions(undefined, false)).toEqual({ kind: 'unchanged' });
  });

  it('replaces an outdated or edited block in place, leaving the text around it alone', () => {
    const old = `# Top\n\n${BLOCK_BEGIN}\nAn older note.\n${BLOCK_END}\n\n${PANE}`;
    const e = write(old);
    expect(e.action).toBe('updated');
    expect(e.text).toBe(`# Top\n\n${renderBlock().join('\n')}\n\n${PANE}`);
  });

  it('finds an older begin marker by its prefix', () => {
    const e = write(`<!-- dictate:begin -->\nold\n${BLOCK_END}\n`);
    expect(e.text).toBe(`${renderBlock().join('\n')}\n`);
  });

  it('removes only the block, giving back the file it was added to byte for byte', () => {
    for (const original of [PANE, '', '# Mine\n', '# Mine\r\n\r\nMore\r\n', '\n\n# Spaced\n\n', '# Mine', 'a\r\n\r\nb', 'a\n\n', ' ']) {
      const added = write(original).text;
      const removed = write(added, false);
      expect(removed.action).toBe('removed');
      expect(removed.text).toBe(original);
    }
  });

  it('removes a block in the middle or at the top without leaving a doubled blank line', () => {
    const block = renderBlock().join('\n');
    expect(write(`# A\n\n${block}\n\n# B\n`, false).text).toBe('# A\n\n# B\n');
    expect(write(`${block}\n\n# B\n`, false).text).toBe('# B\n');
    expect(write(`# A\n\n${block}`, false).text).toBe('# A');
    expect(write(`# A\n${block}`, false).text).toBe('# A\n');
  });

  it('replaces a block that ends a CRLF file without a line break, adding no stray \\r', () => {
    expect(write(`a\r\n\r\n${BLOCK_BEGIN}\r\nold\r\n${BLOCK_END}`).text).toBe(`a\r\n\r\n${renderBlock().join('\r\n')}`);
  });

  it("keeps a CRLF file's line endings", () => {
    const crlf = PANE.replace(/\n/g, '\r\n');
    const e = write(crlf);
    expect(e.text).toBe(`${crlf}\r\n${renderBlock().join('\r\n')}\r\n`);
    expect(e.text.replace(/\r\n/g, '')).not.toContain('\n');
    expect(editInstructions(e.text, true)).toEqual({ kind: 'unchanged' });
  });

  it('keeps a byte order mark that was already there, and never adds one', () => {
    expect(write(undefined).text.charCodeAt(0)).not.toBe(0xfeff);
    const e = write(`${BOM}# Mine\n`);
    expect(e.text.startsWith(`${BOM}# Mine\n\n`)).toBe(true);
    expect(write(e.text, false).text).toBe(`${BOM}# Mine\n`);
  });

  it('skips a file whose markers are unpaired, repeated or out of order', () => {
    for (const bad of [`${BLOCK_BEGIN}\nno end\n`, `${BLOCK_END}\n`, `${BLOCK_END}\n${BLOCK_BEGIN}\n`, `${BLOCK_BEGIN}\n${BLOCK_END}\n${BLOCK_BEGIN}\n${BLOCK_END}\n`]) {
      expect(editInstructions(bad, true).kind).toBe('skip');
      expect(editInstructions(bad, false).kind).toBe('skip');
    }
  });
});

describe('instructionsState', () => {
  it('says whether the block is absent, current or outdated', () => {
    expect(instructionsState(undefined)).toBe('absent');
    expect(instructionsState(PANE)).toBe('absent');
    expect(instructionsState(write(PANE).text)).toBe('current');
    expect(instructionsState(write(PANE.replace(/\n/g, '\r\n')).text)).toBe('current');
    expect(instructionsState(`${BLOCK_BEGIN}\nold\n${BLOCK_END}\n`)).toBe('outdated');
  });

  it('throws on unpaired markers', () => {
    expect(() => instructionsState(`${BLOCK_BEGIN}\n`)).toThrow();
  });
});

describe('syncInstructions (temporary HOME, CLAUDE_CONFIG_DIR and CODEX_HOME)', () => {
  let home: string;
  let logs: string[];
  const claudeMd = () => path.join(home, '.claude', 'CLAUDE.md');
  const agentsMd = () => path.join(home, '.codex', 'AGENTS.md');
  const env = (over: Record<string, string> = {}) => ({ HOME: home, USERPROFILE: home, PATH: '', ...over });
  const opts = (over: Record<string, string> = {}) => ({ env: env(over), log: (_l: string, m: string) => logs.push(m) });
  const bytes = (f: string) => fs.readFileSync(f);

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dictate-instr-'));
    fs.mkdirSync(path.join(home, '.claude'));
    fs.mkdirSync(path.join(home, '.codex'));
    logs = [];
  });
  afterEach(() => {
    for (const f of [claudeMd(), agentsMd()]) if (fs.existsSync(f)) fs.chmodSync(f, 0o644);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('creates both files when they are missing, and reports them', () => {
    const out = syncInstructions(opts(), true);
    expect(out.map((o) => [o.agent, o.action])).toEqual([['claude', 'added'], ['codex', 'added']]);
    expect(fs.readFileSync(claudeMd(), 'utf8')).toBe(`${renderBlock().join('\n')}\n`);
    expect(fs.readFileSync(agentsMd(), 'utf8')).toBe(`${renderBlock().join('\n')}\n`);
    expect(instructionsStatus(opts()).map((s) => [s.agent, s.file, s.state])).toEqual([
      ['claude', claudeMd(), 'current'],
      ['codex', agentsMd(), 'current'],
    ]);
  });

  it("follows CLAUDE_CONFIG_DIR and CODEX_HOME instead of the home folder's", () => {
    const claudeDir = path.join(home, 'claude-config');
    const codexDir = path.join(home, 'codex-home');
    fs.mkdirSync(claudeDir);
    fs.mkdirSync(codexDir);
    syncInstructions(opts({ CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir }), true);
    expect(instructionsState(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8'))).toBe('current');
    expect(instructionsState(fs.readFileSync(path.join(codexDir, 'AGENTS.md'), 'utf8'))).toBe('current');
    expect(fs.existsSync(claudeMd())).toBe(false);
    expect(fs.existsSync(agentsMd())).toBe(false);
  });

  it("writes to the home folder's .codex when CODEX_HOME is a temporary one inherited from an agent's shell", () => {
    const temp = path.join(home, 'Temp');
    for (const codexDir of [path.join(home, '.cache', 'agent-farm', 'run1', 'codex'), path.join(temp, 'codex-x')]) {
      fs.mkdirSync(codexDir, { recursive: true });
      syncInstructions(opts({ CODEX_HOME: codexDir, TEMP: temp }), true);
      expect(fs.existsSync(path.join(codexDir, 'AGENTS.md'))).toBe(false);
    }
    expect(instructionsState(fs.readFileSync(agentsMd(), 'utf8'))).toBe('current');
  });

  it('leaves an agent that is not installed alone', () => {
    fs.rmSync(path.join(home, '.codex'), { recursive: true });
    const out = syncInstructions(opts(), true);
    expect(out.find((o) => o.agent === 'codex')?.action).toBe('not-found');
    expect(fs.existsSync(path.join(home, '.codex'))).toBe(false);
  });

  it("keeps Pane's section and the rest of the user's file byte for byte, and doesn't write again on relaunch", () => {
    fs.writeFileSync(claudeMd(), PANE);
    syncInstructions(opts(), true);
    const after = bytes(claudeMd());
    expect(after.subarray(0, Buffer.byteLength(PANE)).equals(Buffer.from(PANE))).toBe(true);
    const mtime = fs.statSync(claudeMd()).mtimeMs;
    const again = syncInstructions(opts(), true);
    expect(again.map((o) => o.action)).toEqual(['unchanged', 'unchanged']);
    expect(bytes(claudeMd()).equals(after)).toBe(true);
    expect(fs.statSync(claudeMd()).mtimeMs).toBe(mtime);
  });

  it('removes only the block when turned off, giving back the original bytes', () => {
    const crlf = PANE.replace(/\n/g, '\r\n');
    fs.writeFileSync(claudeMd(), PANE);
    fs.writeFileSync(agentsMd(), crlf);
    syncInstructions(opts(), true);
    expect(fs.readFileSync(agentsMd(), 'utf8')).toContain(`${BLOCK_BEGIN}\r\n`);
    const out = syncInstructions(opts(), false);
    expect(out.map((o) => o.action)).toEqual(['removed', 'removed']);
    expect(bytes(claudeMd()).equals(Buffer.from(PANE))).toBe(true);
    expect(bytes(agentsMd()).equals(Buffer.from(crlf))).toBe(true);
    expect(instructionsStatus(opts()).map((s) => s.state)).toEqual(['absent', 'absent']);
  });

  it('deletes a file the block was alone in, so turning on and off leaves no trace', () => {
    syncInstructions(opts(), true);
    syncInstructions(opts(), false);
    expect(fs.existsSync(claudeMd())).toBe(false);
    expect(fs.existsSync(agentsMd())).toBe(false);
  });

  it('turning off with no files creates nothing', () => {
    expect(syncInstructions(opts(), false).map((o) => o.action)).toEqual(['unchanged', 'unchanged']);
    expect(fs.existsSync(claudeMd())).toBe(false);
    expect(fs.existsSync(agentsMd())).toBe(false);
  });

  it('skips and logs a read-only file without changing it', () => {
    fs.writeFileSync(claudeMd(), PANE);
    fs.chmodSync(claudeMd(), 0o444);
    const out = syncInstructions(opts(), true);
    expect(out[0]).toMatchObject({ agent: 'claude', action: 'skipped' });
    expect(out[0].detail).toMatch(/read-only/);
    expect(bytes(claudeMd()).equals(Buffer.from(PANE))).toBe(true);
    expect(logs.some((l) => l.includes('CLAUDE.md') && l.includes('read-only'))).toBe(true);
    expect(out[1].action).toBe('added');
    expect(instructionsStatus(opts())[0].error).toBe('is read-only');
  });

  it("skips a file that isn't UTF-8, or whose markers don't pair up, and still does the other", () => {
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    fs.writeFileSync(claudeMd(), latin1);
    fs.writeFileSync(agentsMd(), `${BLOCK_BEGIN}\nno end\n`);
    const out = syncInstructions(opts(), true);
    expect(out.map((o) => o.action)).toEqual(['skipped', 'skipped']);
    expect(bytes(claudeMd()).equals(latin1)).toBe(true);
    expect(fs.readFileSync(agentsMd(), 'utf8')).toBe(`${BLOCK_BEGIN}\nno end\n`);
    expect(logs.filter((l) => l.includes('left it unchanged'))).toHaveLength(2);
    expect(instructionsStatus(opts()).map((s) => !!s.error)).toEqual([true, true]);
  });

  it('leaves no temporary files behind', () => {
    fs.writeFileSync(claudeMd(), PANE);
    syncInstructions(opts(), true);
    syncInstructions(opts(), false);
    expect(fs.readdirSync(path.join(home, '.claude'))).toEqual(['CLAUDE.md']);
  });
});
