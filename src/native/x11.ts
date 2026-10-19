// xdotool is an XTest client. A subprocess isolates Xlib's fatal BadWindow handler from Electron when a
// target closes between calls. It is never run under Wayland, including sessions with XWayland's DISPLAY.
import { spawnSync } from 'node:child_process';
import type { DesktopAdapter } from './desktop';

export type X11Command = (args: string[], input?: string) => { ok: boolean; text: string };
export const x11Command: X11Command = (args, input) => {
  const p = spawnSync('xdotool', args, {
    encoding: 'utf8', input, timeout: input === undefined ? 800 : 10_000,
    maxBuffer: 1024 * 1024, windowsHide: true,
  });
  return { ok: !p.error && p.status === 0, text: p.stdout?.trim() ?? '' };
};

const TERMINAL = /(?:terminal|terminator|tilix|alacritty|kitty|konsole|xterm|urxvt|wezterm|foot)/i;

export function createX11Desktop(run: X11Command = x11Command): DesktopAdapter {
  const number = (args: string[]) => {
    const r = run(args);
    return r.ok && /^\d+$/.test(r.text) ? Number(r.text) : 0;
  };
  const foregroundWindow = () => number(['getactivewindow']) || number(['getwindowfocus']);
  const windowClass = (target: number) => {
    const r = run(['getwindowclassname', String(target)]);
    if (r.ok) return r.text;
    // getwindowclassname was added after xdotool's version still shipped by some distributions.
    const p = spawnSync('xprop', ['-id', String(target), 'WM_CLASS'], { encoding: 'utf8', timeout: 800, maxBuffer: 4096 });
    return p.status === 0 ? p.stdout.split('=')[1]?.trim() ?? '' : '';
  };
  return {
    foregroundWindow,
    isWindow: (target) => target > 1 && run(['getwindowgeometry', String(target)]).ok,
    setForeground: (target) => target > 1 && (run(['windowactivate', '--sync', String(target)]).ok || run(['windowfocus', '--sync', String(target)]).ok),
    windowClass,
    windowPid: (target) => number(['getwindowpid', String(target)]),
    looksLikeNoTextTarget: (target) => target <= 1 || /(?:desktop|plasmashell|xfce4-panel|gnome-shell)/i.test(windowClass(target)),
    caretRect: () => null,
    // X11 does not expose text focus. Never claim a caret merely because a window accepted XTest events.
    hasTextCaret: () => false,
    sendCtrlV: () => run(['key', '--clearmodifiers', '--delay', '0', TERMINAL.test(windowClass(foregroundWindow())) ? 'ctrl+shift+v' : 'ctrl+v']).ok ? 4 : 0,
    sendEnter: () => run(['key', '--clearmodifiers', '--delay', '0', 'Return']).ok,
    // XTest cannot reliably type arbitrary Unicode into every toolkit (Chromium can silently drop it).
    // Preserve the entire transcript for history/retry instead of typing a partial ASCII prefix. Normal
    // clipboard paste supports full Unicode. Fallback text goes through stdin, never process arguments.
    typeText: (text) => /^[\t\n\r\x20-\x7e]*$/.test(text) && run(['type', '--clearmodifiers', '--delay', '0', '--file', '-'], text).ok,
  };
}
