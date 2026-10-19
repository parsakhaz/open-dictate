// Auto-update rules (C6, D11): how this build can update, when to check, and when a downloaded update may
// install. Pure; main's updater does the network and the timers (one-shot, never a poll).

export type UpdateMode = 'install' | 'notify' | 'off';

export const FIRST_CHECK_MS = 60_000;
export const CHECK_EVERY_MS = 24 * 60 * 60_000;
export const IDLE_BEFORE_INSTALL_MS = 10 * 60_000;

/**
 * Windows (NSIS) and an AppImage replace themselves. An unsigned Mac app cannot (Squirrel.Mac requires a
 * signature) and a .deb belongs to the package manager, so those only say a new version is out. Development
 * builds never update.
 */
export function updateMode(p: { platform: NodeJS.Platform; packaged: boolean; appImage?: string }): UpdateMode {
  if (!p.packaged) return 'off';
  if (p.platform === 'win32' || (p.platform === 'linux' && p.appImage)) return 'install';
  return 'notify';
}

export function versionFromTag(tag: string): string | null {
  return /^(?:dictate-)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag)?.[1] ?? null;
}

/** Semver precedence for x.y.z with an optional pre-release, which sorts before its release. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => {
    const [core, pre = ''] = v.split('-', 2);
    return { nums: core.split('.').map(Number), pre };
  };
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i];
  if (a.pre === b.pre) return false;
  if (!a.pre) return true;
  if (!b.pre) return false;
  return a.pre.localeCompare(b.pre, 'en', { numeric: true }) > 0;
}

/** Delay until the next check: a minute after start (or when a day was missed), then daily. */
export function nextCheckMs(lastCheckAt: number | null, now: number): number {
  if (lastCheckAt === null) return FIRST_CHECK_MS;
  return Math.max(FIRST_CHECK_MS, lastCheckAt + CHECK_EVERY_MS - now);
}

export interface Busy {
  recording: boolean;
  cleaning: boolean;
  downloading: boolean;
}

/** Live dictation and model downloads always win: null while busy, else the wait until 10 idle minutes. */
export function installWaitMs(busy: Busy, lastActivityAt: number, now: number): number | null {
  if (busy.recording || busy.cleaning || busy.downloading) return null;
  return Math.max(0, lastActivityAt + IDLE_BEFORE_INSTALL_MS - now);
}
