import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('a source archive builds without Git or Git metadata', () => {
  const archive = mkdtempSync(path.join(tmpdir(), 'dictate-source-archive-'));
  try {
    for (const name of ['build.mjs', 'package.json', 'src']) cpSync(name, path.join(archive, name), { recursive: true });
    mkdirSync(path.join(archive, 'qa'));
    cpSync('qa/prepare-native.mjs', path.join(archive, 'qa/prepare-native.mjs'));
    symlinkSync(path.resolve('node_modules'), path.join(archive, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = spawnSync(process.execPath, ['build.mjs'], { cwd: archive, env: { ...process.env, PATH: '' }, encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(path.join(archive, 'out/main/main.js')));
    assert.match(readFileSync(path.join(archive, 'out/bridge/dictate-cli.js'), 'utf8'), /source-archive/);
  } finally {
    rmSync(archive, { recursive: true, force: true });
  }
});
