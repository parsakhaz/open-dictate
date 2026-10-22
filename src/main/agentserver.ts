// The app's end of the agent channel: a named pipe (Windows) or a Unix socket in a 0700 folder, local only, that
// accepts a bridge only after it presents the token. Each connection is one agent session. No Electron imports, so
// the bridge test drives it directly.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { type AppToBridge, type BridgeToApp, CHANNEL_FILE, type ChannelInfo, type ClientInfo, frame, lineReader, MAX_LINE, MAX_LINE_SIZE, megabytes, type PaneIds } from '../core/agentwire';

export interface AgentSession {
  id: string;
  client: ClientInfo;
  pane: PaneIds | null;
  cwd: string;
  pid: number;
  connectedAt: number;
}

export interface AgentHandlers {
  request?(session: AgentSession, operation: string, args: unknown, signal: AbortSignal): Promise<unknown>;
  /** A tool call; throw to answer with an error. `signal` aborts when the agent cancels or disconnects. */
  call(session: AgentSession, tool: string, args: unknown, signal: AbortSignal): Promise<unknown>;
  closed?(session: AgentSession): void;
  log?(level: 'info' | 'warn', msg: string): void;
}

export class AgentServer {
  private server: net.Server | undefined;
  private token = '';
  private nextSession = 1;
  readonly sessions = new Map<string, AgentSession>();

  constructor(
    /** Where the bridge lives; the channel file is written beside it. */
    private dir: string,
    private socketPath: string,
    private handlers: AgentHandlers,
  ) {}

  get channelFile(): string {
    return path.join(this.dir, CHANNEL_FILE);
  }

  async start(): Promise<void> {
    this.token = randomBytes(32).toString('hex');
    fs.mkdirSync(this.dir, { recursive: true });
    if (!this.socketPath.startsWith('\\\\.\\pipe\\')) {
      // Only this user may reach the socket: its folder is 0700, and a stale socket from a crash is removed.
      const folder = path.dirname(this.socketPath);
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      fs.chmodSync(folder, 0o700);
      fs.rmSync(this.socketPath, { force: true });
    }
    const server = net.createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    const info: ChannelInfo = { version: 1, path: this.socketPath, token: this.token, pid: process.pid };
    const tmp = `${this.channelFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(info)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.channelFile);
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
    // Bridges that read the file after this say Dictate isn't running, rather than trying a dead channel.
    try {
      const c = JSON.parse(fs.readFileSync(this.channelFile, 'utf8')) as ChannelInfo;
      if (c.pid === process.pid) fs.rmSync(this.channelFile, { force: true });
    } catch {
      // nothing to remove
    }
  }

  private accept(socket: net.Socket): void {
    let session: AgentSession | null = null;
    const calls = new Map<number, AbortController>();
    const write = (m: AppToBridge) => {
      if (socket.destroyed) return;
      const f = frame(m);
      // The bridge can't read a line this long; an error it can read beats an answer that never arrives.
      if (f.length - 1 > MAX_LINE && m.t === 'result') socket.write(frame({ t: 'result', id: m.id, error: `The answer is ${megabytes(f.length)}, and the bridge reads at most ${MAX_LINE_SIZE}.` }));
      else socket.write(f);
    };
    // A connection that doesn't say hello promptly is dropped.
    const helloTimer = setTimeout(() => socket.destroy(), 5000);
    socket.on(
      'data',
      lineReader((raw) => {
        const m = raw as BridgeToApp;
        if (!session) {
          clearTimeout(helloTimer);
          if (m?.t !== 'hello' || !this.tokenOk(m.token)) {
            write({ t: 'hello', ok: false, error: 'Dictate refused the connection.' });
            this.handlers.log?.('warn', 'agent channel: a connection without the right token was refused');
            socket.end();
            return;
          }
          session = {
            id: `s${this.nextSession++}`,
            client: cleanClient(m.client),
            pane: m.pane && typeof m.pane.sessionId === 'string' && typeof m.pane.panelId === 'string' ? { sessionId: m.pane.sessionId, panelId: m.pane.panelId } : null,
            cwd: typeof m.cwd === 'string' ? m.cwd.slice(0, 1000) : '',
            pid: typeof m.pid === 'number' ? m.pid : 0,
            connectedAt: Date.now(),
          };
          this.sessions.set(session.id, session);
          this.handlers.log?.('info', `agent session ${session.id}: ${session.client.name}${session.pane ? ' in a Pane tab' : ''}`);
          write({ t: 'hello', ok: true, session: session.id, ...(this.handlers.request ? { requests: 1 as const } : {}) });
          return;
        }
        const s = session;
        if (m.t === 'cancel') calls.get(m.id)?.abort();
        else if ((m.t === 'call' || m.t === 'request') && typeof m.id === 'number' && !calls.has(m.id)) {
          const ac = new AbortController();
          calls.set(m.id, ac);
          const task = m.t === 'call' ? this.handlers.call(s, String(m.tool), m.args, ac.signal) : m.version !== 1 || !this.handlers.request ? Promise.resolve({ schema_version: 1, error: { code: 'unsupported_version', message: 'Request protocol version is unsupported' } }) : this.handlers.request(s, m.operation, m.args, ac.signal);
          task
            .then(
              (result) => write({ t: 'result', id: m.id, result }),
              (err) => write({ t: 'result', id: m.id, error: err instanceof Error ? err.message : String(err) }),
            )
            .finally(() => calls.delete(m.id));
        }
      }),
    );
    const close = () => {
      clearTimeout(helloTimer);
      for (const ac of calls.values()) ac.abort();
      calls.clear();
      if (session && this.sessions.delete(session.id)) this.handlers.closed?.(session);
    };
    socket.on('close', close);
    socket.on('error', () => socket.destroy());
  }

  private tokenOk(t: unknown): boolean {
    if (typeof t !== 'string' || t.length !== this.token.length) return false;
    return timingSafeEqual(Buffer.from(t), Buffer.from(this.token));
  }
}

function cleanClient(c: unknown): ClientInfo {
  const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
  const s = (x: unknown, n: number) => (typeof x === 'string' ? x.replace(/[^\p{L}\p{N} ._\-()]/gu, '').slice(0, n) : undefined);
  return { name: s(o.name, 80) || 'unknown', ...(s(o.title, 80) ? { title: s(o.title, 80) } : {}), ...(s(o.version, 40) ? { version: s(o.version, 40) } : {}) };
}
