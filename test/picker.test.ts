import { describe, expect, it } from 'vitest';
import { PickerController, type PickerWindow } from '../src/main/picker';

class FakeWindow implements PickerWindow {
  sent: string[] = [];
  visible = false;
  destroyed = false;
  ready?: () => void;
  gone?: () => void;
  send(channel: string) {
    if (this.destroyed) throw new Error('destroyed');
    this.sent.push(channel);
  }
  show() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
  isVisible() {
    return this.visible;
  }
  destroy() {
    this.destroyed = true;
    this.visible = false;
  }
  place() {}
  onReady(cb: () => void) {
    this.ready = cb;
  }
  onGone(cb: () => void) {
    this.gone = cb;
  }
}

/** Manual timers: fire() runs every pending timeout. */
function setup(opts: { autoReady?: boolean; takesFocus?: boolean } = { autoReady: true }) {
  const windows: FakeWindow[] = [];
  const capture: boolean[] = [];
  let fg = 7;
  const timeouts = new Map<number, () => void>();
  let seq = 0;
  const ctrl = new PickerController({
    create: () => {
      const w = new FakeWindow();
      windows.push(w);
      if (opts.autoReady) queueMicrotask(() => w.ready?.());
      return w;
    },
    capture: (on) => capture.push(on),
    foreground: () => fg,
    caret: () => null,
    items: () => [],
    log: () => undefined,
    takesFocus: opts.takesFocus,
    setTimeout: (fn) => {
      const id = ++seq;
      timeouts.set(id, fn);
      return id;
    },
    clearTimeout: (h) => {
      timeouts.delete(h as number);
    },
    setInterval: () => 1,
    clearInterval: () => undefined,
  });
  const fireTimeouts = () => {
    for (const [id, fn] of [...timeouts]) {
      timeouts.delete(id);
      fn();
    }
  };
  return { ctrl, windows, capture, fireTimeouts, setFg: (h: number) => (fg = h) };
}

describe('PickerController', () => {
  it('uses ordinary focused input without capturing or forwarding keys', async () => {
    const t = setup({ autoReady: true, takesFocus: true });
    t.setFg(99);
    await t.ctrl.open();
    expect(t.ctrl.isOpen).toBe(true);
    expect(t.ctrl.target).toBe(99);
    expect(t.capture).toEqual([]);
    t.ctrl.close();
    expect(t.capture).toEqual([]);
    expect(t.windows[0].visible).toBe(false);
  });
  it('opens once its page is ready, captures keys, and releases them on close', async () => {
    const t = setup();
    await t.ctrl.open();
    expect(t.windows[0].visible).toBe(true);
    expect(t.windows[0].sent).toContain('dictate:picker-open');
    expect(t.capture).toEqual([true]);
    t.ctrl.close();
    expect(t.capture).toEqual([true, false]);
    expect(t.windows[0].visible).toBe(false);
  });

  it('releases the keyboard when the picker renderer dies while open (R1)', async () => {
    const t = setup();
    await t.ctrl.open();
    t.windows[0].gone?.();
    expect(t.capture).toEqual([true, false]);
    expect(t.ctrl.isOpen).toBe(false);
    // close after the crash is harmless and does not touch the dead window
    t.ctrl.close();
    expect(t.capture).toEqual([true, false]);
    // the next open makes a new window
    await t.ctrl.open();
    expect(t.windows).toHaveLength(2);
    expect(t.capture).toEqual([true, false, true]);
  });

  it('retries with a fresh window after the page missed its ready deadline (R4)', async () => {
    const t = setup({ autoReady: false });
    const first = t.ctrl.open();
    t.fireTimeouts();
    await first;
    expect(t.windows[0].destroyed).toBe(true);
    expect(t.capture).toEqual([]);
    // the late handshake of the discarded window changes nothing
    t.windows[0].ready?.();
    const second = t.ctrl.open();
    t.windows[1].ready?.();
    await second;
    expect(t.windows).toHaveLength(2);
    expect(t.windows[1].visible).toBe(true);
    expect(t.capture).toEqual([true]);
  });

  it('drops an open that was closed while the page was loading', async () => {
    const t = setup({ autoReady: false });
    const p = t.ctrl.open();
    t.ctrl.close();
    t.windows[0].ready?.();
    await p;
    expect(t.windows[0].visible).toBe(false);
    expect(t.capture).toEqual([]);
  });

  it('remembers the window that had focus as the paste target', async () => {
    const t = setup();
    t.setFg(99);
    await t.ctrl.open();
    expect(t.ctrl.target).toBe(99);
  });
});
