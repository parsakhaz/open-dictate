import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlamaServer } from '../src/engine/llama';

class FakeProc extends EventEmitter {
  exitCode: number | null = null;
  killed = false;
  pid = Math.floor(Math.random() * 1e6);
  stderr = new EventEmitter();
  kill() {
    this.killed = true;
    this.exitCode = 1;
    queueMicrotask(() => this.emit('exit', 1));
    return true;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function server(warmupStatus: number, freePort?: () => Promise<number>) {
  const procs: FakeProc[] = [];
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(String(url));
      if (String(url).endsWith('/health')) return new Response('{}', { status: 200 });
      return new Response(warmupStatus === 200 ? JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) : 'boom', { status: warmupStatus });
    }),
  );
  const s = new LlamaServer('gemma', {
    exe: 'llama-server.exe',
    gguf: 'm.gguf',
    log: () => undefined,
    warmup: () => ({ messages: [] }),
    ...(freePort ? { freePort } : {}),
    spawn: (() => {
      const p = new FakeProc();
      procs.push(p);
      return p;
    }) as never,
  });
  return { s, procs, urls };
}

describe('LlamaServer', () => {
  it('kills the process of a launch whose warm-up fails, so retries never pile up (S4)', async () => {
    const { s, procs } = server(500);
    await expect(s.start()).rejects.toThrow(/HTTP 500/);
    expect(procs).toHaveLength(1);
    expect(procs[0].killed).toBe(true);
    expect(s.state).toBe('crashed');
    s.stop();
    expect(procs.every((p) => p.killed)).toBe(true);
  });

  it('becomes ready after a successful warm-up and stops cleanly', async () => {
    const { s, procs } = server(200);
    await s.start();
    expect(s.state).toBe('ready');
    expect(await s.complete({ messages: [] })).toBe('ok');
    s.stop();
    expect(procs[0].killed).toBe(true);
    expect(s.state).toBe('stopped');
  });

  it('a stop during start-up leaves no process behind', async () => {
    const { s, procs } = server(200);
    const p = s.start();
    s.stop();
    await expect(p).rejects.toThrow(/stopped/);
    expect(procs.every((x) => x.killed)).toBe(true);
  });

  it('ignores a stale launch whose port arrives after a newer launch is ready (R3)', async () => {
    let releaseFirst!: (p: number) => void;
    let calls = 0;
    const freePort = () => {
      calls++;
      if (calls === 1) return new Promise<number>((r) => (releaseFirst = r));
      return Promise.resolve(22002);
    };
    const { s, urls } = server(200, freePort);
    const a = s.start();
    s.stop();
    await s.start();
    expect(s.state).toBe('ready');
    releaseFirst(11001);
    await expect(a).rejects.toThrow(/stopped/);
    urls.length = 0;
    await s.complete({ messages: [] });
    expect(urls).toEqual(['http://127.0.0.1:22002/v1/chat/completions']);
  });

  it('a stop while the spawned server is still starting kills that process', async () => {
    const procs: FakeProc[] = [];
    let healthCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        healthCalls++;
        return new Response('loading', { status: 503 });
      }),
    );
    const s = new LlamaServer('gemma', {
      exe: 'x',
      gguf: 'm',
      log: () => undefined,
      freePort: async () => 1234,
      spawn: (() => {
        const p = new FakeProc();
        procs.push(p);
        return p;
      }) as never,
    });
    const p = s.start();
    while (healthCalls < 2) await new Promise((r) => setTimeout(r, 10));
    expect(procs).toHaveLength(1);
    s.stop();
    await expect(p).rejects.toThrow(/stopped/);
    expect(procs[0].killed).toBe(true);
  });
});
