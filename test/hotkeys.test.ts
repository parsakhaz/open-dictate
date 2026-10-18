import { describe, expect, it } from 'vitest';
import { AltGrFilter, type Bindings, bindingFromKeys, bindingLabel, type HotkeyAction, HotkeyMachine, menuMaskKeys, type Timers, VK } from '../src/core/hotkeys';

const C = 0x43;

/** Timers driven by the test's clock: advance(t) fires everything due by t. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    set: (fn, ms) => {
      const id = ++seq;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (h) => {
      pending.delete(h as number);
    },
  };
  const advance = (t: number) => {
    for (;;) {
      const due = [...pending.entries()].filter(([, p]) => p.at <= t).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      pending.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = t;
  };
  return { timers, advance };
}

const DEFAULTS: Bindings = { hotkey: { keys: [VK.RCtrl] }, toggle: null, picker: { keys: [VK.RCtrl, VK.V] } };

function machine(b: Bindings = DEFAULTS) {
  const actions: HotkeyAction[] = [];
  const clock = fakeClock();
  const m = new HotkeyMachine(b, (a) => actions.push(a), { tapMs: 250, doubleTapMs: 350 }, clock.timers);
  const down = (k: number, t: number) => {
    clock.advance(t);
    m.down(k, t);
  };
  const up = (k: number, t: number) => {
    clock.advance(t);
    m.up(k, t);
  };
  return { m, actions, down, up, advance: clock.advance };
}

const start = { type: 'start' } as const;
const ptt = { type: 'mode', mode: 'push-to-talk' } as const;
const toggle = { type: 'mode', mode: 'toggle' } as const;
const stop = { type: 'stop' } as const;

describe('hold: push-to-talk', () => {
  it('starts capture at key down, becomes push-to-talk at 250 ms, stops on release', () => {
    const { actions, down, up, advance } = machine();
    down(VK.RCtrl, 0);
    expect(actions).toEqual([start]);
    advance(249);
    expect(actions).toEqual([start]);
    advance(250);
    expect(actions).toEqual([start, ptt]);
    down(VK.RCtrl, 400); // auto-repeat
    up(VK.RCtrl, 2000);
    expect(actions).toEqual([start, ptt, stop]);
  });

  it('finishes (keeps the words) when another key is pressed late in a long hold', () => {
    const { actions, down, up } = machine();
    down(VK.RCtrl, 0);
    down(C, 3000);
    up(C, 3050);
    up(VK.RCtrl, 4000);
    expect(actions).toEqual([start, ptt, stop]);
  });

  it('cancels when another key is pressed just after the hold threshold: a slow shortcut (S1)', () => {
    const { actions, down } = machine();
    down(VK.RCtrl, 0);
    down(C, 300);
    expect(actions).toEqual([start, ptt, { type: 'cancel', reason: 'shortcut' }]);
  });
});

describe('tap', () => {
  it('a lone tap does nothing: capture is cancelled once the double-tap window passes', () => {
    const { actions, down, up, advance } = machine();
    down(VK.RCtrl, 0);
    up(VK.RCtrl, 120);
    expect(actions).toEqual([start]);
    advance(469);
    expect(actions).toEqual([start]);
    advance(470);
    expect(actions).toEqual([start, { type: 'cancel', reason: 'tap' }]);
  });

  it('a tap followed by typing is cancelled at once', () => {
    const { actions, down, up } = machine();
    down(VK.RCtrl, 0);
    up(VK.RCtrl, 100);
    down(C, 200);
    expect(actions).toEqual([start, { type: 'cancel', reason: 'tap' }]);
  });
});

describe('double-tap: toggle', () => {
  it('two taps latch toggle; one more tap stops it', () => {
    const { actions, down, up, advance } = machine();
    down(VK.RCtrl, 0);
    up(VK.RCtrl, 100);
    down(VK.RCtrl, 300);
    up(VK.RCtrl, 380);
    expect(actions).toEqual([start, toggle]);
    advance(4000);
    expect(actions).toEqual([start, toggle]);
    down(C, 5000); // typing while toggled is fine
    up(C, 5050);
    down(VK.RCtrl, 8000);
    expect(actions).toEqual([start, toggle, stop]);
    up(VK.RCtrl, 8080);
    // the second tap of a stopping double-tap does not start a new capture
    down(VK.RCtrl, 8200);
    up(VK.RCtrl, 8260);
    advance(9000);
    expect(actions).toEqual([start, toggle, stop]);
  });

  it('taps too far apart are two lone taps', () => {
    const { actions, down, up, advance } = machine();
    down(VK.RCtrl, 0);
    up(VK.RCtrl, 100);
    advance(500);
    down(VK.RCtrl, 600);
    up(VK.RCtrl, 680);
    advance(2000);
    expect(actions).toEqual([start, { type: 'cancel', reason: 'tap' }, start, { type: 'cancel', reason: 'tap' }]);
  });
});

describe('tap then hold', () => {
  it('is push-to-talk that keeps the audio from the first tap', () => {
    const { actions, down, up, advance } = machine();
    down(VK.RCtrl, 0);
    up(VK.RCtrl, 100);
    down(VK.RCtrl, 250);
    advance(600);
    expect(actions).toEqual([start, ptt]);
    up(VK.RCtrl, 3000);
    expect(actions).toEqual([start, ptt, stop]);
  });
});

describe('Ctrl+key combos', () => {
  it('Right Ctrl+C cancels the capture and shows nothing', () => {
    const { actions, down, up, advance } = machine();
    down(VK.RCtrl, 0);
    down(C, 150);
    up(C, 200);
    up(VK.RCtrl, 260);
    advance(2000);
    expect(actions).toEqual([start, { type: 'cancel', reason: 'shortcut' }]);
  });

  it('Right Ctrl held a moment before C is still a shortcut', () => {
    const { actions, down } = machine();
    down(VK.RCtrl, 0);
    down(C, 240);
    expect(actions).toEqual([start, { type: 'cancel', reason: 'shortcut' }]);
  });

  it('does not fire when Right Ctrl goes down while another key is held', () => {
    const { actions, down } = machine();
    down(VK.LShift, 0);
    down(VK.RCtrl, 10);
    expect(actions).toEqual([]);
  });

  it('Right Ctrl+V opens the picker; Left Ctrl+V does nothing', () => {
    const { m, actions, down, up } = machine();
    down(VK.LCtrl, 0);
    expect(m.wouldOpenPicker(VK.V)).toBe(false);
    down(VK.V, 50);
    up(VK.V, 80);
    up(VK.LCtrl, 90);
    expect(actions).toEqual([]);
    down(VK.RCtrl, 1000);
    expect(m.wouldOpenPicker(VK.V)).toBe(true);
    down(VK.V, 1100);
    expect(actions).toEqual([start, { type: 'cancel', reason: 'shortcut' }, { type: 'picker' }]);
  });

  it('a slow Right Ctrl+V opens the picker on both sides of the hold threshold (S1)', () => {
    for (const at of [200, 300, 2500]) {
      const { actions, down } = machine();
      down(VK.RCtrl, 0);
      down(VK.V, at);
      expect(actions.slice(-2)).toEqual([{ type: 'cancel', reason: 'shortcut' }, { type: 'picker' }]);
    }
  });

  it('an optional toggle combo works on its own', () => {
    const { actions, down, up } = machine({ ...DEFAULTS, toggle: { keys: ['ctrl', 'shift', VK.Space] } });
    down(VK.LCtrl, 0);
    down(VK.LShift, 10);
    down(VK.Space, 20);
    for (const k of [VK.Space, VK.LShift, VK.LCtrl]) up(k, 100);
    expect(actions).toEqual([start, toggle]);
    down(VK.LCtrl, 5000);
    down(VK.LShift, 5010);
    down(VK.Space, 5020);
    expect(actions).toEqual([start, toggle, stop]);
  });
});

describe('Esc', () => {
  it('cancels push-to-talk, and the release does nothing more', () => {
    const { actions, down, up } = machine();
    down(VK.RCtrl, 0);
    down(VK.Escape, 1500);
    up(VK.RCtrl, 1800);
    expect(actions).toEqual([start, ptt, { type: 'cancel', reason: 'escape' }]);
  });

  it('cancels a toggle recording', () => {
    const { actions, down, up } = machine();
    down(VK.RCtrl, 0);
    up(VK.RCtrl, 100);
    down(VK.RCtrl, 200);
    up(VK.RCtrl, 260);
    down(VK.Escape, 3000);
    expect(actions.at(-1)).toEqual({ type: 'cancel', reason: 'escape' });
  });

  it('does nothing when idle', () => {
    const { actions, down } = machine();
    down(VK.Escape, 0);
    expect(actions).toEqual([]);
  });
});

describe('configurable timing', () => {
  it('honours a longer tap threshold', () => {
    const actions: HotkeyAction[] = [];
    const clock = fakeClock();
    const m = new HotkeyMachine(DEFAULTS, (a) => actions.push(a), { tapMs: 400, doubleTapMs: 350 }, clock.timers);
    m.down(VK.RCtrl, 0);
    clock.advance(300);
    m.up(VK.RCtrl, 300);
    expect(actions).toEqual([start]);
  });
});

describe('external reset', () => {
  it('returns to idle when the app ends the recording itself', () => {
    const { m, actions, down, up } = machine();
    down(VK.RCtrl, 0);
    m.reset();
    up(VK.RCtrl, 1000);
    expect(actions).toEqual([start]);
  });
});

describe('modifiersDown', () => {
  it('is true while any modifier is held', () => {
    const { m, down, up } = machine();
    down(VK.LShift, 0);
    expect(m.modifiersDown()).toBe(true);
    up(VK.LShift, 10);
    expect(m.modifiersDown()).toBe(false);
  });
});

describe('labels and recording bindings', () => {
  it('names keys the way a person reads them', () => {
    expect(bindingLabel({ keys: [VK.RCtrl] })).toBe('Right Ctrl');
    expect(bindingLabel({ keys: ['ctrl', 'shift', VK.Space] })).toBe('Ctrl + Shift + Space');
    expect(bindingLabel({ keys: [VK.RCtrl, VK.V] })).toBe('Right Ctrl + V');
    expect(bindingLabel(null)).toBe('Off');
  });

  it('keeps the exact side for modifier-only keys and Right Ctrl combos, generic otherwise', () => {
    expect(bindingFromKeys([VK.RCtrl])).toEqual({ keys: [VK.RCtrl] });
    expect(bindingFromKeys([VK.RCtrl, VK.V])).toEqual({ keys: [VK.RCtrl, VK.V] });
    expect(bindingFromKeys([VK.LCtrl, VK.LShift, VK.Space])).toEqual({ keys: ['ctrl', 'shift', VK.Space] });
    expect(bindingFromKeys([])).toBeNull();
  });
});

describe('menuMaskKeys', () => {
  it('masks Right Alt when it is the dictation key or part of the picker combo', () => {
    expect(menuMaskKeys({ hotkey: { keys: [VK.RAlt] }, toggle: null, picker: { keys: [VK.RAlt, VK.V] } })).toEqual([VK.RAlt]);
  });

  it('masks the Win keys too (a lone Win release opens Start), and nothing for Ctrl', () => {
    expect(menuMaskKeys({ hotkey: { keys: [VK.RCtrl] }, toggle: { keys: [VK.LWin, 0x20] }, picker: { keys: [VK.RCtrl, VK.V] } })).toEqual([VK.LWin]);
    expect(menuMaskKeys({ hotkey: { keys: [VK.RCtrl] }, toggle: null, picker: null })).toEqual([]);
  });

  it('leaves either-side Alt alone, so Alt still opens menus', () => {
    expect(menuMaskKeys({ hotkey: { keys: [VK.RCtrl] }, toggle: { keys: ['alt', 0x20] }, picker: null })).toEqual([]);
  });
});

describe('AltGrFilter', () => {
  const ev = (vk: number, down: boolean, t: number, scan = 0) => ({ vk, down, t, scan });

  it('drops the fake Left Ctrl that AltGr layouts send with Right Alt (scan code 0x21D)', () => {
    const f = new AltGrFilter();
    expect(f.feed(ev(VK.LCtrl, true, 10, 0x21d))).toEqual([]);
    expect(f.feed(ev(VK.RAlt, true, 10, 0x38))).toEqual([{ vk: VK.RAlt, down: true }]);
    expect(f.feed(ev(VK.LCtrl, false, 90, 0x21d))).toEqual([]);
    expect(f.feed(ev(VK.RAlt, false, 90, 0x38))).toEqual([{ vk: VK.RAlt, down: false }]);
  });

  it('also spots it by timing: a Left Ctrl down with the same timestamp as Right Alt is taken back', () => {
    const f = new AltGrFilter();
    expect(f.feed(ev(VK.LCtrl, true, 10, 0x1d))).toEqual([{ vk: VK.LCtrl, down: true }]);
    expect(f.feed(ev(VK.RAlt, true, 10, 0x38))).toEqual([{ vk: VK.LCtrl, down: false }, { vk: VK.RAlt, down: true }]);
    expect(f.feed(ev(VK.LCtrl, false, 90, 0x1d))).toEqual([]);
  });

  it('passes a real Left Ctrl through, even with Right Alt', () => {
    const f = new AltGrFilter();
    expect(f.feed(ev(VK.LCtrl, true, 10, 0x1d))).toEqual([{ vk: VK.LCtrl, down: true }]);
    expect(f.feed(ev(VK.RAlt, true, 200, 0x38))).toEqual([{ vk: VK.RAlt, down: true }]);
    expect(f.feed(ev(VK.LCtrl, false, 300, 0x1d))).toEqual([{ vk: VK.LCtrl, down: false }]);
  });

  it('with the filter, an AltGr press is a plain Right Alt hold to the machine', () => {
    const clock = fakeClock();
    const out: string[] = [];
    const m = new HotkeyMachine({ hotkey: { keys: [VK.RAlt] }, toggle: null, picker: { keys: [VK.RAlt, VK.V] } }, (a) => out.push(a.type === 'mode' ? a.mode : a.type), undefined, clock.timers);
    const f = new AltGrFilter();
    const feed = (vk: number, down: boolean, t: number, scan = 0) => {
      clock.advance(t);
      for (const e of f.feed({ vk, down, t, scan })) e.down ? m.down(e.vk, t) : m.up(e.vk, t);
    };
    feed(VK.LCtrl, true, 0, 0x21d);
    feed(VK.RAlt, true, 0, 0x38);
    feed(VK.LCtrl, true, 300, 0x21d); // auto-repeat of the fake Ctrl
    feed(VK.LCtrl, false, 2000, 0x21d);
    feed(VK.RAlt, false, 2000, 0x38);
    expect(out).toEqual(['start', 'push-to-talk', 'stop']);
  });
});

