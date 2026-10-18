// Bundles every process with esbuild into out/. Native modules and electron stay external.
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const common = { bundle: true, sourcemap: true, logLevel: 'warning', target: 'node24' };
const node = { ...common, platform: 'node', format: 'cjs', external: ['electron', 'sherpa-onnx-node', 'koffi'] };

mkdirSync('out/renderer', { recursive: true });
await Promise.all([
  build({ ...node, entryPoints: { 'main/main': 'src/main/main.ts', 'main/preload': 'src/main/preload.ts' }, outdir: 'out' }),
  build({ ...node, entryPoints: { 'engine/stt-worker': 'src/engine/stt-worker.ts', 'native/keyhook': 'src/native/keyhook-worker.ts', 'native/mic': 'src/native/mic-worker.ts' }, outdir: 'out' }),
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
