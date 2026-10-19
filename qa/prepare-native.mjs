// uiohook-napi 1.5.5 ships an x86-64 ELF binary in its linux-arm64 directory. Its install-time test is a
// no-op, so validate the actual executable header, repair that native ARM build, then load it for real.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELF_ARCH = { 3: 'ia32', 62: 'x64', 183: 'arm64', 258: 'loong64' };
const PE_ARCH = { 332: 'ia32', 34404: 'x64', 43620: 'arm64' };
const MACH_ARCH = { 16777223: 'x64', 16777228: 'arm64' };

export function nativeBinaryMetadata(bytes) {
  if (bytes.length < 20) throw new Error('Native binding has a truncated executable header');
  if (bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    const machine = bytes[5] === 1 ? bytes.readUInt16LE(18) : bytes.readUInt16BE(18);
    return { format: 'elf', architectures: [ELF_ARCH[machine] ?? `machine-${machine}`] };
  }
  if (bytes.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = bytes.readUInt32LE(4);
    return { format: 'macho', architectures: [MACH_ARCH[cpu] ?? `cpu-${cpu}`] };
  }
  if (bytes.readUInt32BE(0) === 0xcafebabe) {
    const count = bytes.readUInt32BE(4);
    const architectures = [];
    for (let i = 0; i < count; i++) architectures.push(MACH_ARCH[bytes.readUInt32BE(8 + i * 20)] ?? 'unknown');
    return { format: 'macho', architectures };
  }
  if (bytes.toString('ascii', 0, 2) === 'MZ' && bytes.length >= 64) {
    const offset = bytes.readUInt32LE(60);
    if (offset + 6 <= bytes.length && bytes.toString('ascii', offset, offset + 4) === 'PE\0\0') {
      const machine = bytes.readUInt16LE(offset + 4);
      return { format: 'pe', architectures: [PE_ARCH[machine] ?? `machine-${machine}`] };
    }
  }
  throw new Error('Unrecognized native executable header');
}

function inspect(file) {
  const bytes = fs.readFileSync(file);
  return { path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...nativeBinaryMetadata(bytes) };
}

export function prepareNative(report = {}) {
  const moduleRoot = path.dirname(require.resolve('uiohook-napi/package.json'));
  const loader = require('node-gyp-build');
  const version = JSON.parse(fs.readFileSync(path.join(moduleRoot, 'package.json'), 'utf8')).version;
  const expected = { linux: 'elf', darwin: 'macho', win32: 'pe' }[process.platform];
  if (!expected) throw new Error(`Native keyboard input does not support ${process.platform}`);
  Object.assign(report, { platform: process.platform, arch: process.arch, module: `uiohook-napi@${version}`, rebuilt: false, upstreamPrebuilds: [] });
  const prebuilds = path.join(moduleRoot, 'prebuilds');
  for (const directory of fs.readdirSync(prebuilds)) {
    for (const name of fs.readdirSync(path.join(prebuilds, directory))) {
      if (name.endsWith('.node')) report.upstreamPrebuilds.push(inspect(path.join(prebuilds, directory, name)));
    }
  }
  report.before = inspect(loader.resolve(moduleRoot));
  const matchesHost = (binary) => binary.format === expected && binary.architectures.includes(process.arch);
  if (!matchesHost(report.before)) {
    console.log('Native binding mismatch:', JSON.stringify(report.before));
    if (process.platform !== 'linux' || process.arch !== 'arm64' || report.before.format !== 'elf') {
      throw new Error(`Native keyboard binding is not ${process.platform}/${process.arch}: ${JSON.stringify(report.before)}`);
    }
    if (process.env.PREBUILDS_ONLY) throw new Error('Unset PREBUILDS_ONLY: this uiohook release requires a native ARM64 source build.');
    const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js');
    const build = spawnSync(process.execPath, [nodeGyp, 'rebuild', '--release'], {
      cwd: moduleRoot, stdio: 'inherit', timeout: 180_000,
      env: { ...process.env, npm_config_arch: process.arch, npm_config_platform: process.platform },
    });
    if (build.error || build.status !== 0) {
      throw new Error(`Native ARM64 keyboard build failed (${build.status}): ${build.error?.message ?? 'Install Python, make, a C/C++ compiler, libx11-dev, libxtst-dev, libxrandr-dev and libxt-dev.'}`);
    }
    report.rebuilt = true;
  }
  report.selected = inspect(loader.resolve(moduleRoot));
  if (!matchesHost(report.selected)) throw new Error(`Native keyboard binding still has the wrong architecture: ${JSON.stringify(report.selected)}`);
  console.log('Native binding selected:', JSON.stringify(report.selected));
  if (process.platform === 'linux') {
    const linked = spawnSync('ldd', [report.selected.path], { encoding: 'utf8', timeout: 10_000 });
    report.linkedLibraries = linked.stdout || linked.stderr;
    console.log(report.linkedLibraries);
    if (linked.error || linked.status !== 0 || /not found/.test(linked.stdout)) throw new Error(`Native keyboard shared-library dependencies are unavailable: ${report.linkedLibraries}`);
  }
  // libuiohook initializes Xlib at dlopen time, even without starting its hook. Headless source installs
  // must still validate/build; the mandatory desktop QA later performs the real load under Xvfb.
  if (process.platform === 'linux' && !process.env.DISPLAY) {
    report.runtimeLoaded = false;
    report.runtimeLoadPrerequisite = 'An X11 display is required for the real libuiohook load; native input QA supplies it.';
  } else {
    const probe = spawnSync(process.execPath, ['-e', 'const m = require(process.argv[1]); if (typeof m.uIOhook?.start !== "function") process.exit(2);', moduleRoot], {
      encoding: 'utf8', timeout: 10_000, env: process.env,
    });
    if (probe.error || probe.status !== 0) throw new Error(`Real native keyboard binding load failed (${probe.status}): ${probe.error?.message ?? ''}\n${probe.stderr}`);
    report.runtimeLoaded = true;
  }
  return report;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const index = args.indexOf('--report');
  const destination = path.resolve(project, index >= 0 ? args[index + 1] : 'tmp/verify/native-build.json');
  const report = { ok: false, platform: process.platform, arch: process.arch };
  try { prepareNative(report); report.ok = true; }
  catch (error) { console.error(error.stack ?? error); report.error = error.stack ?? String(error); process.exitCode = 1; }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
}
