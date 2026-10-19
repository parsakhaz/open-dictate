// Real first-run download and speed check, headless: node qa/first-run.mjs [--dir <folder>] [--report <json>] [--skip-download]
// Downloads about 0.7 GB from the pinned official sources into a fresh folder (or --dir), cutting the
// connection's progress at 30% of the first file and resuming it, refuses a simulated full disk, then times
// Emberon (and Gemma → Emberon if Gemma is in that folder) on this computer. Writes the report as JSON.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const out = path.join(root, 'out/qa/first-run.cjs');
await build({ entryPoints: [path.join(root, 'qa/first-run.ts')], outfile: out, bundle: true, platform: 'node', format: 'cjs', target: 'node24' });
const env = { ...process.env, DICTATE_QA_ROOT: root };
if (value('--dir')) { env.DICTATE_QA_DIR = path.resolve(value('--dir')); fs.mkdirSync(env.DICTATE_QA_DIR, { recursive: true }); }
if (value('--report')) env.DICTATE_QA_REPORT = path.resolve(value('--report'));
if (args.includes('--skip-download')) env.DICTATE_QA_SKIP_DOWNLOAD = '1';
process.exit(spawnSync(process.execPath, [out], { env, stdio: 'inherit' }).status ?? 1);
