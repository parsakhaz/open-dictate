// Drive the actual bundled process through a real authenticated local channel.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AgentHub, type HubDeps } from '../src/core/agenthub';
import { channelPath, lineReader } from '../src/core/agentwire';
import { AgentRequests } from '../src/main/agentrequests';
import { AgentServer } from '../src/main/agentserver';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dictate-cli spaces-'));
const entry = path.join(dir, 'dictate-cli.js');
let server: AgentServer;
let hub: AgentHub;
it('preserves Unicode when the local stream splits a multibyte character', () => {
  const values: unknown[] = [];
  const read = lineReader((value) => values.push(value));
  const bytes = Buffer.from('{"text":"雪"}\n');
  const split = bytes.indexOf(Buffer.from('雪')) + 1;
  read(bytes.subarray(0, split));
  read(bytes.subarray(split));
  expect(values).toEqual([{ text: '雪' }]);
});
beforeAll(async () => {
  await build({
    entryPoints: ['src/bridge/dictate-cli.ts'],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    define: { DICTATE_VERSION: '"0.2.2"', DICTATE_BUILD: '"test-build"' },
  });
  hub = new AgentHub({
    now: Date.now,
    setTimer: setTimeout,
    clearTimer: (x: unknown) => clearTimeout(x as ReturnType<typeof setTimeout>),
    changed: () => {},
    chime: () => {},
    log: () => {},
    status: () => ({ modelsReady: true, dictating: false }),
    pane: { tab: async () => null },
    history: { enabled: () => false },
  } as unknown as HubDeps);
  const requests = new AgentRequests(hub);
  server = new AgentServer(dir, channelPath(dir, process.platform, os.tmpdir()), {
    call: (s, tool, args, signal) => hub.call(s, tool, args, signal),
    closed: (s) => hub.sessionClosed(s.id),
    request: (s, op, args, signal) => requests.call(s, op, args, signal),
  });
  await server.start();
});
afterAll(() => {
  for (const c of hub.queue.view(Date.now()).all) hub.dismiss(c.id);
  server.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
function cli(args: string[], stdin = '', extra: Record<string, string> = {}) {
  return new Promise<{
    code: number | null;
    value: {
      request_id: string;
      instance_id: string;
      card_id: string;
      terminal: boolean;
      observation: string;
      error: { code: string };
      inputs: Record<string, unknown>;
    };
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: dir,
      env: {
        ...process.env,
        DICTATE_AGENT_CHANNEL: server.channelFile,
        ...extra,
      },
      stdio: 'pipe',
    });
    let stdout = '',
      stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('CLI did not exit promptly'));
    }, 5000);
    child.stdout.on('data', (x) => {
      stdout += x;
    });
    child.stderr.on('data', (x) => {
      stderr += x;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      try {
        resolve({ code, value: JSON.parse(stdout), stderr });
      } catch {
        reject(new Error(`Not one JSON document: ${stdout}; ${stderr}`));
      }
    });
    child.stdin.end(stdin);
  });
}
it('creates without waiting, answers after process exit and returns the full result repeatedly', async () => {
  const content = { question: 'Unicode 雪 $ ` "\nnext', choices: ['Blue'] };
  const file = path.join(dir, 'quoted 雪 args.json');
  fs.writeFileSync(file, `\uFEFF${JSON.stringify(content)}`);
  const { code, value: receipt, stderr } = await cli(['ask', '--from-json', file, '--json']);
  expect(code).toBe(0);
  expect(stderr).toBe('');
  expect(receipt.terminal).toBe(false);
  expect(hub.waiting(receipt.card_id)).toBe(true);
  const poll = await cli(['request', 'wait', receipt.request_id, '--timeout', '0', '--json']);
  expect(poll.value.observation).toBe('timed_out');
  await hub.choose(receipt.card_id, 'Blue');
  const result = await cli(['request', 'get', receipt.request_id, '--json']);
  expect(result.value).toMatchObject({
    terminal: true,
    state: 'answered',
    result: {
      answered: true,
      raw: 'Blue',
      text: 'Blue',
      choice: 'Blue',
      card_id: receipt.card_id,
    },
  });
  expect((await cli(['request', 'get', receipt.request_id, '--json'])).value).toEqual(result.value);
});
it('deduplicates generic and alias creation and rejects changed input', async () => {
  const instance = (await cli(['status', '--json'])).value.instance_id;
  const flags = ['--from-json', '-', '--retry-key', 'same', '--instance', instance, '--json'];
  const a = await cli(['ask', ...flags], '{"question":"Retry?"}');
  const b = await cli(['request', 'create', ...flags], '{"kind":"ask","args":{"question":"Retry?"}}');
  expect(a.value.request_id).toBe(b.value.request_id);
  const conflict = await cli(['ask', ...flags], '{"question":"Different"}');
  expect(conflict.code).toBe(4);
  expect(conflict.value.error.code).toBe('retry_conflict');
  const cancelled = await cli(['request', 'cancel', a.value.request_id, '--json']);
  expect(cancelled.value).toMatchObject({
    state: 'cancelled',
    cancelled_now: true,
  });
});
it('discovers schemas and identity offline, rejects malformed input and produces structured connection errors', async () => {
  expect((await cli(['--version', '--json'])).value).toMatchObject({
    version: '0.2.2',
    build: 'test-build',
  });
  expect((await cli(['schema', 'approve', '--json'])).value.inputs.approve).toBeDefined();
  for (const input of ['', '[]', '{} {}', '{"question":']) {
    const result = await cli(['ask', '--from-json', '-', '--json'], input);
    expect(result.code).toBe(2);
    expect(result.value.error.code).toBe('invalid_input');
  }
  const result = await cli(['status', '--json'], '', {
    DICTATE_AGENT_CHANNEL: path.join(dir, 'missing.json'),
  });
  expect(result.code).toBe(3);
  expect(result.value.error.code).toBe('app_unavailable');
  expect(JSON.stringify(result)).not.toContain('token');
});

it('uses normalized effective inputs for retries and reports truncation without changing MCP schemas', async () => {
  const instance = (await cli(['status', '--json'])).value.instance_id;
  const flags = ['--from-json', '-', '--retry-key', 'normalized', '--instance', instance, '--json'];
  const first = await cli(['ask', ...flags], '{"question":"  Normalized?  ","timeout_s":9999}');
  const same = await cli(['request', 'create', ...flags], '{"kind":"ask","args":{"question":"Normalized?","timeout_s":600}}');
  expect(first.value.request_id).toBe(same.value.request_id);
  await cli(['request', 'cancel', first.value.request_id, '--json']);
});

it('reports corrupt or unsupported discovery and wrong authentication as channel failures', async () => {
  const file = path.join(dir, 'bad-channel.json');
  for (const content of ['null', '[]', '{', '{"version":0}']) {
    fs.writeFileSync(file, content);
    const result = await cli(['status', '--json'], '', { DICTATE_AGENT_CHANNEL: file });
    expect(result.code).toBe(3);
    expect(result.value.error.code).toBe('unsupported_version');
  }
  const actual = JSON.parse(fs.readFileSync(server.channelFile, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...actual, token: '0'.repeat(64) }));
  const refused = await cli(['status', '--json'], '', { DICTATE_AGENT_CHANNEL: file });
  expect(refused.code).toBe(3);
  expect(refused.value.error.code).toBe('authentication_failed');
});
