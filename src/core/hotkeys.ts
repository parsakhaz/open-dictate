// The hotkey state machine: raw key down/up events (Windows virtual-key codes, side-specific for modifiers)
// in, start/mode/stop/cancel/picker out. Pure apart from the injected timers.
import type { Binding, KeySpec } from './types';

export type RecordMode = 'push-to-talk' | 'toggle';

export type HotkeyAction =
  /** Capture starts at key down, before we know whether this is a hold or the first of a double-tap. */
  | { type: 'start' }
  /** The press is a hold (push-to-talk) or a double-tap (toggle): show the pill and keep recording. */
  /**
   * `key`: which dictation key (its index in `hotkeys`) started it. `via: 'combo'`: hands-free started from the
   * toggle combo, which also ends it (not a dictation key).
   */
  | { type: 'mode'; mode: RecordMode; key?: number; via?: 'combo' }
  | { type: 'stop' }
  /** `tap`: a lone tap, nothing to type; the pill was never shown. */
  | { type: 'cancel'; reason: 'tap' | 'shortcut' | 'escape' }
  | { type: 'picker' };

export const VK = {
  Escape: 0x1b,
  Space: 0x20,
  Enter: 0x0d,
  Back: 0x08,
  Tab: 0x09,
  Up: 0x26,
  Down: 0x28,
  Left: 0x25,
  Right: 0x27,
  Home: 0x24,
  End: 0x23,
  PageUp: 0x21,
  PageDown: 0x22,
  Delete: 0x2e,
  LShift: 0xa0,
  RShift: 0xa1,
  LCtrl: 0xa2,
  RCtrl: 0xa3,
  LAlt: 0xa4,
  RAlt: 0xa5,
  LWin: 0x5b,
  RWin: 0x5c,
  V: 0x56,
} as const;

const MODIFIERS: Record<Exclude<KeySpec, number>, number[]> = {
  ctrl: [VK.LCtrl, VK.RCtrl],
  shift: [VK.LShift, VK.RShift],
  alt: [VK.LAlt, VK.RAlt],
  meta: [VK.LWin, VK.RWin],
};
const MODIFIER_CODES = new Set(Object.values(MODIFIERS).flat());

export interface Timing {
  /** A press shorter than this is a tap; longer is push-to-talk. */
  tapMs: number;
  /** The second tap must go down within this long of the first tap's release. */
  doubleTapMs: number;
}

export const DEFAULT_TIMING: Timing = { tapMs: 250, doubleTapMs: 350 };

/**
 * Another key pressed while holding the hotkey: before this, the hold was the start of a shortcut and is
 * cancelled; after it, the dictation is finished and delivered.
 */
export const KEEP_WORDS_MS = 1500;

/**
 * Keys nobody types with or uses in shortcuts: F13-F24 (what Logitech Options+ and G HUB can map a mouse button
 * to), Pause, Scroll Lock, Insert and Menu. As a dictation key alone, the app never sees them, and one tap starts
 * hands-free (mouse software may only ever send taps).
 */
const DEDICATED = new Set<number>([0x13, 0x91, 0x2d, 0x5d, ...Array.from({ length: 12 }, (_, i) => 0x7c + i)]);

export function isDedicated(b: Binding | null): boolean {
  return !!b && b.keys.length === 1 && typeof b.keys[0] === 'number' && DEDICATED.has(b.keys[0]);
}

/** Keys that alone would take a key you type with: letters, digits, Space, Enter, Tab, Backspace, and Esc. */
const TYPING = new Set<number>([VK.Space, VK.Enter, VK.Tab, VK.Back, VK.Escape, ...Array.from({ length: 10 }, (_, i) => 0x30 + i), ...Array.from({ length: 26 }, (_, i) => 0x41 + i)]);

/** Why `b` can't be a dictation key, or null if it can. */
export function dictationKeyProblem(b: Binding): string | null {
  if (b.keys.length !== 1 || typeof b.keys[0] !== 'number' || !TYPING.has(b.keys[0])) return null;
  if (b.keys[0] === VK.Escape) return 'Esc cancels a dictation, so it can’t start one.';
  return `${keyName(b.keys[0])} alone would stop you typing it. Pick a key you don’t type with, such as Right Alt or F13, or hold a modifier with it.`;
}

/**
 * Bindings whose last key the hook swallows, so the app never sees it: the picker and toggle combos (Right
 * Ctrl+V must not paste), and dedicated dictation keys. Right Ctrl and Right Alt pass through, so shortcuts work.
 */
export function swallowBindings(b: Bindings): Binding[] {
  return [b.picker, b.toggle, ...b.hotkeys.filter(isDedicated)].filter((x): x is Binding => !!x);
}

function specMatches(spec: KeySpec, code: number): boolean {
  return typeof spec === 'number' ? spec === code : MODIFIERS[spec].includes(code);
}

function inBinding(b: Binding | null, code: number): boolean {
  return !!b?.keys.some((s) => specMatches(s, code));
}

/** Exactly the binding's keys are down: each spec has a key, and no key is down that the binding lacks. */
export function bindingMatches(b: Binding | null, down: Set<number>): boolean {
  if (!b || b.keys.length === 0) return false;
  const codes = [...down];
  return b.keys.every((s) => codes.some((c) => specMatches(s, c))) && codes.every((c) => b.keys.some((s) => specMatches(s, c)));
}

export function isModifier(code: number): boolean {
  return MODIFIER_CODES.has(code);
}

export interface Bindings {
  /** Dictation keys (up to 4): hold for push-to-talk, double-tap to toggle. */
  hotkeys: Binding[];
  /** Optional extra combo that toggles recording on and off. */
  toggle: Binding | null;
  /** Opens the history picker. */
  picker: Binding | null;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

type State =
  | 'idle'
  /** First press down, capture running, not yet a hold or a tap. */
  | 'press1'
  /** First press was a tap: capture keeps running while we wait for a second tap. */
  | 'tapped'
  /** Second press down. */
  | 'press2'
  | 'push-to-talk'
  | 'toggle';

/**
 * The hotkey (Right Ctrl by default) alone:
 * - hold past tapMs: push-to-talk, finished on release;
 * - tap, tap within doubleTapMs: toggle on; the next tap (or double-tap) stops it;
 * - tap, then hold: push-to-talk, keeping the audio from the first tap;
 * - a lone tap, or the key used with any other key (Ctrl+C): cancelled, nothing typed (after KEEP_WORDS_MS of
 *   holding, the dictation is finished instead);
 * Esc cancels any recording. The picker combo (Right Ctrl+V) cancels the speculative capture and opens the picker.
 */
export class HotkeyMachine {
  private readonly downKeys = new Set<number>();
  private state: State = 'idle';
  private pressedAt = 0;
  private timer: unknown;
  /** Presses of the hotkey before this time are ignored: the tail of the double-tap that stopped a toggle. */
  private quietUntil = 0;
  /** The dictation key (index in `hotkeys`) of this recording; -1 when the toggle combo started it. */
  private active = -1;
  /** A dedicated key's tap started hands-free: its presses before this time are the double-tap's second tap. */
  private tapToggleUntil = 0;

  constructor(
    private bindings: Bindings,
    private readonly emit: (a: HotkeyAction) => void,
    private timing: Timing = DEFAULT_TIMING,
    private readonly timers: Timers = realTimers,
  ) {}

  configure(b: Bindings, timing: Timing = this.timing): void {
    this.bindings = b;
    this.timing = timing;
  }

  /** The app ended the recording on its own (an error, or a cancel from the tray). */
  reset(): void {
    this.clearTimer();
    this.state = 'idle';
  }

  get recording(): boolean {
    return this.state !== 'idle';
  }

  /** App buttons and desktop shortcut portals have no key-up event; they share the normal toggle state. */
  toggle(): void {
    if (this.state !== 'idle') { this.end({ type: 'stop' }); return; }
    this.active = -1;
    this.tapToggleUntil = 0;
    this.state = 'toggle';
    this.emit({ type: 'start' });
    this.emit({ type: 'mode', mode: 'toggle', via: 'combo' });
  }

  modifiersDown(): boolean {
    return [...this.downKeys].some(isModifier);
  }

  /** Forget held keys, for when key-ups may have been missed (the session was locked, the hook restarted). */
  clearKeys(): void {
    this.downKeys.clear();
  }

  /** Whether the picker combo is down right now; the hook swallows its last key so the target app never sees it. */
  wouldOpenPicker(code: number): boolean {
    const next = new Set(this.downKeys).add(code);
    return bindingMatches(this.bindings.picker, next);
  }

  down(code: number, t: number): void {
    if (this.downKeys.has(code)) return; // auto-repeat
    this.downKeys.add(code);
    if (this.state !== 'idle' && code === VK.Escape) {
      this.end({ type: 'cancel', reason: 'escape' });
      return;
    }
    const { toggle, picker } = this.bindings;
    const hotkey = this.hotkey;
    switch (this.state) {
      case 'idle': {
        if (bindingMatches(picker, this.downKeys)) {
          this.emit({ type: 'picker' });
          return;
        }
        if (bindingMatches(toggle, this.downKeys)) {
          this.active = -1;
          this.tapToggleUntil = 0;
          this.emit({ type: 'start' });
          this.state = 'toggle';
          this.emit({ type: 'mode', mode: 'toggle', via: 'combo' });
          return;
        }
        const key = this.bindings.hotkeys.findIndex((b) => bindingMatches(b, this.downKeys));
        if (key >= 0 && t >= this.quietUntil) {
          this.active = key;
          this.tapToggleUntil = 0;
          this.state = 'press1';
          this.pressedAt = t;
          this.armHold();
          this.emit({ type: 'start' });
          return;
        }
        return;
      }
      case 'tapped':
        if (bindingMatches(hotkey, this.downKeys)) {
          this.state = 'press2';
          this.pressedAt = t;
          this.armHold();
          return;
        }
        this.end({ type: 'cancel', reason: 'tap' });
        this.down2(code, t);
        return;
      case 'press1':
      case 'press2':
        if (inBinding(hotkey, code)) return; // the rest of a combo hotkey going down
        this.end({ type: 'cancel', reason: 'shortcut' });
        // The same press may complete the picker or toggle combo.
        this.down2(code, t);
        return;
      case 'push-to-talk':
        if (inBinding(hotkey, code)) return;
        // The hotkey is being used with another key, which the app sees as Ctrl+key. Early in a hold that was
        // a shortcut (Right Ctrl, pause, C); after KEEP_WORDS_MS the person was dictating, so their words are
        // finished and kept rather than thrown away.
        if (t - this.pressedAt < KEEP_WORDS_MS || bindingMatches(picker, this.downKeys)) {
          this.end({ type: 'cancel', reason: 'shortcut' });
          this.down2(code, t);
        } else this.end({ type: 'stop' });
        return;
      case 'toggle':
        if (bindingMatches(hotkey, this.downKeys) && t < this.tapToggleUntil) return;
        if (this.bindings.hotkeys.some((b) => bindingMatches(b, this.downKeys)) || bindingMatches(toggle, this.downKeys)) {
          this.quietUntil = t + this.timing.doubleTapMs;
          this.end({ type: 'stop' });
        }
        return;
    }
  }

  /** Re-runs an idle key-down for a key already in downKeys. */
  private down2(code: number, t: number): void {
    this.downKeys.delete(code);
    this.down(code, t);
  }

  up(code: number, t: number): void {
    this.downKeys.delete(code);
    if (!inBinding(this.hotkey, code)) return;
    const tap = t - this.pressedAt < this.timing.tapMs;
    switch (this.state) {
      case 'press1':
        this.clearTimer();
        if (!tap) {
          this.end({ type: 'stop' });
          return;
        }
        if (isDedicated(this.hotkey)) {
          // Not a shortcut key, so one tap means hands-free; a second tap soon after is a double-tap, not a stop.
          this.state = 'toggle';
          this.tapToggleUntil = t + this.timing.doubleTapMs;
          this.emit({ type: 'mode', mode: 'toggle', key: this.active });
          return;
        }
        this.state = 'tapped';
        this.timer = this.timers.set(() => this.end({ type: 'cancel', reason: 'tap' }), this.timing.doubleTapMs);
        return;
      case 'press2':
        this.clearTimer();
        if (tap) {
          this.state = 'toggle';
          this.emit({ type: 'mode', mode: 'toggle', key: this.active });
          return;
        }
        this.end({ type: 'stop' });
        return;
      case 'push-to-talk':
        this.end({ type: 'stop' });
        return;
    }
  }

  /** A press still held at tapMs is push-to-talk. */
  private armHold(): void {
    this.clearTimer();
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      if (this.state === 'press1' || this.state === 'press2') {
        this.state = 'push-to-talk';
        this.emit({ type: 'mode', mode: 'push-to-talk', key: this.active });
      }
    }, this.timing.tapMs);
  }

  /** The dictation key of the recording in progress (or the last one). */
  private get hotkey(): Binding | null {
    return this.bindings.hotkeys[this.active] ?? null;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
  }

  private end(a: HotkeyAction): void {
    this.clearTimer();
    this.state = 'idle';
    this.emit(a);
  }
}

/**
 * Keys that need a "menu mask" when they go down: a lone Alt release activates the app's menu bar (Notepad,
 * Explorer, Office), and a lone Win release opens Start. Dictating with Right Alt, or the picker swallowing the V
 * of Right Alt+V, would leave exactly that lone press, so the hook injects an unassigned key while it is down.
 * Only exact-side keys are masked: an either-side Alt in a combo would otherwise stop Alt opening menus at all.
 */
export function menuMaskKeys(b: Bindings): number[] {
  const masked = new Set([VK.LAlt, VK.RAlt, VK.LWin, VK.RWin] as number[]);
  const out = new Set<number>();
  for (const x of [...b.hotkeys, b.toggle, b.picker]) for (const k of x?.keys ?? []) if (typeof k === 'number' && masked.has(k)) out.add(k);
  return [...out];
}

/** The scan code Windows gives the fake Left Ctrl that AltGr layouts send along with Right Alt. */
const ALTGR_LCTRL_SCAN = 0x21d;

/**
 * On layouts where Right Alt is AltGr, Windows sends a fake Left Ctrl down just before Right Alt (and its up
 * with it). Left in, Right Alt alone would look like Ctrl+Alt: never the dictation key. The fake is spotted by
 * its scan code, or by sharing Right Alt's timestamp, in which case its down is taken back.
 */
export class AltGrFilter {
  private fake = false;
  private lctrlDownAt: number | null = null;

  feed(e: { vk: number; down: boolean; t: number; scan: number }): { vk: number; down: boolean }[] {
    const out = { vk: e.vk, down: e.down };
    if (e.vk === VK.LCtrl) {
      if (e.down && (e.scan === ALTGR_LCTRL_SCAN || this.fake)) {
        this.fake = true;
        return [];
      }
      if (!e.down && this.fake) {
        this.fake = false;
        return [];
      }
      this.lctrlDownAt = e.down ? e.t : null;
      return [out];
    }
    if (e.vk === VK.RAlt && e.down && this.lctrlDownAt === e.t) {
      this.lctrlDownAt = null;
      this.fake = true;
      return [{ vk: VK.LCtrl, down: false }, out];
    }
    return [out];
  }
}

const NAMES: Record<number, string> = {
  [VK.LCtrl]: 'Left Ctrl',
  [VK.RCtrl]: 'Right Ctrl',
  [VK.LShift]: 'Left Shift',
  [VK.RShift]: 'Right Shift',
  [VK.LAlt]: 'Left Alt',
  [VK.RAlt]: 'Right Alt',
  [VK.LWin]: 'Left Win',
  [VK.RWin]: 'Right Win',
  [VK.Escape]: 'Esc',
  [VK.Back]: 'Backspace',
  [VK.Tab]: 'Tab',
  [VK.Enter]: 'Enter',
  20: 'Caps Lock',
  [VK.Space]: 'Space',
  [VK.PageUp]: 'Page Up',
  [VK.PageDown]: 'Page Down',
  [VK.End]: 'End',
  [VK.Home]: 'Home',
  [VK.Left]: 'Left',
  [VK.Up]: 'Up',
  [VK.Right]: 'Right',
  [VK.Down]: 'Down',
  45: 'Insert',
  [VK.Delete]: 'Delete',
  192: '`',
  189: '-',
  187: '=',
  219: '[',
  221: ']',
  220: '\\',
  186: ';',
  222: "'",
  188: ',',
  190: '.',
  191: '/',
  44: 'Print Screen',
  145: 'Scroll Lock',
  19: 'Pause',
  93: 'Menu',
};
for (let c = 0x30; c <= 0x39; c++) NAMES[c] = String.fromCharCode(c);
for (let c = 0x41; c <= 0x5a; c++) NAMES[c] = String.fromCharCode(c);
for (let i = 0; i < 24; i++) NAMES[0x70 + i] = `F${i + 1}`;
for (let i = 0; i < 10; i++) NAMES[0x60 + i] = `Num ${i}`;

const GENERIC: Record<Exclude<KeySpec, number>, string> = { ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', meta: 'Win' };
const ORDER: KeySpec[] = ['ctrl', 'shift', 'alt', 'meta'];

export function keyName(spec: KeySpec): string {
  return typeof spec === 'number' ? (NAMES[spec] ?? `Key ${spec}`) : GENERIC[spec];
}

export function bindingLabel(b: Binding | null): string {
  if (!b || b.keys.length === 0) return 'Off';
  const rank = (s: KeySpec) => {
    const i = ORDER.indexOf(s);
    return i >= 0 ? i : typeof s === 'number' && isModifier(s) ? 4 : 5;
  };
  return [...b.keys]
    .sort((a, c) => rank(a) - rank(c))
    .map(keyName)
    .join(' + ');
}

/**
 * The binding a person meant by pressing `codes` together. Modifier-only bindings keep their exact side
 * (Right Ctrl alone is a dictation key; Left Ctrl alone is not). In a combo, Right Ctrl and Right Alt keep
 * their side (Right Ctrl+V is not Ctrl+V); other modifiers match either side.
 */
export function bindingFromKeys(codes: number[]): Binding | null {
  const unique = [...new Set(codes)];
  if (unique.length === 0) return null;
  if (unique.every(isModifier)) return { keys: unique };
  const keys: KeySpec[] = [];
  for (const c of unique) {
    if (!isModifier(c) || c === VK.RCtrl || c === VK.RAlt) keys.push(c);
    else {
      const g = (Object.keys(MODIFIERS) as (keyof typeof MODIFIERS)[]).find((k) => MODIFIERS[k].includes(c))!;
      if (!keys.includes(g)) keys.push(g);
    }
  }
  return { keys };
}
