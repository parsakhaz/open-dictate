import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyAutostart, desktopExecArgument } from '../src/main/startup';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('start at login', () => {
  it('creates and removes only Dictate’s Linux entry, preserving spaces and desktop field codes in paths', () => {
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dictate-login-')); dirs.push(configHome);
    fs.mkdirSync(path.join(configHome, 'autostart'));
    const other = path.join(configHome, 'autostart', 'other.desktop'); fs.writeFileSync(other, 'untouched');
    const options = { platform: 'linux' as const, appRoot: '/source tree/dictate', executable: '/usr/bin/electron', packaged: true, appImage: '/home/a user/Dictate 100%.AppImage', configHome };
    applyAutostart(true, options);
    const file = path.join(configHome, 'autostart', 'org.dictate.Dictate.desktop');
    expect(fs.readFileSync(file, 'utf8')).toContain('Exec="/home/a user/Dictate 100%%.AppImage"\n');
    applyAutostart(false, options);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(other, 'utf8')).toBe('untouched');
  });

  it('uses native login settings on Mac/Windows and passes separate arguments for a development checkout', () => {
    const recorded: unknown[] = [];
    applyAutostart(true, {platform:'darwin', appRoot:'/a b', executable:'/electron', packaged:false, setLoginItem:(s) => recorded.push(s)});
    applyAutostart(false, {platform:'win32', appRoot:'C:\\dictate', executable:'C:\\dictate.exe', packaged:true, setLoginItem:(s) => recorded.push(s)});
    expect(recorded).toEqual([{openAtLogin:true,path:'/electron',args:['/a b']},{openAtLogin:false}]);
  });

  it('rejects line breaks in desktop paths', () => {
    expect(() => desktopExecArgument('/a\nHidden=true')).toThrow(/control/);
  });
});
