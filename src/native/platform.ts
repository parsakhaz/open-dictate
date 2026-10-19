// OS selection is lazy: importing main on macOS/Linux must never load user32.dll or the Windows hook.
import { spawnSync } from 'node:child_process';
import { ClipboardItem, clipboard, systemPreferences } from 'electron';
import { type DesktopAdapter, unavailableDesktop } from './desktop';
import { silenceGeneratedInput } from './generated-input';
import { guardProcess } from './posix-lifetime';
import { desktopSession, type DesktopSession } from './session';

export interface PlatformCapabilities {
  platform: NodeJS.Platform;
  displayServer: DesktopSession;
  globalHotkeys: boolean;
  canSwallowKeys: boolean;
  automaticPaste: boolean;
  targetTracking: boolean;
  accessibilityRequired: boolean;
  accessibilityGranted: boolean;
  reason?: string;
}

type Windows = typeof import('./win32');
let windows: Windows | undefined;
let desktop: DesktopAdapter | undefined;
let nativeReason: string | undefined;
let hookReason: string | undefined;
let lowPower: (() => boolean) | undefined;
const win = (): Windows => windows ??= require('./win32') as Windows;

export function accessibilityGranted(): boolean {
  return process.platform !== 'darwin' || systemPreferences.isTrustedAccessibilityClient(false);
}

/** macOS opens its system prompt; a restart is normally needed after changing Accessibility/Input Monitoring. */
export function requestAccessibility(): boolean {
  return process.platform !== 'darwin' || systemPreferences.isTrustedAccessibilityClient(true);
}

function nativeDesktop(): DesktopAdapter {
  if (desktop) return desktop;
  try {
    const session = desktopSession(process.platform, process.env);
    if (session === 'win32') {
      const w = win();
      desktop = { ...w, hasTextCaret: (target) => target === w.foregroundWindow() && w.caretRect() !== null };
    } else if (session === 'macos') {
      const mac = (require('./macos') as typeof import('./macos')).createMacDesktop();
      desktop = mac;
      lowPower = mac.batterySaverOn;
    } else if (session === 'x11') {
      const x = require('./x11') as typeof import('./x11');
      if (!x.x11Command(['--version']).ok) throw new Error('Install xdotool to enable X11 focus tracking and automatic paste.');
      if (!x.x11Command(['getmouselocation']).ok) throw new Error('Cannot connect to the X11 desktop. Check DISPLAY and your desktop session.');
      desktop = x.createX11Desktop();
    } else desktop = unavailableDesktop;
  } catch (err) {
    nativeReason = (err as Error).message;
    desktop = unavailableDesktop;
  }
  return desktop;
}

/** A failed native hook must be visible to setup/settings instead of silently promising a global binding. */
export function reportHookUnavailable(message?: string): void { hookReason = message; }

export function platformCapabilities(): PlatformCapabilities {
  const session = desktopSession(process.platform, process.env);
  const trusted = accessibilityGranted();
  const native = nativeDesktop() !== unavailableDesktop;
  const supported = session === 'win32' || session === 'macos' || session === 'x11';
  const reason = !trusted ? 'Allow Dictate in System Settings → Privacy & Security → Accessibility and Input Monitoring, then restart Dictate.'
    : nativeReason ?? hookReason ?? (session === 'wayland' ? 'Wayland protects global keyboard input and external app focus. Use Start/Stop in Dictate and paste the copied result yourself.'
      : session === 'headless' ? 'No desktop display is available. Use Dictate from a graphical desktop session.'
      : !supported ? `Desktop input is unsupported on ${process.platform}.` : undefined);
  return {
    platform: process.platform, displayServer: session,
    globalHotkeys: supported && native && trusted && !hookReason,
    canSwallowKeys: session === 'win32',
    automaticPaste: native && trusted,
    targetTracking: native && trusted,
    accessibilityRequired: session === 'macos', accessibilityGranted: trusted,
    ...(reason ? { reason } : {}),
  };
}

export const foregroundWindow = (): number => platformCapabilities().targetTracking ? nativeDesktop().foregroundWindow() : 0;
export const isWindow = (target: number): boolean => platformCapabilities().targetTracking && nativeDesktop().isWindow(target);
export const setForeground = (target: number): boolean => platformCapabilities().targetTracking && nativeDesktop().setForeground(target);
export const windowClass = (target: number): string => nativeDesktop().windowClass(target);
export const windowPid = (target: number): number => nativeDesktop().windowPid(target);
export const looksLikeNoTextTarget = (target: number): boolean => !platformCapabilities().automaticPaste || nativeDesktop().looksLikeNoTextTarget(target);
export const caretRect = () => platformCapabilities().targetTracking ? nativeDesktop().caretRect() : null;
export const hasTextCaret = (target: number): boolean => platformCapabilities().targetTracking && nativeDesktop().hasTextCaret(target);
function inject<T>(send: () => T): T {
  if (process.platform === 'win32') return send();
  silenceGeneratedInput();
  try { return send(); } finally { silenceGeneratedInput(); }
}
export const sendCtrlV = (): number => platformCapabilities().automaticPaste ? inject(() => nativeDesktop().sendCtrlV()) : 0;
export const sendEnter = (): boolean => platformCapabilities().automaticPaste && inject(() => nativeDesktop().sendEnter());
export const typeText = (text: string): boolean => platformCapabilities().automaticPaste && inject(() => nativeDesktop().typeText(text));

export function batterySaverOn(): boolean {
  if (process.platform === 'win32') return win().batterySaverOn();
  nativeDesktop();
  if (lowPower) return lowPower();
  if (process.platform === 'linux') {
    const p = spawnSync('powerprofilesctl', ['get'], { encoding: 'utf8', timeout: 300 });
    return p.status === 0 && p.stdout.trim() === 'power-saver';
  }
  return false;
}

export const killWithUs = (pid: number): boolean => process.platform === 'win32' ? win().killWithUs(pid) : guardProcess(pid);

/** Windows privacy formats remain native; macOS marks transient pastes for clipboard managers. */
export async function writeClipboardText(text: string, opts: { history?: boolean } = {}): Promise<void> {
  if (process.platform === 'win32') return win().writeClipboardText(text, { history: !!opts.history });
  if (process.platform !== 'darwin') return clipboard.writeText(text);
  const formats: Record<string, string> = {
    'text/plain': text,
    'electron application/osclipboard;format="org.nspasteboard.ConcealedType"': '',
  };
  if (!opts.history) formats['electron application/osclipboard;format="org.nspasteboard.TransientType"'] = '';
  await clipboard.write([new ClipboardItem(formats)]);
}
