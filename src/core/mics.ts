// Which microphone to use: an ordered preference list, falling back on disconnect and switching back
// (undoably) on reconnect. Pure.

export interface MicDevice {
  deviceId: string;
  label: string;
  groupId?: string;
}

/**
 * A stable identity for a device. Chromium re-issues deviceId and groupId across sessions, but its labels on
 * Windows carry the endpoint name and, for USB devices, the vendor:product id ("Microphone (BOYA mini 2) (2e8a:00f2)").
 */
export function micKey(label: string): string {
  return label
    .replace(/^(Default|Communications) - /i, '')
    .trim()
    .toLowerCase();
}

/** A short name for toasts: "Microphone (BOYA mini 2) (2e8a:00f2)" -> "BOYA mini 2", "Microphone Array (AMD Audio Device)" -> "Microphone Array". */
export function micName(label: string): string {
  const clean = label.replace(/^(Default|Communications) - /i, '').replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '');
  const m = /^([^(]+)\((.+)\)$/.exec(clean);
  if (!m) return clean.trim() || 'Microphone';
  const [prefix, inner] = [m[1].trim(), m[2].trim()];
  // Generic endpoint names say nothing; the device name is in the parentheses.
  return /^(microphone|headset microphone|headset|line in|mic|external microphone)$/i.test(prefix) ? inner : prefix;
}

/** Audio inputs from enumerateDevices(), minus Chromium's "default"/"communications" aliases of real devices. */
export function listMics(devices: { kind: string; deviceId: string; label: string; groupId?: string }[]): MicDevice[] {
  return devices
    .filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}`, groupId: d.groupId }));
}

export type MicEvent =
  | { kind: 'disconnected'; from: string; to: string | null }
  | { kind: 'switched'; from: string | null; to: string; undoable: true };

export interface MicUpdate {
  /** null: the system default device. */
  active: MicDevice | null;
  event?: MicEvent;
}

export class MicSelector {
  private available: MicDevice[] = [];
  private active: MicDevice | null = null;
  /** Labels the person switched away from with Undo; not switched to again until they disconnect. */
  private readonly declined = new Set<string>();
  private undoTo: MicDevice | null | undefined;
  private pendingSwitch = false;

  /** `order`: preferred labels, most preferred first. Mutated by pick(); persist it after. */
  constructor(readonly order: string[]) {}

  get current(): MicDevice | null {
    return this.active;
  }

  private best(): MicDevice | null {
    for (const label of this.order) {
      const key = micKey(label);
      if (this.declined.has(key)) continue;
      const d = this.available.find((m) => micKey(m.label) === key);
      if (d) return d;
    }
    return null;
  }

  private rank(d: MicDevice | null): number {
    if (!d) return Number.POSITIVE_INFINITY;
    const i = this.order.findIndex((l) => micKey(l) === micKey(d.label));
    return i < 0 ? Number.POSITIVE_INFINITY : i;
  }

  /**
   * The device list changed (or was re-read at the start of a recording). While `recording`, a disconnected
   * device is replaced at once (its stream is gone) but an upgrade waits for recordingEnded().
   */
  update(available: MicDevice[], recording = false): MicUpdate {
    this.available = available;
    const present = new Set(available.map((d) => micKey(d.label)));
    for (const k of [...this.declined]) if (!present.has(k)) this.declined.delete(k);
    const prev = this.active;
    const prevGone = !!prev && !present.has(micKey(prev.label));
    const best = this.best();
    if (prevGone) {
      this.active = best;
      this.undoTo = undefined;
      return { active: this.active, event: { kind: 'disconnected', from: prev.label, to: best?.label ?? null } };
    }
    // Same device, possibly with a new deviceId.
    if (prev) this.active = available.find((d) => micKey(d.label) === micKey(prev.label)) ?? prev;
    if (best && this.rank(best) < this.rank(this.active)) {
      if (recording) {
        this.pendingSwitch = true;
        return { active: this.active };
      }
      return this.switchTo(best);
    }
    return { active: this.active };
  }

  /** Applies an upgrade that arrived mid-recording. */
  recordingEnded(): MicUpdate {
    if (!this.pendingSwitch) return { active: this.active };
    this.pendingSwitch = false;
    return this.update(this.available);
  }

  private switchTo(d: MicDevice): MicUpdate {
    const from = this.active;
    this.undoTo = from;
    this.active = d;
    return { active: d, event: { kind: 'switched', from: from?.label ?? null, to: d.label, undoable: true } };
  }

  /** Back to the mic before the last automatic switch, and stay there while the other one stays connected. */
  undo(): MicDevice | null {
    if (this.undoTo === undefined || !this.active) return this.active;
    this.declined.add(micKey(this.active.label));
    this.active = this.undoTo;
    this.undoTo = undefined;
    return this.active;
  }

  /** The person chose a mic (null = system default): it becomes the top preference. */
  pick(d: MicDevice | null): MicDevice | null {
    this.undoTo = undefined;
    this.pendingSwitch = false;
    if (d) {
      const key = micKey(d.label);
      this.declined.delete(key);
      const i = this.order.findIndex((l) => micKey(l) === key);
      if (i >= 0) this.order.splice(i, 1);
      this.order.unshift(d.label);
    } else {
      // System default: keep the list, but decline everything connected so nothing switches back right away.
      for (const m of this.available) this.declined.add(micKey(m.label));
    }
    this.active = d;
    return d;
  }
}
