// Run after dependency installation: node qa/native-smoke.mjs --report tmp/native-smoke.json
// Linux needs an X11 session (CI: xvfb-run -a node qa/native-smoke.mjs). No microphone/models are used.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import electron from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const reportArg = args.indexOf('--report');
const report = path.resolve(root, reportArg >= 0 ? args[reportArg + 1] : 'tmp/verify/native-adapters/report.json');
const output = path.join(root, 'out', 'qa');
fs.mkdirSync(path.dirname(report), { recursive: true });
fs.mkdirSync(output, { recursive: true });
await build({
  entryPoints: { 'native-smoke': path.join(root, 'qa/native-smoke.ts'), 'keyhook-worker': path.join(root, 'src/native/keyhook-worker.ts') },
  outdir: output, outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', target: 'node24',
  external: ['electron', 'koffi', 'uiohook-napi'],
});

const child = spawn(electron, ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', path.join(output, 'native-smoke.cjs')], {
  cwd: root, env: { ...process.env, DICTATE_NATIVE_QA_REPORT: report, DICTATE_NATIVE_QA_HOOK: path.join(output, 'keyhook-worker.cjs') },
  stdio: 'inherit',
});
const timer = setTimeout(() => { console.error('Native input smoke timed out'); child.kill('SIGKILL'); }, 25_000);
const code = await new Promise((resolve) => {
  child.once('error', (error) => { console.error(error); resolve(1); });
  child.once('exit', (status) => resolve(status ?? 1));
});
clearTimeout(timer);
console.log(`Native input report: ${report}`);
// Hosted macOS runners cannot grant TCC. Preserve a clearly blocked report while permitting that CI job
// to continue collecting install/build evidence. Never relabel the native input check as a pass.
const allowedBlock = process.platform === 'darwin' && code === 2 && args.includes('--allow-permission-block');
process.exitCode = allowedBlock ? 0 : code;
