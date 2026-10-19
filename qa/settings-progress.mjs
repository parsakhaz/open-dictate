// Actual production renderer/preload regression: progress preserves controls and uncommitted edits.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import electron from 'electron';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const i = args.indexOf('--report');
const report = path.resolve(i < 0 ? path.join(root, 'tmp/package-smoke/settings-progress.json') : args[i + 1]);
const output = path.join(root, 'out/qa/settings-progress');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dictate-settings-qa-'));
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(path.dirname(report), { recursive: true });
await Promise.all([
  build({ entryPoints: { fixture: path.join(root, 'qa/settings-progress.ts'), preload: path.join(root, 'src/main/preload.ts') }, outdir: output, outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'] }),
  build({ entryPoints: [path.join(root, 'src/renderer/settings.ts')], outfile: path.join(output, 'settings.js'), bundle: true, platform: 'browser', format: 'esm', target: 'chrome140' }),
]);
for (const file of ['settings.html', 'settings.css', 'theme.css']) fs.copyFileSync(path.join(root, 'src/renderer', file), path.join(output, file));
const argv = ['--disable-gpu', path.join(output, 'fixture.cjs')];
if (process.env.DICTATE_SMOKE_NO_SANDBOX === '1' && process.platform === 'linux') argv.unshift('--no-sandbox');
const env = { ...process.env, DICTATE_SETTINGS_QA_REPORT: report, DICTATE_SETTINGS_QA_PROFILE: profile };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, argv, { env, stdio: 'inherit' });
// The walkthrough steps added time; a busy macOS runner needed more than 30 s.
const timeout = setTimeout(() => { console.error('Settings progress regression timed out'); child.kill('SIGKILL'); }, 60_000);
const code = await new Promise(resolve => {
  child.once('error', error => { console.error(error); resolve(1); });
  child.once('exit', status => resolve(status ?? 1));
});
clearTimeout(timeout);
fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
if (fs.existsSync(report)) console.log(fs.readFileSync(report, 'utf8'));
process.exitCode = code;
