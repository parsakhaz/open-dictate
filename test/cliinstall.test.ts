import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { installCli } from '../src/main/cliinstall';

it.skipIf(process.platform !== 'win32')('runs the installed shim outside a checkout with Unicode/spaces, no Node on PATH and the child exit code', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dictate shim 雪 & !-'));
  const appRoot = path.join(root, 'app');
  const profile = path.join(root, 'profile space 雪');
  const oldEnv = process.env.ELECTRON_RUN_AS_NODE;
  try {
    fs.mkdirSync(path.join(appRoot, 'out', 'bridge'), { recursive: true });
    fs.writeFileSync(
      path.join(appRoot, 'out', 'bridge', 'dictate-cli.js'),
      'process.stdout.write(JSON.stringify({args:process.argv.slice(2),node:process.env.ELECTRON_RUN_AS_NODE}));process.exitCode=7;',
    );
    const executable = path.join(root, 'runtime 雪.exe');
    fs.copyFileSync(process.execPath, executable);
    const shim = installCli(appRoot, profile, executable);
    const arg = path.join(root, 'input $ ` 雪.json');
    const result = spawnSync(process.env.ComSpec!, ['/d', '/s', '/c', '""%_DICTATE_TEST_SHIM%" --from-json "%_DICTATE_TEST_ARG%""'], {
      cwd: os.tmpdir(),
      windowsVerbatimArguments: true,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${process.env.SystemRoot}\\System32`, _DICTATE_TEST_SHIM: shim, _DICTATE_TEST_ARG: arg },
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(7);
    expect(JSON.parse(result.stdout)).toEqual({ args: ['--from-json', arg], node: '1' });
    expect(process.env.ELECTRON_RUN_AS_NODE).toBe(oldEnv);
    expect(fs.readdirSync(profile)).toEqual(['agents']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
