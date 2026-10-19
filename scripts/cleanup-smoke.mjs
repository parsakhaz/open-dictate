// Native cleanup proof reuses production download/hash/extraction and the actual LlamaServer lifecycle.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (key, fallback) => { const index = args.indexOf(key); return index < 0 ? fallback : args[index + 1]; };
const bundle = fs.mkdtempSync(path.join(tmpdir(), 'dictate-cleanup-proof-'));
const root = path.resolve(import.meta.dirname, '..');
const reportPath = path.resolve(option('--report', path.join(root, 'tmp/package-smoke/cleanup.json')));
const cache = path.resolve(option('--cache-dir', process.env.DICTATE_CLEANUP_DIR || path.join(root, 'tmp/cleanup-cache')));
const lines = [];
const report = { ok: false, platform: process.platform, arch: process.arch, proof: 'native production cleanup setup, health, completion and process teardown' };
let server;
const adopted = new Set();
const log = (level, message) => { const line = `${new Date().toISOString()} ${level} ${message}`; lines.push(line); console.log(line); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function stopped() {
  const deadline = Date.now() + 10_000;
  while ([...adopted].some(alive)) {
    if (Date.now() > deadline) throw new Error(`llama-server remained alive after stop(): ${[...adopted].filter(alive).join(', ')}`);
    await pause(50);
  }
}
async function fingerprint(file) {
  const hash = createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return { bytes: fs.statSync(file).size, sha256: hash.digest('hex') };
}
async function filesIn(directory, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(file, relative));
    else {
      // Production setup must leave usable files after its temporary extraction directory is deleted.
      if (!entry.isFile()) throw new Error(`Installed runtime retained a symbolic link or special file: ${file}`);
      files.push({ path: relative, ...await fingerprint(file) });
    }
  }
  return files;
}
async function cachedInstallation(markerPath, key, model, modelPath, bin) {
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (marker.schema !== 1 || marker.key !== key) return undefined;
    const actualModel = await fingerprint(modelPath);
    if (actualModel.bytes !== model.bytes || actualModel.sha256 !== model.sha256) return undefined;
    if (!Array.isArray(marker.files) || !marker.files.length) return undefined;
    const files = await filesIn(bin);
    if (JSON.stringify(files) !== JSON.stringify(marker.files)) return undefined;
    return marker;
  } catch { return undefined; }
}
try {
  await build({
    entryPoints: { setup: 'src/main/setup.ts', llama: 'src/engine/llama.ts', prompt: 'src/core/templating.ts' },
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', outdir: bundle, outExtension: { '.js': '.cjs' }, logLevel: 'warning',
  });
  const require = createRequire(import.meta.url);
  const { SetupManager, cleanupAssetsFor, llamaAssetFor } = require(path.join(bundle, 'setup.cjs'));
  const { LlamaServer } = require(path.join(bundle, 'llama.cjs'));
  const { EMBERON_SYSTEM, chatRequest, plainText } = require(path.join(bundle, 'prompt.cjs'));
  const model = cleanupAssetsFor(['emberon'])[0];
  const runtime = llamaAssetFor(process.platform, process.arch);
  // Include the installer implementation so a repaired installation is not hidden by an older cache.
  const key = createHash('sha256').update(JSON.stringify({ model, runtime })).update(fs.readFileSync(path.join(root, 'src/main/setup.ts'))).digest('hex');
  if (args.includes('--key')) {
    console.log(`sha256=${key}`);
  } else {
    const models = path.join(cache, 'models');
    const bin = path.join(cache, 'bin');
    const modelPath = path.join(models, model.name);
    const executable = path.join(bin, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
    const markerPath = path.join(cache, 'installation.json');
    report.assets = { model, runtime };
    report.cacheKey = key;
    report.paths = { models, bin, executable };
    let marker = await cachedInstallation(markerPath, key, model, modelPath, bin);
    report.cacheHit = !!marker;
    if (!marker) {
      const installer = new SetupManager();
      let previous = '';
      installer.onChange = () => {
        const state = `${installer.state.phase} ${installer.state.file ?? ''}`;
        if (state !== previous) { log('info', `production setup: ${state}`); previous = state; }
      };
      await installer.install('cleanup', { modelsDir: models, binDir: bin, platform: process.platform, arch: process.arch, cleanupModels: ['emberon'] });
      const actualModel = await fingerprint(modelPath);
      if (actualModel.bytes !== model.bytes || actualModel.sha256 !== model.sha256) throw new Error('Installed cleanup model does not match the production manifest');
      marker = { schema: 1, key, model: actualModel, files: await filesIn(bin) };
      fs.mkdirSync(cache, { recursive: true });
      fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
    }
    if (!fs.statSync(executable).isFile()) throw new Error(`Production setup did not install ${executable}`);
    const version = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    if (version.error || version.status !== 0) throw new Error(`Native llama-server --version failed (${version.status}): ${version.error?.message ?? ''}\n${version.stdout}\n${version.stderr}`);
    report.serverVersion = `${version.stdout ?? ''}\n${version.stderr ?? ''}`.trim();
    report.installedModel = marker.model;
    report.installedRuntime = marker.files;
    log('info', `native llama-server version: ${report.serverVersion}`);
    server = new LlamaServer('native-cleanup-proof', { exe: executable, gguf: modelPath, log, adopt: pid => adopted.add(pid) });
    const start = performance.now();
    await server.start();
    report.startMs = Math.round(performance.now() - start);
    if (server.state !== 'ready' || !server.pid) throw new Error('LlamaServer did not become healthy with a real native process');
    report.pid = server.pid;
    const input = 'so um hello world';
    const completionStart = performance.now();
    const output = plainText(await server.complete(chatRequest(EMBERON_SYSTEM, input), AbortSignal.timeout(60_000)));
    report.completionMs = Math.round(performance.now() - completionStart);
    report.input = input;
    report.output = output;
    if (!/\bhello\b/i.test(output) || !/\bworld\b/i.test(output)) throw new Error(`Native cleanup returned an unexpected completion: ${JSON.stringify(output)}`);
    server.stop();
    await stopped();
    report.stopped = true;
    report.ok = true;
    log('info', `PASS native cleanup (${process.platform}/${process.arch}): ${JSON.stringify(output)}; server process stopped`);
  }
} catch (error) {
  report.error = error.stack ?? String(error);
  log('error', report.error);
  process.exitCode = 1;
} finally {
  server?.stop();
  try { await stopped(); }
  catch (error) {
    report.ok = false;
    report.teardownError = error.stack ?? String(error);
    process.exitCode = 1;
    for (const pid of adopted) { try { if (alive(pid)) process.kill(pid, 'SIGKILL'); } catch {} }
  }
  if (!args.includes('--key')) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(`${reportPath}.log`, `${lines.join('\n')}\n`);
  }
  fs.rmSync(bundle, { recursive: true, force: true });
}
