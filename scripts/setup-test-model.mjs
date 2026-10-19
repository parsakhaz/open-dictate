// Native CI exercises the production downloader (and its size/SHA-256 checks), never a second manifest.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const temp = mkdtempSync(join(tmpdir(), 'dictate-ci-model-'));
try {
  const file = join(temp, 'setup.cjs');
  await build({ entryPoints: ['src/main/setup.ts'], bundle: true, platform: 'node', target: 'node24', format: 'cjs', outfile: file, logLevel: 'warning' });
  const { SetupManager, speechInstalled } = createRequire(import.meta.url)(file);
  const manifest = join(temp, 'manifest.cjs');
  await build({ entryPoints: ['src/main/downloads.ts'], bundle: true, platform: 'node', target: 'node24', format: 'cjs', outfile: manifest, logLevel: 'warning' });
  const { SPEECH_ASSET } = createRequire(import.meta.url)(manifest);
  if (process.argv.includes('--key')) {
    console.log(`sha256=${SPEECH_ASSET.sha256}`);
  } else {
    if (!process.env.DICTATE_MODELS_DIR) throw new Error('DICTATE_MODELS_DIR must name an isolated CI/cache directory');
    const modelsDir = resolve(process.env.DICTATE_MODELS_DIR);
    const manager = new SetupManager();
    let previous = '';
    manager.onChange = () => {
      const phase = `${manager.state.phase}: ${manager.state.file ?? ''}`;
      if (phase !== previous) { console.log(phase); previous = phase; }
    };
    await manager.install('speech', { modelsDir, binDir: join(modelsDir, 'unused-bin'), platform: process.platform, arch: process.arch });
    if (!speechInstalled(modelsDir)) throw new Error('Speech setup finished without usable model files');
    console.log(`Speech model ready: ${modelsDir}; pinned archive SHA-256 ${SPEECH_ASSET.sha256}`);
  }
} catch (error) {
  console.error(error.stack ?? error);
  process.exitCode = 1;
} finally { rmSync(temp, { recursive: true, force: true }); }
