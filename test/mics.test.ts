import { describe, expect, it } from 'vitest';
import { listMics, type MicDevice, MicSelector, micKey, micName } from '../src/core/mics';

const BOYA: MicDevice = { deviceId: 'b1', label: 'Microphone (BOYA mini 2) (2e8a:00f2)' };
const ARRAY: MicDevice = { deviceId: 'a1', label: 'Microphone Array (AMD Audio Device)' };
const HEADSET: MicDevice = { deviceId: 'h1', label: 'Headset Microphone (WH-1000XM5)' };

function selector(order: string[], available: MicDevice[]) {
  const s = new MicSelector(order);
  s.update(available);
  return s;
}

describe('names and identity', () => {
  it('shortens labels for toasts', () => {
    expect(micName(BOYA.label)).toBe('BOYA mini 2');
    expect(micName(ARRAY.label)).toBe('Microphone Array');
    expect(micName(HEADSET.label)).toBe('WH-1000XM5');
    expect(micName('Default - Microphone (BOYA mini 2) (2e8a:00f2)')).toBe('BOYA mini 2');
  });

  it('matches a device across Chromium alias prefixes and case', () => {
    expect(micKey('Default - Microphone (BOYA mini 2)')).toBe(micKey('microphone (boya mini 2)'));
  });

  it('drops the default and communications aliases', () => {
    const list = listMics([
      { kind: 'audioinput', deviceId: 'default', label: 'Default - X' },
      { kind: 'audioinput', deviceId: 'communications', label: 'Communications - X' },
      { kind: 'audioinput', deviceId: 'x', label: 'X' },
      { kind: 'audiooutput', deviceId: 'y', label: 'Speakers' },
    ]);
    expect(list.map((d) => d.label)).toEqual(['X']);
  });
});

describe('MicSelector', () => {
  it('uses the top connected preference, else the system default', () => {
    expect(selector([BOYA.label, ARRAY.label], [ARRAY, BOYA]).current).toEqual(BOYA);
    expect(selector([BOYA.label], [ARRAY]).current).toBeNull();
  });

  it('falls back to the next preference when the preferred mic disconnects', () => {
    const s = selector([BOYA.label, ARRAY.label], [ARRAY, BOYA]);
    const u = s.update([ARRAY]);
    expect(u.active).toEqual(ARRAY);
    expect(u.event).toEqual({ kind: 'disconnected', from: BOYA.label, to: ARRAY.label });
  });

  it('falls back to the system default when no preference is left', () => {
    const s = selector([BOYA.label], [BOYA, ARRAY]);
    expect(s.update([ARRAY]).event).toEqual({ kind: 'disconnected', from: BOYA.label, to: null });
  });

  it('switches back, undoably, when a higher preference reconnects', () => {
    const s = selector([BOYA.label, ARRAY.label], [ARRAY]);
    expect(s.current).toEqual(ARRAY);
    const u = s.update([ARRAY, BOYA]);
    expect(u.active).toEqual(BOYA);
    expect(u.event).toEqual({ kind: 'switched', from: ARRAY.label, to: BOYA.label, undoable: true });
  });

  it('undo returns to the previous mic and stays there for this connection', () => {
    const s = selector([BOYA.label, ARRAY.label], [ARRAY]);
    s.update([ARRAY, BOYA]);
    expect(s.undo()).toEqual(ARRAY);
    // more device churn while BOYA stays plugged in: no flip-flop
    expect(s.update([ARRAY, BOYA, HEADSET]).event).toBeUndefined();
    expect(s.current).toEqual(ARRAY);
    // unplug and replug BOYA: a new connection, so it switches again
    s.update([ARRAY, HEADSET]);
    expect(s.update([ARRAY, HEADSET, BOYA]).active).toEqual(BOYA);
  });

  it('ignores an unknown new device', () => {
    const s = selector([ARRAY.label], [ARRAY]);
    const u = s.update([ARRAY, HEADSET]);
    expect(u.active).toEqual(ARRAY);
    expect(u.event).toBeUndefined();
  });

  it('picks the best of two mics that reconnect at once, with one event', () => {
    const s = selector([BOYA.label, HEADSET.label, ARRAY.label], [ARRAY]);
    const u = s.update([ARRAY, HEADSET, BOYA]);
    expect(u.active).toEqual(BOYA);
    expect(u.event).toEqual({ kind: 'switched', from: ARRAY.label, to: BOYA.label, undoable: true });
  });

  it('does not switch up mid-recording, but does once the recording ends', () => {
    const s = selector([BOYA.label, ARRAY.label], [ARRAY]);
    const u = s.update([ARRAY, BOYA], true);
    expect(u.active).toEqual(ARRAY);
    expect(u.event).toBeUndefined();
    expect(s.recordingEnded().event).toEqual({ kind: 'switched', from: ARRAY.label, to: BOYA.label, undoable: true });
  });

  it('replaces a mic that disconnects mid-recording at once', () => {
    const s = selector([BOYA.label, ARRAY.label], [ARRAY, BOYA]);
    expect(s.update([ARRAY], true).event?.kind).toBe('disconnected');
  });

  it('follows a re-issued deviceId for the same device', () => {
    const s = selector([BOYA.label], [BOYA]);
    const u = s.update([{ ...BOYA, deviceId: 'b2' }]);
    expect(u.active?.deviceId).toBe('b2');
    expect(u.event).toBeUndefined();
  });

  it('picking a mic makes it the top preference', () => {
    const order = [BOYA.label, ARRAY.label];
    const s = selector(order, [ARRAY, BOYA, HEADSET]);
    s.pick(HEADSET);
    expect(order).toEqual([HEADSET.label, BOYA.label, ARRAY.label]);
    expect(s.current).toEqual(HEADSET);
    s.pick(ARRAY);
    expect(order).toEqual([ARRAY.label, HEADSET.label, BOYA.label]);
  });

  it('picking the system default does not snap straight back to a preference', () => {
    const s = selector([BOYA.label], [BOYA, ARRAY]);
    s.pick(null);
    expect(s.update([BOYA, ARRAY]).active).toBeNull();
  });
});
