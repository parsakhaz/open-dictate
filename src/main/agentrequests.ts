// Adapter from authenticated local-channel operations to app-owned feature calls.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentHub, HubSession } from '../core/agenthub';
import { object, validateRequest } from '../core/requestcontract';
import { REQUEST_LIMITS, RequestBook, RequestError, type RequestSnapshot } from '../core/requests';
import { RequestCrops } from './requestcrops';

export class AgentRequests {
  readonly book: RequestBook;
  readonly crops?: RequestCrops;
  private cards = new Map<string, string>();
  constructor(
    private hub: AgentHub,
    private app: {
      profile?: string;
      executable?: string;
      version?: string;
      build?: string;
    } = {},
  ) {
    if (app.profile) this.crops = new RequestCrops(path.join(app.profile, 'agents', 'cli-captures'));
    this.book = new RequestBook(Date.now, REQUEST_LIMITS, (snapshot) => {
      const crop = (snapshot.result as { crop?: unknown })?.crop;
      if (typeof crop === 'string') this.crops?.retain(crop, Date.parse(snapshot.retained_until!));
    });
  }
  async call(session: HubSession, operation: string, raw: unknown, signal: AbortSignal): Promise<unknown> {
    try {
      this.render();
      const a = object(raw);
      switch (operation) {
        case 'status':
          return {
            schema_version: 1,
            running: true,
            requests: 1,
            instance_id: this.book.instance,
            app: this.app,
            retention: 'app_lifetime_only',
            restart: 'App restarts lose all requests and results; stale-instance retries are rejected.',
          };
        case 'create': {
          const input = validateRequest(a, session.cwd);
          const receipt = await this.book.create(
            input,
            async (owner) =>
              this.hub.callOwned(
                {
                  ...session,
                  id: `cli:${randomUUID()}`,
                  ...(input.origin ? { origin: input.origin, pane: null } : {}),
                },
                input.kind,
                input.args,
                owner,
              ),
            signal,
          );
          if (receipt.card_id && !receipt.terminal) this.cards.set(receipt.card_id, receipt.request_id);
          return receipt;
        }
        case 'get':
          return this.assets(this.book.get(this.id(a)));
        case 'wait':
          return this.assets(await this.book.wait(this.id(a), a.timeout_ms === undefined ? 45_000 : (a.timeout_ms as number), signal));
        case 'cancel':
          return this.assets(await this.book.cancel(this.id(a)));
        case 'list':
          return this.book.list(a);
        default:
          throw new RequestError('invalid_input', 'Unknown request operation');
      }
    } catch (e) {
      if (e instanceof RequestError)
        return {
          schema_version: 1,
          error: { code: e.code, message: e.message, ...e.details },
        };
      return {
        schema_version: 1,
        error: {
          code: 'invalid_input',
          message: 'Request could not be prepared; check arguments and destination assets',
        },
      };
    }
  }
  render(): void {
    for (const [card, id] of this.cards) {
      const status = this.hub.queue.status(card, Date.now());
      try {
        if (this.book.get(id).terminal) this.cards.delete(card);
        else if (status && ['held', 'shown', 'snoozed'].includes(status.state))
          this.book.update(id, {
            state: status.state as 'held' | 'shown' | 'snoozed',
            ...(status.until ? { until: status.until } : {}),
          });
      } catch {
        this.cards.delete(card);
      }
    }
  }
  private id(a: Record<string, unknown>): string {
    if (typeof a.request_id !== 'string' || !a.request_id) throw new RequestError('invalid_input', 'request_id is required');
    return a.request_id;
  }
  private assets<T extends RequestSnapshot>(snapshot: T): T & { assets?: unknown } {
    const crop = (snapshot.result as { crop?: unknown })?.crop;
    if (typeof crop !== 'string') return snapshot;
    let available = false;
    try {
      available = fs.statSync(crop).isFile();
    } catch {
      /* the immutable result still describes the original answer */
    }
    return {
      ...snapshot,
      assets: {
        crop: {
          path: crop,
          available,
          retained_until: snapshot.retained_until,
          ...(available ? {} : { reason: 'asset_unavailable' }),
        },
      },
    };
  }
}
