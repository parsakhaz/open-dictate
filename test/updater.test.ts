import { describe, expect, it } from 'vitest';
import type { Busy } from '../src/core/updates';
import { type UpdateEngine, Updater, type UpdaterDeps } from '../src/main/updater';

const MIN = 60_000;

/** Timers that run only when the test advances the clock. */
function clock() {
  let now = 0;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let next = 1;
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (id: unknown) => {
      timers = timers.filter((t) => t.id !== id);
    },
    pending: () => timers.length,
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = due.at;
        due.fn();
        await new Promise((r) => setTimeout(r, 0));
      }
      now = end;
    },
  };
}

function fakeEngine() {
  const handlers: Record<string, (...a: never[]) => void> = {};
  const e = {
    checks: 0,
    installs: 0,
    next: null as null | (() => void),
    async check() {
      e.checks++;
      e.next?.();
    },
    install() {
      e.installs++;
    },
    on(event: string, cb: (...a: never[]) => void) {
      handlers[event] = cb;
    },
    emit(event: string, ...args: unknown[]) {
      (handlers[event] as (...a: unknown[]) => void)(...args);
    },
  };
  return e;
}

function setup(over: Partial<UpdaterDeps> = {}) {
  const c = clock();
  const engine = fakeEngine();
  const busy: Busy = { recording: false, cleaning: false, downloading: false };
  let lastActivity = 0;
  let enabled = true;
  const u = new Updater({
    mode: 'install',
    currentVersion: '0.2.0',
    enabled: () => enabled,
    busy: () => busy,
    lastActivityAt: () => lastActivity,
    log: () => undefined,
    engine: engine as unknown as UpdateEngine,
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    ...over,
  });
  return { u, c, engine, busy, setActivity: (t: number) => (lastActivity = t), setEnabled: (v: boolean) => (enabled = v) };
}

describe('Updater', () => {
  it('checks a minute after start, then daily', async () => {
    const { u, c, engine } = setup();
    u.start();
    await c.advance(MIN - 1);
    expect(engine.checks).toBe(0);
    await c.advance(1);
    expect(engine.checks).toBe(1);
    expect(u.state.status).toBe('up-to-date');
    await c.advance(24 * 60 * MIN);
    expect(engine.checks).toBe(2);
  });

  it('downloads a new version and installs it after 10 idle minutes', async () => {
    const { u, c, engine, setActivity } = setup();
    engine.next = () => {
      engine.emit('available', '0.2.1');
      engine.emit('downloaded', '0.2.1');
    };
    setActivity(0);
    await u.check();
    expect(u.state).toMatchObject({ status: 'ready', version: '0.2.1' });
    await c.advance(10 * MIN - 1);
    expect(engine.installs).toBe(0);
    await c.advance(1);
    expect(engine.installs).toBe(1);
  });

  it('never installs during a recording; the idle clock restarts when it ends', async () => {
    const { u, c, engine, busy, setActivity } = setup();
    engine.next = () => engine.emit('downloaded', '0.2.1');
    busy.recording = true;
    await u.check();
    await c.advance(60 * MIN);
    expect(engine.installs).toBe(0);
    busy.recording = false;
    setActivity(c.now());
    u.activity();
    await c.advance(10 * MIN);
    expect(engine.installs).toBe(1);
  });

  it('waits again when a dictation started after the install timer was armed', async () => {
    const { u, c, engine, setActivity } = setup();
    engine.next = () => engine.emit('downloaded', '0.2.1');
    await u.check();
    await c.advance(8 * MIN);
    setActivity(c.now());
    await c.advance(2 * MIN);
    expect(engine.installs).toBe(0);
    await c.advance(8 * MIN);
    expect(engine.installs).toBe(1);
  });

  it('turned off: no checks and no install; turned on again: checks', async () => {
    const { u, c, engine, setEnabled } = setup();
    setEnabled(false);
    u.setEnabled(false);
    u.start();
    await c.advance(48 * 60 * MIN);
    expect(engine.checks).toBe(0);
    expect(u.state.status).toBe('disabled');
    setEnabled(true);
    u.setEnabled(true);
    await c.advance(MIN);
    expect(engine.checks).toBe(1);
  });

  it('on a build that cannot install itself, says a newer release is out with its page', async () => {
    const { u } = setup({ mode: 'notify', engine: undefined, latestRelease: async () => ({ tag: 'dictate-v0.3.0', url: 'https://github.com/parsakhaz/open-dictate/releases/tag/dictate-v0.3.0' }) });
    await u.check();
    expect(u.state).toMatchObject({ status: 'available', version: '0.3.0', url: 'https://github.com/parsakhaz/open-dictate/releases/tag/dictate-v0.3.0' });
  });

  it('reports up to date when the latest release is not newer, and an error without throwing', async () => {
    const same = setup({ mode: 'notify', engine: undefined, latestRelease: async () => ({ tag: 'dictate-v0.2.0', url: 'x' }) });
    await same.u.check();
    expect(same.u.state.status).toBe('up-to-date');
    const offline = setup({ mode: 'notify', engine: undefined, latestRelease: async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); } });
    await offline.u.check();
    expect(offline.u.state).toMatchObject({ status: 'error', message: 'getaddrinfo ENOTFOUND api.github.com' });
  });

  it('does nothing in a development build', async () => {
    const { u, c, engine } = setup({ mode: 'off' });
    u.start();
    await c.advance(48 * 60 * MIN);
    await u.check();
    expect([engine.checks, u.state.status]).toEqual([0, 'off']);
  });
});
