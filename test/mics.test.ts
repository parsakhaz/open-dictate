import { describe, expect, it } from 'vitest';
import { deviceLabelFor, listMics, type MicDevice, MicSelector, micKey, micName, parseMicPrefs } from '../src/core/mics';

const BOYA: MicDevice = { deviceId: 'b1', label: 'Microphone (BOYA mini 2) (2e8a:00f2)' };
const ARRAY: MicDevice = { deviceId: 'a1', label: 'Microphone Array (AMD Audio Device)' };

describe('deviceLabelFor', () => {
  it('finds the browser label for the name native capture opened, which lacks the USB id', () => {
    expect(deviceLabelFor('Microphone (BOYA mini 2)', [ARRAY, BOYA])).toBe(BOYA.label);
    expect(micKey(deviceLabelFor('Microphone (BOYA mini 2)', [ARRAY, BOYA]))).toBe(micKey(BOYA.label));
    expect(deviceLabelFor(ARRAY.label, [ARRAY, BOYA])).toBe(ARRAY.label);
  });

  it('keeps a name no listed device has', () => {
    expect(deviceLabelFor('fake mic', [ARRAY])).toBe('fake mic');
  });
});
const HEADSET: MicDevice = { deviceId: 'h1', label: 'Headset Microphone (WH-1000XM5)' };

function selector(labels: string[], available: MicDevice[]) {
  const s = new MicSelector(labels.map((label) => ({ label })));
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
    const s = selector([BOYA.label, ARRAY.label], [ARRAY, BOYA, HEADSET]);
    s.pick(HEADSET);
    expect(s.order.map((p) => p.label)).toEqual([HEADSET.label, BOYA.label, ARRAY.label]);
    expect(s.current).toEqual(HEADSET);
    s.pick(ARRAY);
    expect(s.order.map((p) => p.label)).toEqual([ARRAY.label, HEADSET.label, BOYA.label]);
  });

  it('tells two identical mics apart by groupId (S5)', () => {
    const A: MicDevice = { deviceId: 'a', label: 'Microphone (USB Audio)', groupId: 'g1' };
    const B: MicDevice = { deviceId: 'b', label: 'Microphone (USB Audio)', groupId: 'g2' };
    const s = new MicSelector([]);
    s.update([A, B]);
    s.pick(B);
    expect(s.order).toEqual([{ label: B.label, groupId: 'g2' }]);
    // re-enumeration keeps B, not the first label match
    expect(s.update([{ ...A, deviceId: 'a2' }, { ...B, deviceId: 'b2' }]).active?.groupId).toBe('g2');
    // unplugging B is noticed even though a mic with the same label remains
    const u = s.update([A]);
    expect(u.event).toEqual({ kind: 'disconnected', from: B.label, to: null });
    // and B coming back switches back to B, not A
    expect(s.update([A, B]).active?.groupId).toBe('g2');
  });

  it('keeps a saved mic after a restart, when Chromium has issued it a new groupId (R2)', () => {
    // run 1: pick BOYA; its groupId is saved
    const run1 = new MicSelector([]);
    run1.update([ARRAY, { ...BOYA, groupId: 'old' }]);
    run1.pick({ ...BOYA, groupId: 'old' });
    const saved = JSON.parse(JSON.stringify(run1.order));
    // run 2: same devices, new groupIds
    const run2 = new MicSelector(saved);
    const u = run2.update([{ ...ARRAY, groupId: 'x' }, { ...BOYA, deviceId: 'b9', groupId: 'new' }]);
    expect(u.active?.deviceId).toBe('b9');
    // the saved preference adopts the new groupId, so it is exact again from now on
    expect(run2.prefsChanged).toBe(true);
    expect(run2.order).toEqual([{ label: BOYA.label, groupId: 'new' }]);
    // and unplugging it is still noticed
    expect(run2.update([{ ...ARRAY, groupId: 'x' }]).event?.kind).toBe('disconnected');
  });

  it('reads old label-only preferences and upgrades them when picked', () => {
    expect(parseMicPrefs(['Microphone (X)', { label: 'Y', groupId: 'g' }, 3, null])).toEqual([{ label: 'Microphone (X)' }, { label: 'Y', groupId: 'g' }]);
    const s = new MicSelector([{ label: BOYA.label }]);
    s.update([{ ...BOYA, groupId: 'gb' }]);
    expect(s.current?.deviceId).toBe('b1');
    s.pick({ ...BOYA, groupId: 'gb' });
    expect(s.order).toEqual([{ label: BOYA.label, groupId: 'gb' }]);
  });

  it('picking the system default does not snap straight back to a preference', () => {
    const s = selector([BOYA.label], [BOYA, ARRAY]);
    s.pick(null);
    expect(s.update([BOYA, ARRAY]).active).toBeNull();
  });
});
