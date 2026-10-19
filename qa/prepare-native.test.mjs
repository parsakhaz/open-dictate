import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { nativeBinaryMetadata } from './prepare-native.mjs';

const require = createRequire(import.meta.url);
const prebuilds = path.join(path.dirname(require.resolve('uiohook-napi/package.json')), 'prebuilds');

test('native architecture validation reads executable headers instead of trusting folder names', () => {
  for (const [folder, format, arch] of [
    ['linux-x64', 'elf', 'x64'], ['darwin-x64', 'macho', 'x64'], ['darwin-arm64', 'macho', 'arm64'],
    ['win32-x64', 'pe', 'x64'], ['win32-arm64', 'pe', 'arm64'],
  ]) {
    assert.deepEqual(nativeBinaryMetadata(fs.readFileSync(path.join(prebuilds, folder, 'uiohook-napi.node'))), { format, architectures: [arch] });
  }
  // ELF specification e_machine values: 183 = AArch64; 62 = AMD64, regardless of the filename.
  assert.deepEqual(nativeBinaryMetadata(Buffer.from('7f454c460201010000000000000000000300b700', 'hex')), { format: 'elf', architectures: ['arm64'] });
  assert.deepEqual(nativeBinaryMetadata(Buffer.from('7f454c4602010100000000000000000003003e00', 'hex')), { format: 'elf', architectures: ['x64'] });
  assert.throws(() => nativeBinaryMetadata(Buffer.alloc(8)), /truncated/);
});
