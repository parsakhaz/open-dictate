// Composes, frames, optimises and encodes the README media into docs/media/ from the off-screen renders.
//   pnpm build
//   electron qa/media/media.js                        → tmp/media/{hero,picker,pill-*}.png, tmp/media/demo-frames/
//   electron qa/settingsshots.js --scale=2 --fixed --out=tmp/media/walk --walkthrough=welcome,licences,download,hardware,microphone,hotkey,try,done
//   electron qa/settingsshots.js --scale=2 --fixed --out=tmp/media/pages "Hotkeys & output" Microphone Cleanup Vocabulary History About
//   node qa/media/build.mjs
// Needs ffmpeg on PATH (palette PNGs, the MP4 and the GIF). Everything is dark, 2x, with one frame style.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const src = path.join(root, 'tmp', 'media');
const work = path.join(src, 'compose');
const out = path.join(root, 'docs', 'media');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(path.join(out, 'onboarding'), { recursive: true });
const rel = (file) => path.relative(work, file).replaceAll('\\', '/');

const STYLE = `
  * { box-sizing: border-box; }
  html { overflow: hidden; }
  body { margin: 0; color: #e9ebef; font: 15px/1.45 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
    background: radial-gradient(900px 500px at 15% 0%, rgba(64,120,255,.18), transparent 60%),
                radial-gradient(800px 500px at 100% 100%, rgba(0,190,170,.14), transparent 60%), #0d0f14; }
  .win { display: block; border-radius: 12px; box-shadow: 0 24px 60px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.08); }
  .label { color: #c9cdd4; font-size: 15px; } .label b { color: #7fd4ff; margin-right: 8px; }
  h2 { font: 600 20px "Segoe UI Variable Display", "Segoe UI", sans-serif; margin: 0 0 4px; color: #fff; }
  .sub { color: #9aa0a8; margin: 0; }`;

function page(name, width, body) {
  const file = path.join(work, `${name}.html`);
  fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><style>${STYLE} body { width: ${width}px; }</style>${body}`);
  return file;
}

/** Renders a composition at 2x, then writes a 256-colour PNG (dithered) to docs/media. */
function render(html, width, target) {
  const png = path.join(work, `${path.basename(html, '.html')}.png`);
  const r = spawnSync(electron, [path.join(root, 'qa', 'render-html.js'), html, png, `--width=${width}`, '--scale=2'], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`render failed: ${html}`);
  optimise(png, target);
}

function optimise(input, target) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', input, '-vf', 'split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a', target]);
  console.log(`${path.relative(root, target)}  ${(fs.statSync(target).size / 1024).toFixed(0)} KB`);
}

const STEPS = [
  ['welcome', 'Welcome'], ['licences', 'Models and licences'], ['download', 'Download, with resume'], ['hardware', 'Speed check'],
  ['microphone', 'Microphone'], ['hotkey', 'Dictation key'], ['try', 'Try it'], ['done', 'You are set'],
];
const PAGES = [['hotkeys-output', 'Hotkeys & output'], ['microphone', 'Microphone'], ['cleanup', 'Cleanup'], ['vocabulary', 'Vocabulary'], ['history', 'History'], ['about', 'About']];

// The hero and the picker are full scenes already: only optimised.
optimise(path.join(src, 'hero.png'), path.join(out, 'hero.png'));
optimise(path.join(src, 'picker.png'), path.join(out, 'picker.png'));

// The pill's states, top to bottom, at their real size.
const states = [
  ['starting', 'Starting', 'the mic is opening: grey, flat'],
  ['listening', 'Listening', 'the live words as you speak'],
  ['cleaning', 'Cleaning', 'after you let go'],
  ['pasted', 'Pasted', 'the text is in your app'],
];
render(
  page('pill-states', 1100, `<style>body { background: #15171c; }</style><div style="padding:40px 48px;display:grid;gap:10px">${states
    .map(([f, t, d], i) => `<div style="display:grid;grid-template-columns:260px 1fr;align-items:center"><div class="label"><b>${i + 1}</b>${t}<br><span class="sub">${d}</span></div><img src="${rel(path.join(src, `pill-${f}.png`))}" style="width:auto;height:96px;justify-self:start"></div>`)
    .join('')}</div>`),
  1100,
  path.join(out, 'pill-states.png'),
);

// Each walkthrough step framed alike; the README's Quick start uses some of them small.
STEPS.forEach(([step], i) => {
  render(page(`step-${step}`, 964, `<div style="padding:32px"><img class="win" src="${rel(path.join(src, 'walk', `walkthrough-${step}.png`))}" style="width:900px"></div>`), 964, path.join(out, 'onboarding', `${i + 1}-${step}.png`));
});
render(
  page('onboarding', 1640, `<div style="padding:40px"><h2>Getting started</h2><p class="sub" style="margin-bottom:22px">Eight steps from a fresh install to your first dictation. Reopen them any time from Settings or the tray.</p>
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:26px 22px">${STEPS.map(([step, title], i) => `<div><img class="win" src="${rel(path.join(src, 'walk', `walkthrough-${step}.png`))}" style="width:100%"><div class="label" style="margin-top:10px"><b>${i + 1}</b>${title}</div></div>`).join('')}</div></div>`),
  1640,
  path.join(out, 'onboarding.png'),
);
render(
  page('settings', 1640, `<div style="padding:40px"><h2>Settings</h2><p class="sub" style="margin-bottom:22px">Keys, microphones, cleanup, vocabulary, history and updates, all local.</p>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:26px 22px">${PAGES.map(([f, title]) => `<div><img class="win" src="${rel(path.join(src, 'pages', `${f}.png`))}" style="width:100%"><div class="label" style="margin-top:10px">${title}</div></div>`).join('')}</div></div>`),
  1640,
  path.join(out, 'settings.png'),
);

// The demo: frames at their real times, as an MP4 (H.264, small) and a GIF for places that will not play video.
const frames = path.join(src, 'demo-frames');
const { list, end } = JSON.parse(fs.readFileSync(path.join(frames, 'frames.json'), 'utf8'));
const concat = list.map((f, i) => `file '${f.file}'\nduration ${((list[i + 1]?.t ?? end) - f.t).toFixed(3)}`).join('\n') + `\nfile '${list.at(-1).file}'\n`;
fs.writeFileSync(path.join(frames, 'concat.txt'), concat);
const input = ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(frames, 'concat.txt')];
execFileSync('ffmpeg', [...input, '-vf', 'fps=30,scale=1280:-2:flags=lanczos', '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(out, 'demo.mp4')]);
execFileSync('ffmpeg', [...input, '-vf', 'fps=15,scale=960:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', path.join(out, 'demo.gif')]);
for (const f of ['demo.mp4', 'demo.gif']) console.log(`docs/media/${f}  ${(fs.statSync(path.join(out, f)).size / 1024).toFixed(0)} KB`);
