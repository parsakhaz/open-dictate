import { describe, expect, it } from 'vitest';
import { WarmMic, type WarmSetting } from '../src/core/warm';

function setup(setting: WarmSetting = '30s', onAC = true) {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let seq = 0;
  const closes: string[] = [];
  const state = { setting, onAC };
  const w = new WarmMic({
    close: (why) => closes.push(why),
    setting: () => state.setting,
    onAC: () => state.onAC,
    timers: {
      set: (fn, ms) => {
        timers.set(++seq, { at: now + ms, fn });
        return seq;
      },
      clear: (h) => timers.delete(h as number),
    },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= now) {
        timers.delete(id);
        t.fn();
      }
    }
  };
  return { w, closes, advance, state, timers };
}

describe('WarmMic', () => {
  it('Off (the default): closes the mic as soon as a dictation ends', () => {
    const { w, closes } = setup('off');
    w.started();
    expect(w.ended()).toBe(false);
    expect(closes).toEqual(['off']);
  });

  it('30 s: keeps it open after a dictation, and a follow-up within 30 s reuses it', () => {
    const { w, closes, advance } = setup('30s');
    w.started();
    expect(w.ended()).toBe(true);
    advance(20_000);
    expect(closes).toEqual([]);
    w.started(); // the follow-up: nothing to reopen, and the timer is cancelled
    advance(20_000);
    expect(closes).toEqual([]);
    w.ended();
    advance(29_999);
    expect(closes).toEqual([]);
    advance(1);
    expect(closes).toEqual(['expired']);
  });

  it('closes at once on lock or sleep during the warm period', () => {
    for (const why of ['lock', 'sleep'] as const) {
      const { w, closes, advance } = setup('30s');
      w.started();
      w.ended();
      w.interrupt(why);
      expect(closes).toEqual([why]);
      advance(60_000);
      expect(closes).toEqual([why]);
    }
  });

  it('closes at once when the mic changes during the warm period', () => {
    const { w, closes } = setup('30s');
    w.started();
    w.ended();
    w.interrupt('device');
    expect(closes).toEqual(['device']);
  });

  it('never closes the mic under a recording', () => {
    const { w, closes } = setup('30s');
    w.started();
    w.interrupt('battery');
    expect(closes).toEqual([]);
  });

  it('Always: stays open while plugged in, closes on battery', () => {
    const { w, closes, advance, state } = setup('always');
    w.started();
    expect(w.ended()).toBe(true);
    advance(3_600_000);
    expect(closes).toEqual([]);
    state.onAC = false;
    w.powerChanged();
    expect(closes).toEqual(['battery']);
  });

  it('Always on battery behaves like 30 s', () => {
    const { w, closes, advance } = setup('always', false);
    w.started();
    w.ended();
    advance(30_000);
    expect(closes).toEqual(['expired']);
  });

  it('turning the setting Off closes a warm mic at once', () => {
    const { w, closes, state } = setup('30s');
    w.started();
    w.ended();
    state.setting = 'off';
    w.settingChanged();
    expect(closes).toEqual(['off']);
  });
});
