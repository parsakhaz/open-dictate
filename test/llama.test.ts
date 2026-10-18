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

function server(warmupStatus: number) {
  const procs: FakeProc[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).endsWith('/health')) return new Response('{}', { status: 200 });
      return new Response(warmupStatus === 200 ? JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) : 'boom', { status: warmupStatus });
    }),
  );
  const s = new LlamaServer('gemma', {
    exe: 'llama-server.exe',
    gguf: 'm.gguf',
    log: () => undefined,
    warmup: () => ({ messages: [] }),
    spawn: (() => {
      const p = new FakeProc();
      procs.push(p);
      return p;
    }) as never,
  });
  return { s, procs };
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
});
