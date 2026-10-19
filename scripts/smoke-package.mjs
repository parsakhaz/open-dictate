// Exercise the real Electron executable and its packaged renderer/native dependencies.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(name); return i < 0 ? fallback : argv[i + 1]; };
const dist = resolve(option('--dist', 'dist'));
const evidence = resolve(option('--evidence-dir', 'tmp/package-smoke'));
const modelDir = process.env.DICTATE_SMOKE_MODEL_DIR || process.env.DICTATE_MODELS_DIR;
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
const scratch = mkdtempSync(join(tmpdir(), 'dictate-package-smoke-'));
mkdirSync(evidence, { recursive: true });
function run(file, args, opts = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', ...opts });
  if (result.error || result.status !== 0) throw new Error(`${file} failed (${result.status}): ${result.error?.message ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  return result.stdout;
}
async function smoke(executable, label) {
  if (!existsSync(executable)) throw new Error(`Missing executable: ${executable}`);
  const report = join(evidence, `${label}.json`);
  rmSync(report, { force: true });
  const profile = join(scratch, label, 'profile');
  mkdirSync(profile, { recursive: true });
  // Xvfb has no hardware GPU. Software rendering makes capturePage exercise a real painted surface.
  const args = process.platform === 'linux' ? ['--disable-gpu', '--disable-dev-shm-usage'] : [];
  if (process.env.DICTATE_SMOKE_NO_SANDBOX === '1' && process.platform === 'linux') args.push('--no-sandbox');
  const env = { ...process.env, DICTATE_SMOKE_TEST: report, DICTATE_DATA_DIR: profile, DICTATE_USER_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DICTATE_MODELS_DIR;
  if (modelDir) {
    env.DICTATE_SMOKE_MODEL_DIR = resolve(modelDir);
    env.DICTATE_SMOKE_WAV = resolve(process.env.DICTATE_SMOKE_WAV || 'fixtures/two-sentences.wav');
  }
  let output = '';
  await new Promise((done, fail) => {
    const child = spawn(executable, args, { env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const append = chunk => { output = (output + chunk).slice(-100_000); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', `${child.pid}`, '/t', '/f']);
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    }, 60_000);
    child.once('error', error => { clearTimeout(timeout); fail(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      writeFileSync(join(evidence, `${label}.log`), output);
      if (timedOut || code !== 0) fail(new Error(`${label} exited ${code ?? signal}${timedOut ? ' (timeout)' : ''}\n${output}`));
      else done();
    });
  });
  if (!existsSync(report)) throw new Error(`${label}: Electron did not write a smoke report\n${output}`);
  const result = JSON.parse(readFileSync(report, 'utf8'));
  if (result.ok !== true || result.packaged !== true || result.version !== version || result.platform !== process.platform || result.arch !== process.arch || result.rendererLoaded !== true) {
    throw new Error(`${label}: startup/renderer failed: ${JSON.stringify(result)}`);
  }
  if (!existsSync(`${report}.png`)) throw new Error(`${label}: settings screenshot was not captured`);
  if (result.singleInstanceLockSkipped && process.env.DICTATE_SMOKE_SKIP_INSTANCE_LOCK !== '1') throw new Error(`${label}: single-instance lock unexpectedly skipped`);
  for (const name of ['sherpa', 'koffi', 'uiohook']) {
    if (result.native?.[name] !== true) throw new Error(`${label}: native ${name} was not loaded: ${JSON.stringify(result)}`);
  }
  if (modelDir && (typeof result.inference?.text !== 'string' || !result.inference.text || result.inference.partials < 1)) {
    throw new Error(`${label}: packaged recognizer did not transcribe the speech fixture: ${JSON.stringify(result)}`);
  }
  if (modelDir) console.log(`PASS ${label} packaged speech: ${result.inference.text}`);
  console.log(`PASS ${label}: ${result.platform}/${result.arch}, packaged renderer and sherpa/koffi/uiohook loaded`);
}
function artifact(name) {
  const path = join(dist, name);
  if (!existsSync(path)) throw new Error(`Missing artifact: ${path}`);
  return path;
}
async function installers() {
  // Test exactly the same checksum/install paths users run, isolated from the current user's apps.
  const localRelease = join(scratch, 'release');
  mkdirSync(localRelease);
  const name = process.platform === 'win32' ? `Dictate-${version}-windows-x64-setup.exe` : process.platform === 'darwin' ? `Dictate-${version}-macos-${process.arch}.zip` : `Dictate-${version}-linux-${process.arch}.AppImage`;
  const file = artifact(name);
  copyFileSync(file, join(localRelease, name));
  writeFileSync(join(localRelease, 'SHA256SUMS'), `${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${name}\n`);
  if (process.platform === 'win32') {
    const installed = join(scratch, 'Installed Dictate');
    run('pwsh', ['-NoProfile', '-File', resolve('scripts/install.ps1'), '-Version', version, '-FromDirectory', localRelease, '-InstallDirectory', installed]);
    try { await smoke(join(installed, 'Dictate.exe'), 'nsis-installed'); }
    finally {
      const uninstaller = join(installed, 'Uninstall Dictate.exe');
      if (existsSync(uninstaller)) run(uninstaller, ['/S']);
    }
  } else if (process.platform === 'darwin') {
    const apps = join(scratch, 'Applications with spaces');
    run('bash', [resolve('scripts/install.sh'), '--version', version, '--from', localRelease], { env: { ...process.env, DICTATE_APPLICATIONS_DIR: apps } });
    await smoke(join(apps, 'Dictate.app/Contents/MacOS/Dictate'), 'zip-installed');
    const mount = join(scratch, 'dmg'); mkdirSync(mount);
    run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, artifact(`Dictate-${version}-macos-${process.arch}.dmg`)]);
    try { await smoke(join(mount, 'Dictate.app/Contents/MacOS/Dictate'), 'dmg-mounted'); }
    finally { run('hdiutil', ['detach', mount]); }
  } else {
    const bins = join(scratch, 'bin with spaces');
    const data = join(scratch, 'data with spaces');
    run('bash', [resolve('scripts/install.sh'), '--version', version, '--from', localRelease], { env: { ...process.env, DICTATE_BIN_DIR: bins, XDG_DATA_HOME: data } });
    await smoke(join(bins, 'dictate'), 'appimage-installed');
    const deb = join(scratch, 'deb'); mkdirSync(deb);
    run('dpkg-deb', ['--extract', artifact(`Dictate-${version}-linux-${process.arch}.deb`), deb]);
    await smoke(join(deb, 'opt/Dictate/dictate'), 'deb-extracted');
  }
}
try {
  const defaultExecutable = process.platform === 'win32' ? join(dist, 'win-unpacked/Dictate.exe') : process.platform === 'darwin' ? join(dist, process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Dictate.app/Contents/MacOS/Dictate') : join(dist, process.arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked', 'dictate');
  await smoke(resolve(option('--executable', defaultExecutable)), option('--label', 'unpacked'));
  if (argv.includes('--installers')) await installers();
} catch (error) {
  console.error(error.stack ?? error);
  process.exitCode = 1;
} finally { rmSync(scratch, { recursive: true, force: true }); }
