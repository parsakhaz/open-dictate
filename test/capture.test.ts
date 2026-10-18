import { describe, expect, it } from 'vitest';
import { type CaptureBackend, CaptureController, type CaptureEvents, type MicStream, type SttMsg, type WorkletMsg } from '../src/core/capture';
import { CHUNK, Chunker, type ChunkerOut } from '../src/core/chunker';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

class FakeStream implements MicStream {
  stopped = false;
  private ended: (() => void)[] = [];
  constructor(readonly label: string) {}
  stop() {
    this.stopped = true;
  }
  onEnded(cb: () => void) {
    this.ended.push(cb);
  }
  end() {
    for (const cb of this.ended) cb();
  }
}

/** A worklet stand-in wired to a real Chunker, plus a log of what reached the recognizer. */
function harness(opts: { openDelay?: number; failOpen?: (deviceId: string | null) => boolean } = {}) {
  const stt: string[] = [];
  const frames: { id: number; first: number }[] = [];
  const streams: FakeStream[] = [];
  const events: string[] = [];
  let suspended = true;
  let ctrl!: CaptureController;
  const chunker = new Chunker((m: ChunkerOut) => queueMicrotask(() => ctrl.onWorklet(m)));
  const backend: CaptureBackend = {
    prepare: async () => undefined,
    open: async (deviceId) => {
      await tick(opts.openDelay ?? 0);
      if (opts.failOpen?.(deviceId)) throw new Error(`cannot open ${deviceId ?? 'default'}`);
      const s = new FakeStream(deviceId ?? 'default');
      streams.push(s);
      return s;
    },
    connect: () => undefined,
    disconnect: () => undefined,
    resume: async () => {
      suspended = false;
    },
    suspend: async () => {
      suspended = true;
    },
    worklet: (m: WorkletMsg) => {
      if (m.type === 'session') chunker.session(m.sid, m.gainDb);
      else if (m.type === 'gain') chunker.setGain(m.db);
      else if (m.type === 'flush') chunker.flush(m.sid);
      else chunker.reset();
    },
    stt: (m: SttMsg) => {
      if (m.type === 'frame') frames.push({ id: m.id, first: m.samples[0] });
      else stt.push(`${m.type}:${m.id}`);
    },
  };
  const ev: CaptureEvents = {
    started: (id) => events.push(`started:${id}`),
    error: (id, msg) => events.push(`error:${id}:${msg}`),
    lost: (id) => events.push(`lost:${id}`),
    failed: (id) => events.push(`failed:${id}`),
    silent: () => undefined,
    level: () => undefined,
  };
  ctrl = new CaptureController(backend, ev);
  /** Pushes `n` samples of value `v` through the worklet, as the audio thread would. */
  const audio = (v: number, n: number) => chunker.push(new Float32Array(n).fill(v));
  return { ctrl, stt, frames, streams, events, audio, isSuspended: () => suspended };
}

describe('CaptureController', () => {
  it('runs a recording: begin, frames, flushed tail, end, mic closed', async () => {
    const h = harness();
    await h.ctrl.start(1, 'boya', 0);
    h.audio(0.1, CHUNK + 100);
    await h.ctrl.stop(1);
    expect(h.stt).toEqual(['begin:1', 'end:1']);
    expect(h.frames.map((f) => f.id)).toEqual([1, 1]);
    expect(h.streams[0].stopped).toBe(true);
    expect(h.isSuspended()).toBe(true);
  });

  it('never lets a new recording overlap the flush of the previous one (M1)', async () => {
    const h = harness();
    await h.ctrl.start(1, null, 0);
    h.audio(0.1, 800);
    const stopping = h.ctrl.stop(1);
    const starting = h.ctrl.start(2, null, 0);
    await Promise.all([stopping, starting]);
    h.audio(0.2, CHUNK);
    await tick();
    expect(h.stt).toEqual(['begin:1', 'end:1', 'begin:2']);
    // recording 1 kept its tail; recording 2 is live with an open mic
    expect(h.frames).toEqual([
      { id: 1, first: expect.closeTo(0.1, 5) },
      { id: 2, first: expect.closeTo(0.2, 5) },
    ]);
    expect(h.ctrl.current).toBe(2);
    expect(h.streams[1].stopped).toBe(false);
    expect(h.isSuspended()).toBe(false);
    await h.ctrl.stop(2);
    expect(h.stt).toEqual(['begin:1', 'end:1', 'begin:2', 'end:2']);
    expect(h.streams[1].stopped).toBe(true);
  });

  it('ends a recording whose mic was still opening when the key came up', async () => {
    const h = harness({ openDelay: 30 });
    const a = h.ctrl.start(1, null, 0);
    const b = h.ctrl.stop(1);
    await Promise.all([a, b]);
    expect(h.stt).toEqual(['begin:1', 'end:1']);
    expect(h.streams[0].stopped).toBe(true);
    expect(h.ctrl.current).toBeNull();
  });

  it('drops the buffered audio of a cancelled recording (M2)', async () => {
    const h = harness();
    await h.ctrl.start(1, null, 0);
    h.audio(0.9, 128); // less than a chunk: still in the worklet
    await h.ctrl.cancel(1);
    await h.ctrl.start(2, null, 0);
    h.audio(0.2, CHUNK);
    await h.ctrl.stop(2);
    expect(h.stt).toEqual(['begin:1', 'cancel:1', 'begin:2', 'end:2']);
    expect(h.frames).toEqual([{ id: 2, first: expect.closeTo(0.2, 5) }]);
  });

  it('moves to the default mic when the active one ends, even the system default (M4)', async () => {
    const h = harness();
    await h.ctrl.start(1, null, 0);
    h.streams[0].end();
    await h.ctrl.stop(1).then(() => undefined);
    expect(h.events).toEqual(['started:1', 'lost:1']);
    expect(h.streams).toHaveLength(2);
    expect(h.streams[1].label).toBe('default');
  });

  it('keeps recording on the new mic after it moved', async () => {
    const h = harness();
    await h.ctrl.start(1, 'boya', 0);
    h.audio(0.1, CHUNK);
    h.streams[0].end();
    await h.ctrl.switchDevice(1, null, 0); // a queued op: runs after the reopen
    h.audio(0.3, CHUNK);
    await h.ctrl.stop(1);
    expect(h.frames.map((f) => f.id)).toEqual([1, 1]);
    expect(h.stt).toEqual(['begin:1', 'end:1']);
  });

  it('reports a failure when no mic can be reopened, so main can finish with what was heard', async () => {
    let fail = false;
    const h = harness({ failOpen: () => fail });
    await h.ctrl.start(1, null, 0);
    fail = true;
    h.streams[0].end();
    await h.ctrl.stop(1);
    expect(h.events).toEqual(['started:1', 'lost:1', 'failed:1']);
    expect(h.stt).toEqual(['begin:1', 'end:1']);
  });

  it('falls back to the default mic when the chosen one cannot be opened', async () => {
    const h = harness({ failOpen: (id) => id === 'boya' });
    await h.ctrl.start(1, 'boya', 0);
    expect(h.streams[0].label).toBe('default');
    expect(h.events).toEqual(['started:1']);
  });

  it('cancels the recognizer stream when no mic opens at all', async () => {
    const h = harness({ failOpen: () => true });
    await h.ctrl.start(1, null, 0);
    expect(h.stt).toEqual(['begin:1', 'cancel:1']);
    expect(h.events[0]).toMatch(/^error:1/);
    await h.ctrl.stop(1);
    expect(h.stt).toEqual(['begin:1', 'cancel:1', 'end:1']);
  });
});

describe('Chunker', () => {
  it('tags chunks with their session and drops a partial chunk on a new session', () => {
    const out: ChunkerOut[] = [];
    const c = new Chunker((m) => out.push(m));
    c.session(1, 0);
    c.push(new Float32Array(100).fill(0.5));
    c.session(2, 0);
    c.push(new Float32Array(CHUNK).fill(0.25));
    const chunks = out.filter((m) => m.type === 'chunk');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ sid: 2 });
    expect((chunks[0] as { samples: Float32Array }).samples[0]).toBeCloseTo(0.25, 6);
  });

  it('ignores audio outside a session and flushes only the current one', () => {
    const out: ChunkerOut[] = [];
    const c = new Chunker((m) => out.push(m));
    c.push(new Float32Array(CHUNK));
    c.session(3, 0);
    c.push(new Float32Array(10));
    c.flush(2);
    c.flush(3);
    expect(out.map((m) => `${m.type}:${m.sid}`)).toEqual(['flushed:2', 'chunk:3', 'flushed:3']);
  });
});
