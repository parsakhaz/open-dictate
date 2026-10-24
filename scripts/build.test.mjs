import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

for (const nested of [false, true]) test(`a source archive builds with its own identity (${nested ? 'inside another checkout' : 'Git unavailable'})`, () => {
  const base = nested ? path.resolve('tmp') : tmpdir();
  mkdirSync(base, { recursive: true });
  const archive = mkdtempSync(path.join(base, 'dictate-source-archive-'));
  try {
    for (const name of ['build.mjs', 'package.json', 'src']) cpSync(name, path.join(archive, name), { recursive: true });
    mkdirSync(path.join(archive, 'qa'));
    cpSync('qa/prepare-native.mjs', path.join(archive, 'qa/prepare-native.mjs'));
    symlinkSync(path.resolve('node_modules'), path.join(archive, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    let searchPath = process.env.PATH;
    if (!nested) {
      mkdirSync(path.join(archive, '.git'));
      const bin = path.join(archive, 'bin');
      mkdirSync(bin);
      writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
      // Keep Linux's ldd available for native preflight; only Git is unavailable.
      searchPath = process.platform === 'win32' ? '' : bin + path.delimiter + searchPath;
    }
    const result = spawnSync(process.execPath, ['build.mjs'], { cwd: archive, env: { ...process.env, PATH: searchPath }, encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(path.join(archive, 'out/main/main.js')));
    assert.match(readFileSync(path.join(archive, 'out/bridge/dictate-cli.js'), 'utf8'), /source-archive/);
  } finally {
    rmSync(archive, { recursive: true, force: true });
  }
});
