import { expect, it, vi } from 'vitest';
import { REQUEST_LIMITS, RequestBook } from '../src/core/requests';

it('accepts once, detaches observers and retains complete immutable results', async () => {
  const book = new RequestBook();
  const start = vi.fn(async (owner: { accepted(card: string): void }) => {
    owner.accepted('k1');
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  let finish!: (result: unknown) => void;
  const input = {
    kind: 'ask' as const,
    args: { question: 'Deploy?' },
    cwd: 'C:/work',
    instance: book.instance,
    retry_key: 'one',
  };
  const receipt = await book.create(input, start);
  expect(receipt).toMatchObject({
    terminal: false,
    card_id: 'k1',
    lifetime: 'app',
    terminal_retention_ms: REQUEST_LIMITS.lifetime,
    retry_retention: 'app_instance',
  });
  expect(Date.parse(receipt.hard_expires_at) - Date.parse(receipt.created_at)).toBe(REQUEST_LIMITS.lifetime);
  expect(await book.create(input, start)).toEqual(receipt);
  expect(start).toHaveBeenCalledTimes(1);
  const observer = new AbortController();
  const wait = book.wait(receipt.request_id, 45_000, observer.signal);
  observer.abort();
  await expect(wait).rejects.toThrow('detached');
  finish({
    answered: true,
    text: 'Yes',
    raw: 'yes please',
    choice: 'Yes',
    card_id: 'k1',
  });
  await vi.waitFor(() => expect(book.get(receipt.request_id).terminal).toBe(true));
  expect(book.get(receipt.request_id).result).toEqual({
    answered: true,
    text: 'Yes',
    raw: 'yes please',
    choice: 'Yes',
    card_id: 'k1',
  });
  expect(await book.cancel(receipt.request_id)).toMatchObject({
    state: 'answered',
    cancelled_now: false,
  });
  expect(book.list({ state: 'all' }).requests[0]).not.toHaveProperty('result');
});

it('shares preparation failures and releases the key so a corrected preparation can be accepted', async () => {
  const book = new RequestBook();
  const input = {
    kind: 'ask' as const,
    args: {},
    cwd: '',
    retry_key: 'retry',
    instance: book.instance,
  };
  let fail!: (error: Error) => void;
  const start = vi.fn(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  const attempts = [book.create(input, start), book.create(input, start)];
  const results = Promise.allSettled(attempts);
  await Promise.resolve();
  fail(new Error('missing asset'));
  expect((await results).map((r) => r.status)).toEqual(['rejected', 'rejected']);
  expect(start).toHaveBeenCalledTimes(1);
  expect(book.list({ state: 'all' }).requests).toEqual([]);
  expect(await book.create(input, async () => ({ answered: false, reason: 'dnd' }))).toMatchObject({ state: 'failed', terminal: true });
});

it('reserves a concurrent retry before preparation and rejects changed context or stale instance', async () => {
  const book = new RequestBook();
  let release!: () => void;
  const start = vi.fn(async (owner) => {
    await new Promise<void>((r) => {
      release = r;
    });
    owner.accepted('one');
    return { answered: true, text: 'yes' };
  });
  const input = {
    kind: 'ask' as const,
    args: { question: 'Go?' },
    cwd: 'one',
    retry_key: 'k',
    instance: book.instance,
  };
  const a = book.create(input, start);
  const b = book.create(input, start);
  await Promise.resolve();
  expect(start).toHaveBeenCalledTimes(1);
  release();
  expect((await a).request_id).toBe((await b).request_id);
  await expect(book.create({ ...input, cwd: 'two' }, start)).rejects.toMatchObject({ code: 'retry_conflict' });
  await expect(book.create({ ...input, instance: 'old' }, start)).rejects.toMatchObject({ code: 'instance_changed' });
  expect(() => book.get('old.id')).toThrow(/another app instance/);
});

it('keeps retry tombstones after result expiry and rejects admission instead of evicting', async () => {
  let now = 0;
  const book = new RequestBook(() => now, { ...REQUEST_LIMITS, records: 1 });
  const input = {
    kind: 'ask' as const,
    args: {},
    cwd: '',
    retry_key: 'k',
    instance: book.instance,
  };
  const r = await book.create(input, async () => ({
    answered: true,
    text: 'yes',
  }));
  await expect(book.create({ ...input, retry_key: 'two' }, async () => ({}))).rejects.toMatchObject({ code: 'capacity_exceeded' });
  expect(book.get(r.request_id).result).toEqual({
    answered: true,
    text: 'yes',
  });
  now += REQUEST_LIMITS.lifetime + 1;
  await expect(book.create(input, async () => ({}))).rejects.toMatchObject({
    code: 'result_expired',
    details: { request_id: r.request_id },
  });
});

it('answer wins over cancel even before the final enriched return microtask', async () => {
  const book = new RequestBook();
  let owner!: Parameters<Parameters<RequestBook['create']>[1]>[0];
  let finish!: (x: unknown) => void;
  const r = await book.create({ kind: 'approve', args: {}, cwd: '' }, async (o) => {
    owner = o;
    o.accepted('card');
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  owner.ending('answered');
  const cancel = book.cancel(r.request_id);
  finish({ approved: true, card_id: 'card', raw: 'yes' });
  expect(await cancel).toMatchObject({
    cancelled_now: false,
    state: 'answered',
    result: { approved: true, raw: 'yes' },
  });
});
