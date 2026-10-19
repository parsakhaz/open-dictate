// An IPC watchdog survives an abrupt Electron exit. When the parent endpoint closes, it terminates only
// the cleanup processes explicitly enrolled by this app. No polling or platform-specific shell is needed.
import { type ChildProcess, spawn } from 'node:child_process';

const WATCHDOG = `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const children = new Map();
let procMatchesNamespace;
function procPid(pid) {
  if (procMatchesNamespace === undefined) {
    procMatchesNamespace = Number(fs.readFileSync('/proc/self/stat', 'utf8').split(' ')[0]) === process.pid;
  }
  if (procMatchesNamespace) return pid;
  // Some containers mount the host's /proc inside a nested PID namespace. Match the namespace as well
  // as NSpid rather than accidentally enrolling an unrelated host process with the same small PID.
  const namespace = fs.readlinkSync('/proc/self/ns/pid');
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\\d+$/.test(entry)) continue;
    try {
      const status = fs.readFileSync('/proc/' + entry + '/status', 'utf8');
      const ids = status.match(/^NSpid:\\s+(.+)$/m)?.[1].trim().split(/\\s+/);
      if (Number(ids?.at(-1)) === pid && fs.readlinkSync('/proc/' + entry + '/ns/pid') === namespace) return entry;
    } catch {}
  }
  return null;
}
function identity(pid) {
  try {
    if (process.platform === 'linux') {
      const hostPid = procPid(pid);
      if (!hostPid) return null;
      const stat = fs.readFileSync('/proc/' + hostPid + '/stat', 'utf8');
      return hostPid + ':' + stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19];
    }
    const p = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'comm='], { encoding: 'utf8', timeout: 500 });
    return p.status === 0 ? p.stdout.trim() : null;
  } catch { return null; }
}
function terminate(signal) {
  for (const [pid, born] of children) {
    if (identity(pid) !== born) continue;
    try { process.kill(pid, signal); } catch {}
  }
}
process.on('message', pid => {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  const born = identity(pid);
  if (born) children.set(pid, born);
});
process.on('disconnect', () => {
  terminate('SIGTERM');
  setTimeout(() => {
    terminate('SIGKILL');
    process.exit(0);
  }, 1000);
});
`;

let watcher: ChildProcess | undefined;

export function guardProcess(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return false;
  if (!watcher?.connected) {
    watcher = spawn(process.execPath, ['-e', WATCHDOG], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    });
    watcher.on('error', () => { watcher = undefined; });
    watcher.unref();
    watcher.channel?.unref();
  }
  if (!watcher.connected) return false;
  watcher.send(pid, () => undefined);
  return true;
}
