import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const script = resolve('scripts/release.mjs');
function run(args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_REF: '', GITHUB_EVENT_NAME: '', DICTATE_PUBLISH: '', ...env } });
}

test('ordinary PR and branch builds cannot publish a release', () => {
  const result = run(['plan'], { GITHUB_REF: 'refs/heads/dictate', GITHUB_EVENT_NAME: 'push' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /publish=false/);
});

test('a release tag must match the packaged version', () => {
  const result = run(['validate', 'dictate-v99.0.0']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match package version/);
});

test('only a well-formed Dictate version tag is accepted', () => {
  for (const tag of ['v0.1.0', 'dictate-v0.1.0/unsafe', 'dictate-v0.1.0-beta']) {
    const result = run(['validate', tag]);
    assert.notEqual(result.status, 0, tag);
    assert.match(result.stderr, /dictate-vX.Y.Z/);
  }
});

test('matching version tags publish while manual branch publishing fails closed', () => {
  const version = JSON.parse(readFileSync('package.json')).version;
  const result = run(['plan'], { GITHUB_REF: `refs/tags/dictate-v${version}`, GITHUB_EVENT_NAME: 'push' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /publish=true/);
  const rejected = run(['plan'], { GITHUB_REF: 'refs/heads/dictate', GITHUB_EVENT_NAME: 'workflow_dispatch', DICTATE_PUBLISH: 'true' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /version tag/);
});

test('checksums cover each release file and match independent SHA-256 known values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dictate-checksums-'));
  try {
    writeFileSync(join(dir, 'example.AppImage'), 'abc');
    const result = run(['checksums', dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(dir, 'SHA256SUMS'), 'utf8'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  example.AppImage\n');
    assert.equal(run(['checksums', dir]).status, 0);
    assert.equal(readFileSync(join(dir, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('release assembly rejects missing platforms before any release is created', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dictate-collect-'));
  try {
    mkdirSync(join(dir, 'artifacts'));
    const result = run(['collect', join(dir, 'artifacts'), join(dir, 'release')]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing release artifacts/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('complete native artifacts assemble once with installers and an aggregate checksum manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dictate-collect-complete-'));
  const version = JSON.parse(readFileSync('package.json')).version;
  const names = [
    `Dictate-${version}-windows-x64-setup.exe`,
    `Dictate-${version}-macos-x64.zip`, `Dictate-${version}-macos-x64.dmg`,
    `Dictate-${version}-macos-arm64.zip`, `Dictate-${version}-macos-arm64.dmg`,
    `Dictate-${version}-linux-x64.AppImage`, `Dictate-${version}-linux-x64.deb`,
    `Dictate-${version}-linux-arm64.AppImage`, `Dictate-${version}-linux-arm64.deb`,
  ];
  try {
    const source = join(dir, 'artifacts'); mkdirSync(source);
    for (const name of names) writeFileSync(join(source, name), 'abc');
    const destination = join(dir, 'release');
    const result = run(['collect', source, destination]);
    assert.equal(result.status, 0, result.stderr);
    const manifest = readFileSync(join(destination, 'SHA256SUMS'), 'utf8');
    assert.equal(manifest.trim().split('\n').length, 11);
    assert.match(manifest, /  install\.sh\n/);
    assert.match(manifest, /  install\.ps1\n/);
    assert.equal(readFileSync(join(destination, names[0]), 'utf8'), 'abc');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
