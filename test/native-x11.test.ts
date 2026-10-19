import { describe, expect, it } from 'vitest';
import { createX11Desktop, type X11Command } from '../src/native/x11';

describe('X11 desktop output', () => {
  it('uses the terminal paste binding and reports failed injection accurately', () => {
    const calls: string[][] = [];
    let accepted = true;
    const run: X11Command = (args) => {
      calls.push(args);
      if (args[0] === 'getactivewindow') return { ok: true, text: '42' };
      if (args[0] === 'getwindowclassname') return { ok: true, text: 'Gnome-terminal' };
      return { ok: accepted, text: '' };
    };
    const desktop = createX11Desktop(run);
    expect(desktop.sendCtrlV()).toBe(4);
    expect(calls.at(-1)).toEqual(['key', '--clearmodifiers', '--delay', '0', 'ctrl+shift+v']);
    accepted = false;
    expect(desktop.sendCtrlV()).toBe(0);
    expect(desktop.sendEnter()).toBe(false);
  });

  it('types literal transcripts through stdin and never focuses an invalid target', () => {
    const calls: { args: string[]; input?: string }[] = [];
    const desktop = createX11Desktop((args, input) => {
      calls.push({ args, input });
      return { ok: true, text: '' };
    });
    expect(desktop.typeText('hello "$(touch /tmp/no)"\nکوردی')).toBe(true);
    expect(calls).toEqual([{ args: ['type', '--clearmodifiers', '--delay', '0', '--file', '-'], input: 'hello "$(touch /tmp/no)"\nکوردی' }]);
    expect(desktop.setForeground(0)).toBe(false);
    expect(desktop.isWindow(1)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(desktop.hasTextCaret(42)).toBe(false);
  });
});
