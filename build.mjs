// Bundles every process with esbuild into out/. Native modules and electron stay external.
import { build } from 'esbuild';
import { prepareNative } from './qa/prepare-native.mjs';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

prepareNative();

const common = { bundle: true, sourcemap: true, logLevel: 'warning', target: 'node24' };
const node = { ...common, platform: 'node', format: 'cjs', external: ['electron', 'electron-updater', 'sherpa-onnx-node', 'koffi', 'uiohook-napi'] };

rmSync('out', { recursive: true, force: true });
mkdirSync('out/renderer', { recursive: true });
await Promise.all([
  build({ ...node, entryPoints: { 'main/main': 'src/main/main.ts', 'main/preload': 'src/main/preload.ts' }, outdir: 'out' }),
  build({ ...node, entryPoints: { 'engine/stt-worker': 'src/engine/stt-worker.ts', 'native/keyhook': 'src/native/keyhook-worker.ts', 'native/mic': 'src/native/mic-worker.ts' }, outdir: 'out' }),
  // The agents' MCP bridge: one self-contained file, copied out of the bundle at start-up (src/main/agents.ts).
  build({ ...node, entryPoints: { 'bridge/dictate-mcp': 'src/bridge/dictate-mcp.ts' }, outdir: 'out', sourcemap: false, define: { DICTATE_VERSION: JSON.stringify(pkg.version) } }),
  build({
    ...common,
    platform: 'browser',
    format: 'esm',
    target: 'chrome140',
    entryPoints: { pill: 'src/renderer/pill.ts', picker: 'src/renderer/picker.ts', settings: 'src/renderer/settings.ts', worklet: 'src/renderer/worklet.ts' },
    outdir: 'out/renderer',
  }),
]);
for (const f of ['pill.html', 'pill.css', 'picker.html', 'picker.css', 'settings.html', 'settings.css', 'theme.css']) cpSync(`src/renderer/${f}`, `out/renderer/${f}`);
