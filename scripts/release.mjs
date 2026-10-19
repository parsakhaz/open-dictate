// Release gates and checksum generation are deliberately independent of package publishing tools.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
const [command, ...args] = process.argv.slice(2);
function validate(tag) {
  if (!/^dictate-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag ?? '')) {
    throw new Error('Release tag must have the form dictate-vX.Y.Z');
  }
  if (tag !== `dictate-v${version}`) throw new Error(`Release tag ${tag} does not match package version ${version}`);
  return tag;
}
function checksums(dir) {
  const entries = readdirSync(dir, { withFileTypes: true }).filter(f => f.isFile() && (/\.(?:exe|dmg|zip|deb|AppImage)$/.test(f.name) || ['install.sh', 'install.ps1'].includes(f.name))).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  if (!entries.length) throw new Error('No release files to checksum');
  const lines = entries.map(f => `${createHash('sha256').update(readFileSync(join(dir, f.name))).digest('hex')}  ${f.name}`);
  writeFileSync(join(dir, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}
function collect(source, destination) {
  const required = [
    `Dictate-${version}-windows-x64-setup.exe`,
    ...['x64', 'arm64'].flatMap(arch => [
      `Dictate-${version}-macos-${arch}.zip`, `Dictate-${version}-macos-${arch}.dmg`,
      `Dictate-${version}-linux-${arch}.AppImage`, `Dictate-${version}-linux-${arch}.deb`,
    ]),
    // Auto-update metadata (C6): Windows and the AppImages update themselves; Macs and .debs are only told.
    'latest.yml', `Dictate-${version}-windows-x64-setup.exe.blockmap`, 'latest-linux.yml', 'latest-linux-arm64.yml',
  ];
  const found = new Map();
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && required.includes(entry.name)) {
        if (found.has(entry.name)) throw new Error(`Duplicate release artifact: ${entry.name}`);
        found.set(entry.name, path);
      }
    }
  }
  walk(source);
  const missing = required.filter(name => !found.has(name));
  if (missing.length) throw new Error(`Missing release artifacts: ${missing.join(', ')}`);
  mkdirSync(destination, { recursive: true });
  if (readdirSync(destination).length) throw new Error('Release destination must be empty');
  for (const [name, path] of found) copyFileSync(path, join(destination, name));
  for (const name of ['install.sh', 'install.ps1']) copyFileSync(new URL(name, import.meta.url), join(destination, name));
  checksums(destination);
  console.log(`Collected ${found.size} native artifacts and both installers into ${resolve(destination)}`);
}
try {
  if (command === 'validate') console.log(validate(args[0] ?? process.env.GITHUB_REF?.replace(/^refs\/tags\//, '')));
  else if (command === 'plan') {
    const ref = process.env.GITHUB_REF ?? '';
    const event = process.env.GITHUB_EVENT_NAME ?? '';
    const tagged = ref.startsWith('refs/tags/dictate-v');
    const manualPublish = event === 'workflow_dispatch' && process.env.DICTATE_PUBLISH === 'true';
    if (manualPublish && !tagged) throw new Error('Manual publishing requires running the workflow on a Dictate version tag');
    const tag = tagged ? validate(ref.slice('refs/tags/'.length)) : '';
    const publish = tagged && (event === 'push' || manualPublish);
    console.log(`publish=${publish}\ntag=${tag}\nversion=${version}`);
  } else if (command === 'stage') {
    const dir = args[0] ?? 'dist';
    for (const name of ['install.sh', 'install.ps1']) copyFileSync(new URL(name, import.meta.url), join(dir, name));
    checksums(dir);
  }
  else if (command === 'checksums') checksums(args[0] ?? 'dist');
  else if (command === 'collect' && args.length === 2) collect(args[0], args[1]);
  else throw new Error(`Usage: ${basename(process.argv[1])} plan | validate [dictate-vX.Y.Z] | checksums [directory] | collect <artifacts> <destination>`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
