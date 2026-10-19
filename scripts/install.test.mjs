import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const installer = resolve('scripts/install.sh');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dictate-installer-'));
  const release = join(root, 'release with spaces'); mkdirSync(release);
  const bins = join(root, 'bin $value "quotes"');
  const data = join(root, 'data with spaces');
  const name = `Dictate-0.1.0-linux-${process.arch}.AppImage`;
  const payload = '#!/usr/bin/env bash\nprintf "fixture app: %s\\n" "$1"\n';
  writeFileSync(join(release, name), payload);
  const digest = createHash('sha256').update(payload).digest('hex');
  writeFileSync(join(release, 'SHA256SUMS'), `${digest}  ${name}\n`);
  const env = { ...process.env, DICTATE_BIN_DIR: bins, XDG_DATA_HOME: data };
  return { root, release, bins, data, name, env };
}
const linux = process.platform !== 'linux';
test('Linux user install verifies checksum and preserves arguments through paths with spaces and shell characters', { skip: linux }, () => {
  const f = fixture();
  try {
    const result = spawnSync('bash', [installer, '--version', '0.1.0', '--from', f.release], { env: f.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const launched = spawnSync(join(f.bins, 'dictate'), ['words with spaces'], { encoding: 'utf8' });
    assert.equal(launched.status, 0, launched.stderr);
    assert.equal(launched.stdout, 'fixture app: words with spaces\n');
    assert.match(readFileSync(join(f.data, 'applications/org.dictate.Dictate.desktop'), 'utf8'), /StartupWMClass=org.dictate.Dictate/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('tampered release is rejected before the existing installation changes', { skip: linux }, () => {
  const f = fixture();
  try {
    mkdirSync(f.bins); writeFileSync(join(f.bins, 'dictate'), 'previous installation');
    writeFileSync(join(f.release, f.name), 'tampered artifact');
    const result = spawnSync('bash', [installer, '--version', '0.1.0', '--from', f.release], { env: f.env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Checksum mismatch/);
    assert.equal(readFileSync(join(f.bins, 'dictate'), 'utf8'), 'previous installation');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('installer rejects malformed versions before fetching or installing anything', { skip: process.platform === 'win32' }, () => {
  const result = spawnSync('bash', [installer, '--version', '../arbitrary'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Version must be X.Y.Z/);
});
