// Real recognizer partials and cleanup for a WAV, as JSON: node qa/fixture-timeline.mjs --out <json> [--wav <file>]
// Needs DICTATE_MODELS_DIR (and DICTATE_LLAMA_SERVER for the cleanup). Used to drive the README demo truthfully.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const out = path.join(root, 'out/qa/fixture-timeline.cjs');
await build({ entryPoints: [path.join(root, 'qa/fixture-timeline.ts')], outfile: out, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['sherpa-onnx-node'] });
const env = { ...process.env, DICTATE_QA_ROOT: root };
if (value('--out')) env.DICTATE_QA_REPORT = path.resolve(value('--out'));
if (value('--wav')) env.DICTATE_QA_WAV = path.resolve(value('--wav'));
process.exit(spawnSync(process.execPath, [out], { env, stdio: 'inherit', cwd: root }).status ?? 1);
