import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';

const directory = mkdtempSync(join(tmpdir(), 'dictate-cleanup-selection-'));
let cleanupAssetsFor;
try {
  const file = join(directory, 'setup.cjs');
  await build({ entryPoints: ['src/main/setup.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: file, logLevel: 'warning' });
  ({ cleanupAssetsFor } = createRequire(import.meta.url)(file));
} finally { rmSync(directory, { recursive: true, force: true }); }

test('normal cleanup setup still installs both production models by default', () => {
  assert.deepEqual(cleanupAssetsFor().map(asset => asset.name), ['Emberon-2-Q4_K_M.gguf', 'gemma-4-E2B-it-Q4_K_M.gguf']);
});

test('cleanup setup can select the small production model without downloading Gemma', () => {
  assert.deepEqual(cleanupAssetsFor(['emberon']).map(asset => asset.name), ['Emberon-2-Q4_K_M.gguf']);
});

test('cleanup setup rejects an empty or unknown model selection', () => {
  assert.throws(() => cleanupAssetsFor([]), /at least one cleanup model/);
  assert.throws(() => cleanupAssetsFor(['unknown']), /Unknown cleanup model/);
});
