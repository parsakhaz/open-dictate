// One command, one JSON frame. Installed next to channel.json; no app auto-launch.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { type AppToBridge, CHANNEL_FILE, type ChannelInfo, frame, lineReader, MAX_LINE, paneIdsFrom, type RequestOperation } from '../core/agentwire';
import { object, originOf, requestSchema } from '../core/requestcontract';
import { REQUEST_KINDS, REQUEST_LIMITS, RequestError } from '../core/requests';

declare const DICTATE_VERSION: string;
declare const DICTATE_BUILD: string;
const identity = { version: DICTATE_VERSION, build: DICTATE_BUILD };
const help = `Dictate ${DICTATE_VERSION} (${DICTATE_BUILD})
  dictate notify|ask|decide|approve|lineup|peek --from-json FILE|- [--origin-file FILE] [--retry-key KEY --instance ID] --json
  dictate request create --from-json FILE|- --json
  dictate request get|cancel ID --json
  dictate request list [--state pending|terminal|all] [--limit 50] [--cursor CURSOR] --json
  dictate request wait ID [--timeout 45s] --json
  dictate status|doctor|schema [request|KIND] --json
  dictate --help | --version
Creation never waits for a human. Only request wait observes (default 45s, max 600s, 0 polls).
Requests survive command exits, held cards and snoozes. APP RESTART LOSES ALL REQUESTS AND RESULTS.
For safe retries save status.instance_id, then reuse that --instance and --retry-key.
Unkeyed creates are unsafe to blindly retry after ambiguous transport loss.
All commands use this destination's cwd for assets. --origin-file is display metadata, never routing.
Set DICTATE_AGENT_CHANNEL to choose an isolated profile's channel.json. No implicit app launch.
Exit 0 protocol success (inspect result); 2 input; 3 connection/protocol; 4 request state; 130 interrupted.
`;
function invalid(message: string): never {
  throw new RequestError('invalid_input', message);
}
function parse(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const booleans = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    if (flags.has(arg) || booleans.has(arg)) invalid('Duplicate option');
    if (['--json', '--help', '--version'].includes(arg)) booleans.add(arg);
    else if (['--from-json', '--origin-file', '--retry-key', '--instance', '--state', '--limit', '--cursor', '--timeout'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) invalid('Option requires a value');
      flags.set(arg, value);
    } else invalid('Unknown option; run dictate --help');
  }
  return { positional, flags, booleans };
}
async function readObject(file: string): Promise<Record<string, unknown>> {
  let data: Buffer;
  if (file === '-') {
    const parts: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const b = Buffer.from(chunk);
      bytes += b.length;
      if (bytes > REQUEST_LIMITS.input) invalid('JSON input exceeds byte limit');
      parts.push(b);
    }
    data = Buffer.concat(parts);
  } else {
    try {
      const fd = fs.openSync(file, 'r');
      try {
        data = Buffer.alloc(REQUEST_LIMITS.input + 1);
        const size = fs.readSync(fd, data, 0, data.length, 0);
        data = data.subarray(0, size);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return invalid('Cannot read JSON input file');
    }
  }
  if (data.length > REQUEST_LIMITS.input) invalid('JSON input exceeds byte limit');
  try {
    return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/^\uFEFF/, '')));
  } catch {
    return invalid('Expected one UTF-8 JSON object');
  }
}
function exchange(operation: RequestOperation, args: unknown, channelFile: string, timeout: number): Promise<unknown> {
  let content: string;
  try {
    content = fs.readFileSync(channelFile, 'utf8');
  } catch {
    throw new RequestError('app_unavailable', 'No readable local channel; start Dictate or check DICTATE_AGENT_CHANNEL');
  }
  let info: ChannelInfo;
  try { info = JSON.parse(content); }
  catch { throw new RequestError('unsupported_version', 'Invalid channel discovery; restart Dictate or check the selected profile'); }
  if (!info || typeof info !== 'object' || Array.isArray(info) || info.version !== 1 || typeof info.path !== 'string' || typeof info.token !== 'string')
    throw new RequestError('unsupported_version', 'Invalid or unsupported channel discovery');
  return new Promise((resolve, reject) => {
    const socket = net.connect(info.path);
    let sent = false;
    let settled = false;
    const done = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const gone = () =>
      done(
        new RequestError(
          sent ? 'transport_failure' : 'app_unavailable',
          sent ? 'Connection ended without acknowledgement' : 'Dictate is not reachable',
          sent && operation === 'create' ? { acceptance: 'unknown' } : {},
        ),
      );
    const timer = setTimeout(
      () => done(new RequestError('transport_failure', 'Local channel timed out', sent && operation === 'create' ? { acceptance: 'unknown' } : {})),
      timeout + 5000,
    );
    socket.on('error', gone);
    socket.on('close', gone);
    socket.on('connect', () =>
      socket.write(
        frame({
          t: 'hello',
          token: info.token,
          client: { name: 'dictate-cli', ...identity },
          pane: paneIdsFrom(process.env),
          cwd: process.cwd(),
          pid: process.pid,
        }),
      ),
    );
    socket.on(
      'data',
      lineReader(
        (raw) => {
          const m = raw as AppToBridge;
          if (m.t === 'hello') {
            if (!m.ok) return done(new RequestError('authentication_failed', 'Local channel refused authentication'));
            if (m.requests !== 1) return done(new RequestError('unsupported_version', 'Running Dictate does not support app-owned requests; update the app'));
            const message = frame({
              t: 'request',
              version: 1,
              id: 1,
              operation,
              args,
            });
            if (message.length > MAX_LINE) return done(new RequestError('invalid_input', 'Request exceeds channel limit'));
            sent = true;
            socket.write(message);
          } else if (m.t === 'result' && m.id === 1) {
            if ('error' in m)
              done(new RequestError('transport_failure', 'App returned a channel error', operation === 'create' ? { acceptance: 'unknown' } : {}));
            else done(undefined, m.result);
          }
        },
        MAX_LINE,
        () => done(new RequestError('transport_failure', 'Response exceeds channel limit')),
      ),
    );
  });
}
async function main(): Promise<void> {
  const { positional: p, flags: f, booleans: b } = parse(process.argv.slice(2));
  const emit = (value: unknown) => process.stdout.write(frame(value));
  if (b.has('--version')) {
    b.has('--json') ? emit({ schema_version: 1, ...identity }) : process.stdout.write(`${DICTATE_VERSION} (${DICTATE_BUILD})\n`);
    return;
  }
  if (b.has('--help') || p.length === 0) {
    b.has('--json') ? emit({ schema_version: 1, help, ...identity }) : process.stdout.write(help);
    return;
  }
  const command = p[0];
  if (command === 'schema') {
    if (p.length > 2 || f.size) invalid('Invalid schema arguments');
    emit(requestSchema(p[1]));
    return;
  }
  let operation: RequestOperation;
  let args: Record<string, unknown> = {};
  let timeout = 0;
  let allowed: string[] = [];
  if (REQUEST_KINDS.includes(command as (typeof REQUEST_KINDS)[number]) || (command === 'request' && p[1] === 'create')) {
    if (p.length !== (command === 'request' ? 2 : 1)) invalid('Creation requires --from-json FILE or -');
    if (!f.has('--from-json')) invalid('Creation requires --from-json FILE or -');
    const input = await readObject(f.get('--from-json')!);
    args = command === 'request' ? input : { kind: command, args: input };
    if (f.has('--origin-file')) args.origin = originOf(await readObject(f.get('--origin-file')!));
    if (f.has('--retry-key')) args.retry_key = f.get('--retry-key');
    if (f.has('--instance')) args.instance = f.get('--instance');
    operation = 'create';
    allowed = ['--from-json', '--origin-file', '--retry-key', '--instance'];
  } else if (command === 'status' || command === 'doctor') {
    if (p.length !== 1 || f.size) invalid('Invalid status/doctor arguments');
    operation = 'status';
  } else if (command === 'request' && ['get', 'list', 'wait', 'cancel'].includes(p[1])) {
    operation = p[1] as RequestOperation;
    if (operation === 'list') {
      if (p.length !== 2) invalid('Invalid list arguments');
      args = {
        state: f.get('--state') ?? 'pending',
        limit: f.has('--limit') ? Number(f.get('--limit')) : 50,
        ...(f.has('--cursor') ? { cursor: f.get('--cursor') } : {}),
      };
      allowed = ['--state', '--limit', '--cursor'];
    } else {
      if (p.length !== 3) invalid('Request ID is required');
      args.request_id = p[2];
      if (operation === 'wait') {
        const value = f.get('--timeout') ?? '45s';
        const match = /^(\d+(?:\.\d+)?)(ms|s)?$/.exec(value);
        if (!match) invalid('Timeout must be a duration, for example 45s');
        timeout = Number(match[1]) * (match[2] === 'ms' ? 1 : 1000);
        if (timeout > 600_000) invalid('Maximum wait timeout is 600s');
        args.timeout_ms = timeout;
        allowed = ['--timeout'];
      }
    }
  } else return invalid('Unknown command; run dictate --help');
  for (const key of f.keys()) if (!allowed.includes(key)) invalid('Option is not valid for this command');
  const channel = process.env.DICTATE_AGENT_CHANNEL || path.join(__dirname, CHANNEL_FILE);
  let result: unknown;
  try {
    result = await exchange(operation, args, channel, timeout);
  } catch (e) {
    if (command !== 'doctor') throw e;
    const error = e instanceof RequestError ? { code: e.code, message: e.message, ...e.details } : { code: 'app_unavailable' };
    result = { schema_version: 1, error };
  }
  if (command === 'doctor' || command === 'status')
    result = {
      ...object(result),
      cli: identity,
      executable: process.execPath,
      script: __filename,
      channel_file: channel,
      cwd: process.cwd(),
      profile: path.dirname(path.dirname(channel)),
      runtime: process.versions.node,
      retention: 'app_lifetime_only',
      restart: 'App restarts lose requests and results. Do not replay automatically.',
    };
  const err = object(result).error as { code?: string } | undefined;
  if (err) process.exitCode = exitCode(err.code);
  emit(result);
}
function exitCode(code?: string): number {
  return code === 'invalid_input' ? 2 : ['app_unavailable', 'authentication_failed', 'unsupported_version', 'transport_failure'].includes(code ?? '') ? 3 : 4;
}
process.stdout.on('error', () => {
  process.exitCode = 3;
});
process.on('SIGINT', () => process.exit(130));
main().catch((e) => {
  const error =
    e instanceof RequestError
      ? { code: e.code, message: e.message, ...e.details }
      : {
          code: 'invalid_input',
          message: 'Command failed; check usage and input files',
        };
  process.exitCode = exitCode(error.code);
  process.stdout.write(frame({ schema_version: 1, error }));
});
