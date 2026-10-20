// Automatic gain control for the mic, run on every captured sample (the worklet and the native worker both use it
// through the Chunker). Pure; browser-safe; a few operations per sample and no added latency.
//
// It measures speech, not noise: 20 ms frames are compared with a slowly rising noise floor, and only frames well
// above it may raise the gain. Silence and room hiss hold the gain where it is, so hiss is never brought up while
// nobody speaks. The gain rises slowly (0.75 s) and falls fast (75 ms); a soft limiter catches the peaks in between.
import { dbfs, defaultGainDb, defaultStartDb, KNEE, softLimit } from './audio';
import { micKey } from './mics';
import type { Settings } from './types';

/**
 * Speech is brought towards this RMS. Nemotron hears speech recorded at ordinary levels (the repo's fixture
 * sits at -21 dBFS), and -20 dBFS leaves about 20 dB of headroom before the limiter's knee.
 */
export const AGC_TARGET_DBFS = -20;

/** `auto`: AGC between 0 dB and `db` (the "Maximum boost"). Manual: a fixed `db`. `startDb` carries the last gain over. */
export interface GainSpec {
  auto: boolean;
  db: number;
  startDb?: number;
}

/** The gain for mic `label` under these settings. */
export function gainSpec(s: Pick<Settings, 'autoGain' | 'gainDb' | 'agcGainDb'>, label: string): GainSpec {
  const key = micKey(label);
  const db = s.gainDb[key] ?? defaultGainDb(label, s.autoGain);
  return s.autoGain ? { auto: true, db, startDb: s.agcGainDb[key] ?? defaultStartDb(label) } : { auto: false, db };
}

const SR = 16000;
const FRAME = 320;
const FRAME_S = FRAME / SR;
const per = (seconds: number) => 1 - Math.exp(-FRAME_S / seconds);
/** Upward: slow, so a few loud syllables never push a quiet mic around. */
const ATTACK = per(0.75);
/** Downward: fast, so a sudden loud voice is brought back within a few frames. */
const RELEASE = per(0.075);
/** The noise floor follows quieter frames quickly and louder ones only slowly, so speech never becomes the floor. */
const FLOOR_FALL = per(0.1);
const FLOOR_RISE = per(5);
/** A frame this far above the floor is speech. */
const SPEECH_ABOVE_FLOOR_DB = 10;
/** Quieter than this (before gain) is never speech, however quiet the room. */
const MIN_SPEECH_DBFS = -70;
/** Per-sample smoothing of the gain itself (5 ms), so a change between frames never clicks. */
const SMOOTH = 1 - Math.exp(-1 / (0.005 * SR));

export class Agc {
  private auto = true;
  private lo = 0;
  private hi = 0;
  /** The gain the frames decided, in dB, and the linear gain being applied (gliding towards it). */
  private db = 0;
  private target = 1;
  private g = 1;
  private floor: number | null = null;
  private energy = 0;
  private n = 0;

  constructor(spec: GainSpec) {
    this.set(spec);
  }

  /** A new mode or maximum (the person moved the slider, or another mic took over). */
  set(spec: GainSpec): void {
    this.auto = spec.auto;
    this.lo = Math.min(0, spec.db);
    this.hi = spec.db;
    this.db = spec.auto ? clamp(spec.startDb ?? this.db, this.lo, this.hi) : spec.db;
    this.target = 10 ** (this.db / 20);
    this.g = this.target;
    this.floor = null;
    this.energy = 0;
    this.n = 0;
  }

  /** The gain being applied now, in dB. */
  get gainDb(): number {
    return dbfs(this.g);
  }

  /** Applies the gain in place; the levels are of what comes out. */
  process(samples: Float32Array): { peak: number; rms: number; limited: number } {
    let peak = 0;
    let sum = 0;
    let limited = 0;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      this.g += (this.target - this.g) * SMOOTH;
      let y = x * this.g;
      if (this.auto && (y > KNEE || y < -KNEE) && this.g > 1) {
        // Peak protection: a boosted sample that would pass the knee drops the gain at once (to no less than 0 dB).
        this.g = Math.max(1, KNEE / Math.abs(x));
        this.target = Math.min(this.target, this.g);
        this.db = dbfs(this.target);
        y = x * this.g;
      }
      if (y > KNEE || y < -KNEE) {
        y = softLimit(y);
        limited++;
      }
      samples[i] = y;
      const a = Math.abs(y);
      if (a > peak) peak = a;
      sum += y * y;
      if (this.auto) {
        this.energy += x * x;
        if (++this.n === FRAME) this.frame();
      }
    }
    return { peak, rms: samples.length ? Math.sqrt(sum / samples.length) : 0, limited };
  }

  private frame(): void {
    const level = dbfs(Math.sqrt(this.energy / FRAME));
    this.energy = 0;
    this.n = 0;
    const floor = this.floor ?? level;
    this.floor = floor + (level - floor) * (level < floor ? FLOOR_FALL : FLOOR_RISE);
    const speaking = level > MIN_SPEECH_DBFS && level > floor + SPEECH_ABOVE_FLOOR_DB;
    const over = level + this.db - AGC_TARGET_DBFS;
    // Anything too loud brings the gain down; only speech may bring it up. Silence holds it.
    if (over > 0) this.db -= over * RELEASE;
    else if (speaking) this.db -= over * ATTACK;
    this.db = clamp(this.db, this.lo, this.hi);
    this.target = 10 ** (this.db / 20);
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
