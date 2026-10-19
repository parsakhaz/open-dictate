import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const ownStat = readFileSync('/proc/self/stat', 'utf8');
      if (Number(ownStat.split(' ')[0]) === process.pid && /\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false;
    }
    return true;
  } catch { return false; }
}

describe.skipIf(process.platform === 'win32')('native cleanup process lifetime', () => {
  it('terminates enrolled cleanup when the app is killed abruptly', async () => {
    const modulePath = path.resolve('src/native/posix-lifetime.ts');
    const script = `
      const { spawn } = await import('node:child_process');
      const { pathToFileURL } = await import('node:url');
      const { guardProcess } = await import(pathToFileURL(${JSON.stringify(modulePath)}).href);
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      guardProcess(child.pid);
      console.log(child.pid);
      setInterval(() => {}, 1000);
    `;
    const parent = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let childPid = 0;
    try {
      const [data] = await once(parent.stdout, 'data');
      childPid = Number(String(data).trim());
      expect(childPid).toBeGreaterThan(1);
      expect(running(childPid)).toBe(true);
      parent.kill('SIGKILL');
      for (let i = 0; i < 40 && running(childPid); i++) await sleep(50);
      expect(running(childPid)).toBe(false);
    } finally {
      parent.kill('SIGKILL');
      if (childPid && running(childPid)) process.kill(childPid, 'SIGKILL');
    }
  }, 10_000);
});
