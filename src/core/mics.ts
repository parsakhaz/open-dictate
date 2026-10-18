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

/** A remembered microphone: its label, plus Chromium's groupId to tell identical devices apart. */
export interface MicPref {
  label: string;
  groupId?: string;
}

/** Old settings stored bare labels; they still match by label until the mic is picked again. */
export function parseMicPrefs(x: unknown): MicPref[] {
  if (!Array.isArray(x)) return [];
  const out: MicPref[] = [];
  for (const p of x) {
    if (typeof p === 'string' && p.trim()) out.push({ label: p });
    else if (p && typeof p === 'object' && typeof (p as MicPref).label === 'string') {
      const { label, groupId } = p as MicPref;
      out.push(typeof groupId === 'string' && groupId ? { label, groupId } : { label });
    }
  }
  return out;
}

function sameLabel(a: string, b: string): boolean {
  return micKey(a) === micKey(b);
}

/**
 * The connected device a preference refers to. With a groupId only that exact device matches, so of two
 * identical USB mics the chosen one is used, and unplugging it is noticed; a label-only (old) preference
 * matches the first device with that label.
 */
function deviceFor(p: MicPref, available: MicDevice[]): MicDevice | undefined {
  const same = available.filter((d) => sameLabel(d.label, p.label));
  return p.groupId ? same.find((d) => d.groupId === p.groupId) : same[0];
}

/** The same physical device in a fresh list: by deviceId, else label and groupId. */
function stillThere(d: MicDevice, available: MicDevice[]): MicDevice | undefined {
  return available.find((m) => m.deviceId === d.deviceId) ?? deviceFor({ label: d.label, groupId: d.groupId }, available);
}

const identity = (d: MicDevice) => `${micKey(d.label)}|${d.groupId ?? ''}`;

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
  /** Devices the person switched away from with Undo; not switched to again until they disconnect. */
  private readonly declined = new Set<string>();
  private undoTo: MicDevice | null | undefined;
  private pendingSwitch = false;

  /** `order`: preferred mics, most preferred first. Mutated by pick(); persist it after. */
  constructor(readonly order: MicPref[]) {}

  get current(): MicDevice | null {
    return this.active;
  }

  private best(): MicDevice | null {
    for (const p of this.order) {
      const d = deviceFor(p, this.available);
      if (d && !this.declined.has(identity(d))) return d;
    }
    return null;
  }

  private rank(d: MicDevice | null): number {
    if (!d) return Number.POSITIVE_INFINITY;
    const i = this.order.findIndex((p) => deviceFor(p, [d]) !== undefined);
    return i < 0 ? Number.POSITIVE_INFINITY : i;
  }

  /**
   * The device list changed (or was re-read at the start of a recording). While `recording`, a disconnected
   * device is replaced at once (its stream is gone) but an upgrade waits for recordingEnded().
   */
  update(available: MicDevice[], recording = false): MicUpdate {
    this.available = available;
    const present = new Set(available.map(identity));
    for (const k of [...this.declined]) if (!present.has(k)) this.declined.delete(k);
    const prev = this.active;
    const now = prev ? stillThere(prev, available) : undefined;
    const best = this.best();
    if (prev && !now) {
      this.active = best;
      this.undoTo = undefined;
      return { active: this.active, event: { kind: 'disconnected', from: prev.label, to: best?.label ?? null } };
    }
    // Same device, possibly with a new deviceId.
    if (now) this.active = now;
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
    this.declined.add(identity(this.active));
    this.active = this.undoTo;
    this.undoTo = undefined;
    return this.active;
  }

  /** The person chose a mic (null = system default): it becomes the top preference. */
  pick(d: MicDevice | null): MicDevice | null {
    this.undoTo = undefined;
    this.pendingSwitch = false;
    if (d) {
      this.declined.delete(identity(d));
      // Drop the old entry for this device, including a label-only entry from older settings.
      const i = this.order.findIndex((p) => sameLabel(p.label, d.label) && (!p.groupId || p.groupId === d.groupId));
      if (i >= 0) this.order.splice(i, 1);
      this.order.unshift(d.groupId ? { label: d.label, groupId: d.groupId } : { label: d.label });
    } else {
      // System default: keep the list, but decline everything connected so nothing switches back right away.
      for (const m of this.available) this.declined.add(identity(m));
    }
    this.active = d;
    return d;
  }
}
