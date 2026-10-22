// App-lifetime requests. Connections observe; only the owner can end a request.
import { createHash, randomUUID } from 'node:crypto';

export const REQUEST_KINDS = ['notify', 'ask', 'decide', 'approve', 'lineup', 'peek'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];
export type RequestState = 'pending' | 'held' | 'shown' | 'snoozed' | 'answered' | 'dismissed' | 'expired' | 'cancelled' | 'completed' | 'failed';
export const REQUEST_LIMITS = {
  active: 64,
  records: 1000,
  keys: 10_000,
  metadata: 256 * 1024 * 1024,
  input: 512 * 1024,
  result: 1024 * 1024,
  lifetime: 24 * 3600_000,
  crop: 10 * 1024 * 1024,
  crops: 128 * 1024 * 1024,
};
export type Origin = {
  id: string;
  machine?: string;
  agent?: string;
  workspace?: string;
  pane_id?: string;
  panel_id?: string;
};
export interface RequestInput {
  kind: RequestKind;
  args: unknown;
  cwd: string;
  origin?: Origin;
  instance?: string;
  retry_key?: string;
  effective?: unknown;
  warnings?: string[];
}
export interface RequestSnapshot {
  schema_version: 1;
  request_id: string;
  instance_id: string;
  kind: RequestKind;
  state: RequestState;
  terminal: boolean;
  created_at: string;
  updated_at: string;
  retained_until?: string;
  card_id?: string;
  presentation?: unknown;
  result?: unknown;
  lifetime: 'app';
  hard_expires_at: string;
  terminal_retention_ms: number;
  retry_retention: 'app_instance';
  origin?: Origin;
  destination: {
    cwd: string;
    source?: string;
    local_pane?: { paneId: string; panelId: string };
  };
  warnings: string[];
}
export class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export interface RequestOwner {
  requestId: string;
  signal: AbortSignal;
  accepted(card: string, presentation?: unknown, destination?: Omit<RequestSnapshot['destination'], 'cwd'>): void;
  /** Reserve a terminal transition before the feature enriches its complete return value. */
  ending(state: RequestState): void;
}
interface RecordEntry {
  snapshot: RequestSnapshot;
  ac: AbortController;
  ready: Promise<RequestSnapshot>;
  done: Promise<void>;
  admitted: boolean;
  winning?: RequestState;
  observers: Set<() => void>;
  timer?: ReturnType<typeof setTimeout>;
  reserved: number;
}
const iso = (n: number) => new Date(n).toISOString();
function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
  if (x && typeof x === 'object')
    return `{${Object.entries(x)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(x);
}
function outcome(result: unknown): RequestState {
  const r = (result ?? {}) as Record<string, unknown>;
  if (r.answered === true || typeof r.approved === 'boolean') return 'answered';
  if (r.reason === 'dismissed') return 'dismissed';
  if (r.reason === 'timeout') return 'expired';
  if (r.reason === 'cancelled') return 'cancelled';
  if (r.answered === false) return 'failed';
  return 'completed';
}
export class RequestBook {
  readonly instance = randomUUID();
  private records = new Map<string, RecordEntry>();
  private keys = new Map<string, { hash: string; id: string }>();
  constructor(
    private now = () => Date.now(),
    private limits = REQUEST_LIMITS,
    private completed?: (snapshot: RequestSnapshot) => void,
  ) {}

  async create(input: RequestInput, start: (owner: RequestOwner) => Promise<unknown>, signal?: AbortSignal): Promise<RequestSnapshot> {
    this.sweep();
    if (!REQUEST_KINDS.includes(input.kind)) throw new RequestError('invalid_input', 'Unsupported request kind');
    if (input.instance && input.instance !== this.instance)
      throw new RequestError('instance_changed', 'The app restarted; do not replay the operation automatically', { instance_id: this.instance });
    if (input.retry_key && (!input.instance || input.retry_key.length > 200))
      throw new RequestError('invalid_input', 'A bounded retry key requires the saved app instance');
    const bytes = Buffer.byteLength(
      JSON.stringify({
        kind: input.kind,
        args: input.args,
        cwd: input.cwd,
        origin: input.origin,
      }),
    );
    if (bytes > this.limits.input) throw new RequestError('invalid_input', 'Request input exceeds the byte limit');
    const key = input.retry_key ? JSON.stringify([input.origin?.id ?? 'local', input.retry_key]) : undefined;
    const hash = createHash('sha256')
      .update(
        canonical({
          kind: input.kind,
          args: input.effective ?? input.args,
          cwd: input.cwd,
          origin: input.origin ?? null,
        }),
      )
      .digest('hex');
    const previous = key ? this.keys.get(key) : undefined;
    if (previous) {
      if (previous.hash !== hash) throw new RequestError('retry_conflict', 'Retry input differs from the accepted operation');
      const entry = this.records.get(previous.id);
      if (!entry) throw new RequestError('result_expired', 'The original result expired; the key remains reserved', { request_id: previous.id });
      await entry.ready;
      return this.get(previous.id);
    }
    const images =
      input.kind === 'lineup' ? ((input.args as { candidates?: { image?: unknown }[] }).candidates ?? []).filter((c) => c.image !== undefined).length : 0;
    // Reserve base64 image snapshots and thumbnails before loading them, plus worst-case result space.
    const reserved = bytes + this.limits.result + images * 15 * 1024 * 1024;
    if (
      this.records.size >= this.limits.records ||
      [...this.records.values()].filter((e) => !e.snapshot.terminal).length >= this.limits.active ||
      (key && this.keys.size >= this.limits.keys) ||
      [...this.records.values()].reduce((n, e) => n + e.reserved, 0) + reserved + (this.keys.size + 1) * 1024 > this.limits.metadata
    )
      throw new RequestError('capacity_exceeded', 'App-lifetime request capacity reached');
    const id = `${this.instance}.${randomUUID()}`;
    let accepted!: (s: RequestSnapshot) => void;
    let rejected!: (e: unknown) => void;
    const ready = new Promise<RequestSnapshot>((resolve, reject) => {
      accepted = resolve;
      rejected = reject;
    });
    const snapshot: RequestSnapshot = {
      schema_version: 1,
      request_id: id,
      instance_id: this.instance,
      kind: input.kind,
      state: 'pending',
      terminal: false,
      created_at: iso(this.now()),
      updated_at: iso(this.now()),
      lifetime: 'app',
      hard_expires_at: iso(this.now() + this.limits.lifetime),
      terminal_retention_ms: this.limits.lifetime,
      retry_retention: 'app_instance',
      destination: { cwd: input.cwd },
      ...(input.origin ? { origin: structuredClone(input.origin) } : {}),
      warnings: [
        ...(input.warnings ?? []),
        ...(input.kind === 'peek' ? ['CLI creation always returns a receipt; peek.wait does not disable result capture.'] : []),
      ],
    };
    const e: RecordEntry = {
      snapshot,
      ac: new AbortController(),
      ready,
      done: Promise.resolve(),
      admitted: false,
      observers: new Set(),
      reserved,
    };
    const detach = () => {
      if (!e.admitted) e.ac.abort();
    };
    signal?.addEventListener('abort', detach, { once: true });
    if (signal?.aborted) detach();
    this.records.set(id, e);
    if (key) this.keys.set(key, { hash, id });
    const owner: RequestOwner = {
      requestId: id,
      signal: e.ac.signal,
      accepted: (card, presentation, destination) => {
        if (e.ac.signal.aborted) return;
        e.admitted = true;
        const acceptedAt = this.now();
        snapshot.created_at = snapshot.updated_at = iso(acceptedAt);
        snapshot.hard_expires_at = iso(acceptedAt + this.limits.lifetime);
        clearTimeout(e.timer);
        e.timer = this.armExpiry(e);
        if (destination) Object.assign(snapshot.destination, structuredClone(destination));
        const state = (presentation as { state?: string })?.state;
        Object.assign(snapshot, {
          card_id: card,
          presentation,
          state: ['held', 'shown', 'snoozed'].includes(state ?? '') ? state : 'pending',
        });
        accepted(structuredClone(snapshot));
      },
      ending: (state) => {
        e.winning ??= state;
      },
    };
    // Reserve identity before entering any asynchronous feature preparation.
    e.done = Promise.resolve()
      .then(() => start(owner))
      .then(
        (result) => {
          if (snapshot.terminal) return;
          if (!e.admitted && e.ac.signal.aborted) {
            this.records.delete(id);
            if (key) this.keys.delete(key);
            rejected(new RequestError('detached', 'Disconnected before acceptance; no request accepted'));
            return;
          }
          e.admitted = true; // DND and other immediate outcomes are accepted terminal receipts.
          e.reserved = bytes + this.limits.result;
          this.finish(e, e.winning ?? outcome(result), result);
          accepted(structuredClone(snapshot));
        },
        (error) => {
          if (!e.admitted) {
            this.records.delete(id);
            if (key) this.keys.delete(key);
            rejected(error);
          } else
            this.finish(e, 'failed', {
              answered: false,
              reason: 'feature_failed',
            });
        },
      );
    e.timer = this.armExpiry(e);
    try {
      return await ready;
    } catch (error) {
      clearTimeout(e.timer);
      throw error;
    } finally {
      signal?.removeEventListener('abort', detach);
    }
  }

  get(id: string): RequestSnapshot {
    this.sweep();
    if (id.split('.')[0] !== this.instance)
      throw new RequestError('state_lost', 'Request belongs to another app instance; app restarts lose requests', { instance_id: this.instance });
    const e = this.records.get(id);
    if (!e) throw new RequestError('not_found', 'Unknown request or its app-lifetime retention expired');
    return structuredClone(e.snapshot);
  }
  async cancel(id: string): Promise<RequestSnapshot & { cancelled_now: boolean }> {
    this.get(id);
    const e = this.records.get(id)!;
    const won = !e.snapshot.terminal && !e.winning;
    if (won) {
      e.winning = 'cancelled';
      e.ac.abort();
    }
    if (!e.snapshot.terminal) await e.done;
    return { ...this.get(id), cancelled_now: won };
  }
  async wait(id: string, timeout: number, signal?: AbortSignal): Promise<RequestSnapshot & { observation: 'terminal' | 'timed_out' }> {
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 600_000)
      throw new RequestError('invalid_input', 'Wait timeout must be between zero and 600 seconds');
    const s = this.get(id);
    if (s.terminal || timeout === 0) return { ...s, observation: s.terminal ? 'terminal' : 'timed_out' };
    const e = this.records.get(id)!;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        e.observers.delete(done);
        signal?.removeEventListener('abort', detach);
      };
      const done = () => {
        cleanup();
        resolve({
          ...this.get(id),
          observation: e.snapshot.terminal ? 'terminal' : 'timed_out',
        });
      };
      const detach = () => {
        cleanup();
        reject(new RequestError('detached', 'Observer detached'));
      };
      const timer = setTimeout(done, timeout);
      e.observers.add(done);
      signal?.addEventListener('abort', detach, { once: true });
      if (signal?.aborted) detach();
    });
  }
  list(options: { state?: string; limit?: number; cursor?: string } = {}) {
    this.sweep();
    const { state = 'pending', limit = 50, cursor } = options;
    if (!['pending', 'terminal', 'all'].includes(state) || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new RequestError('invalid_input', 'Invalid list state or limit');
    let offset = 0;
    if (cursor) {
      try {
        const c = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (c.instance !== this.instance || c.state !== state || !Number.isInteger(c.offset) || c.offset < 0) throw Error();
        offset = c.offset;
      } catch {
        throw new RequestError('invalid_input', 'Invalid list cursor');
      }
    }
    const rows = [...this.records.values()].filter((e) => e.admitted && (state === 'all' || e.snapshot.terminal === (state === 'terminal')));
    return {
      schema_version: 1,
      instance_id: this.instance,
      requests: rows.slice(offset, offset + limit).map(({ snapshot }) => {
        const { result: _result, ...summary } = snapshot;
        return structuredClone(summary);
      }),
      ...(offset + limit < rows.length
        ? {
            cursor: Buffer.from(
              JSON.stringify({
                instance: this.instance,
                state,
                offset: offset + limit,
              }),
            ).toString('base64url'),
          }
        : {}),
    };
  }
  update(id: string, presentation: { state: RequestState; until?: number }): void {
    const e = this.records.get(id);
    if (e && !e.snapshot.terminal && canonical(e.snapshot.presentation) !== canonical(presentation))
      Object.assign(e.snapshot, {
        state: presentation.state,
        presentation,
        updated_at: iso(this.now()),
      });
  }
  private armExpiry(e: RecordEntry): ReturnType<typeof setTimeout> {
    const timer = setTimeout(
      () => {
        if (!e.snapshot.terminal && !e.winning) {
          e.winning = 'expired';
          e.ac.abort('request_expired');
        }
      },
      Math.max(0, Date.parse(e.snapshot.hard_expires_at) - this.now()),
    );
    timer.unref?.();
    return timer;
  }
  private finish(e: RecordEntry, state: RequestState, result: unknown): void {
    if (e.snapshot.terminal) return;
    clearTimeout(e.timer);
    if (Buffer.byteLength(JSON.stringify(result)) > this.limits.result) {
      state = 'failed';
      result = { answered: false, reason: 'result_too_large' };
    }
    Object.assign(e.snapshot, {
      state,
      terminal: true,
      result: structuredClone(result),
      updated_at: iso(this.now()),
      retained_until: iso(this.now() + this.limits.lifetime),
    });
    this.completed?.(structuredClone(e.snapshot));
    for (const cb of [...e.observers]) cb();
  }
  private sweep(): void {
    for (const [id, e] of this.records) if (e.snapshot.terminal && Date.parse(e.snapshot.retained_until!) <= this.now()) this.records.delete(id);
  }
}
