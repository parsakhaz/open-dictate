// How long the mic stays open after a dictation, so a follow-up starts instantly. Always (while plugged in) by
// default, because a cold mic can take about 1 s to open and clip the first words. Main leaves a Bluetooth headset
// out of the default: a held-open headset mic keeps it in its call profile.
// Pure apart from the injected timers.
import type { Timers } from './hotkeys';

export type WarmSetting = 'off' | '30s' | 'always';
export type CloseReason = 'off' | 'expired' | 'lock' | 'sleep' | 'battery' | 'device';

export const WARM_MS = 30_000;

export interface WarmDeps {
  /** Closes the open stream; only called while no recording is using it. */
  close(why: CloseReason): void;
  setting(): WarmSetting;
  onAC(): boolean;
  timers: Timers;
}

export class WarmMic {
  /** The stream is open with no recording on it. */
  private warm = false;
  private timer: unknown;

  constructor(private readonly deps: WarmDeps) {}

  /** A recording took the mic (fresh or warm). */
  started(): void {
    this.warm = false;
    this.heldOnAC = false;
    this.clearTimer();
  }

  /** The recording is done with the mic. Returns true when the stream should stay open. */
  ended(): boolean {
    this.warm = true;
    return this.settle();
  }

  /** Lock, sleep, battery saver or a mic change: a warm stream closes now (a recording keeps its mic). */
  interrupt(why: 'lock' | 'sleep' | 'battery' | 'device'): void {
    if (this.warm) this.close(why);
  }

  powerChanged(): void {
    if (this.warm) this.settle();
  }

  settingChanged(): void {
    if (this.warm) this.settle();
  }

  private settle(): boolean {
    this.clearTimer();
    const s = this.deps.setting();
    if (s === 'off') {
      this.close('off');
      return false;
    }
    if (s === 'always' && this.deps.onAC()) {
      this.heldOnAC = true;
      return true;
    }
    if (this.heldOnAC) {
      // Held open by Always and now unplugged: close rather than start a fresh 30 s.
      this.close('battery');
      return false;
    }
    this.timer = this.deps.timers.set(() => {
      this.timer = undefined;
      this.close('expired');
    }, WARM_MS);
    return true;
  }

  /** Open only because Always is on and the laptop is plugged in. */
  private heldOnAC = false;

  private close(why: CloseReason): void {
    this.clearTimer();
    this.warm = false;
    this.heldOnAC = false;
    this.deps.close(why);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.deps.timers.clear(this.timer);
    this.timer = undefined;
  }
}
