// Managed per-profile launcher. It uses the installed app runtime, never a system Node.
import fs from 'node:fs';
import path from 'node:path';
import { CLI_FILE } from '../core/agentwire';

const MARKER = 'rem Managed by Dictate CLI';
export function installCli(appRoot: string, userData: string, executable: string, windows = process.platform === 'win32'): string {
  const dir = path.join(userData, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const source = fs.readFileSync(path.join(appRoot, 'out', 'bridge', CLI_FILE));
  const to = path.join(dir, CLI_FILE);
  const tmp = `${to}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, source);
  fs.renameSync(tmp, to);
  if (!windows) return to;
  const shim = path.join(dir, 'dictate.cmd');
  if (fs.existsSync(shim) && !fs.readFileSync(shim, 'utf8').includes(MARKER)) throw new Error('Unmanaged dictate.cmd left unchanged');
  if (/[\r\n"]/.test(executable)) throw new Error('Unsupported executable path');
  fs.writeFileSync(
    shim,
    `@echo off\r\n${MARKER}\r\nsetlocal DisableDelayedExpansion\r\nfor /f "tokens=2 delims=:" %%C in ('chcp') do set "_DICTATE_CODEPAGE=%%C"\r\nchcp 65001 >nul\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${executable.replace(/%/g, '%%')}" "%~dp0${CLI_FILE}" %*\r\nset "_DICTATE_EXIT=%errorlevel%"\r\nchcp %_DICTATE_CODEPAGE% >nul\r\nexit /b %_DICTATE_EXIT%\r\n`,
  );
  return shim;
}
