import { describe, expect, it } from 'vitest';
import { type CapturePath, CaptureRouter } from '../src/main/capture';

function path(name: string, calls: string[]): CapturePath {
  return {
    start: (id, d, g) => calls.push(`${name}.start ${id} ${d} ${g.db}`),
    stop: (id) => calls.push(`${name}.stop ${id}`),
    cancel: (id) => calls.push(`${name}.cancel ${id}`),
    switchDevice: (id, d) => calls.push(`${name}.switch ${id} ${d}`),
  };
}

describe('CaptureRouter', () => {
  it('uses native capture when it is available, for the whole recording', () => {
    const calls: string[] = [];
    const r = new CaptureRouter(() => path('native', calls), path('browser', calls), () => undefined);
    r.start(1, 'boya', { auto: false, db: 0 });
    r.switchDevice(1, null, { auto: false, db: 30 });
    r.stop(1);
    expect(calls).toEqual(['native.start 1 boya 0', 'native.switch 1 null', 'native.stop 1']);
  });

  it('falls back to the browser path, with the same mic, when native cannot open it', () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const r = new CaptureRouter(() => path('native', calls), path('browser', calls), (_l, m) => logs.push(m));
    r.start(2, 'boya', { auto: false, db: 6 });
    expect(r.nativeFailed(2, 'no mic named "BOYA"')).toBe(true);
    r.stop(2);
    expect(calls).toEqual(['native.start 2 boya 6', 'browser.start 2 boya 6', 'browser.stop 2']);
    expect(logs[0]).toMatch(/native capture failed .*browser path/);
  });

  it('a mic switch before the fallback is the mic the browser path opens', () => {
    const calls: string[] = [];
    const r = new CaptureRouter(() => path('native', calls), path('browser', calls), () => undefined);
    r.start(3, 'boya', { auto: false, db: 0 });
    r.switchDevice(3, 'amd', { auto: false, db: 30 });
    r.nativeFailed(3, 'gone');
    expect(calls.at(-1)).toBe('browser.start 3 amd 30');
  });

  it('uses the browser path when native capture is unavailable, and ignores late native failures', () => {
    const calls: string[] = [];
    const r = new CaptureRouter(() => null, path('browser', calls), () => undefined);
    r.start(4, null, { auto: false, db: 0 });
    expect(r.nativeFailed(4, 'x')).toBe(false);
    r.cancel(4);
    expect(calls).toEqual(['browser.start 4 null 0', 'browser.cancel 4']);
  });
});
