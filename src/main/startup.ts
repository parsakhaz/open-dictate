// Native login items on Mac/Windows, XDG autostart on Linux. No shell is involved.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface StartupOptions {
  platform: NodeJS.Platform;
  appRoot: string;
  executable: string;
  packaged: boolean;
  appImage?: string;
  configHome?: string;
  setLoginItem?: (settings: { openAtLogin: boolean; path?: string; args?: string[] }) => void;
}

export function desktopExecArgument(text: string): string {
  if (/[\r\n\0]/.test(text)) throw new Error('The app path contains unsupported control characters');
  return `"${text.replace(/%/g, '%%').replace(/[\\"`$]/g, '\\$&')}"`;
}

export function applyAutostart(enabled: boolean, options: StartupOptions): void {
  if (options.platform === 'linux') {
    const directory = path.join(options.configHome || path.join(os.homedir(), '.config'), 'autostart');
    const file = path.join(directory, 'org.dictate.Dictate.desktop');
    if (!enabled) { fs.rmSync(file, { force: true }); return; }
    const command = [options.appImage || options.executable, ...(!options.packaged ? [options.appRoot] : [])].map(desktopExecArgument).join(' ');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nVersion=1.0\nName=Dictate\nComment=Local dictation\nExec=${command}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`, { mode: 0o600 });
  } else if (options.platform === 'win32' || options.platform === 'darwin') {
    if (!options.setLoginItem) throw new Error('Native login-item support is unavailable');
    options.setLoginItem({ openAtLogin: enabled, ...(!options.packaged ? { path: options.executable, args: [options.appRoot] } : {}) });
  } else if (enabled) throw new Error(`Start at login is unsupported on ${options.platform}`);
}
