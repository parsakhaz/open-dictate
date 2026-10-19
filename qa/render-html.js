// Renders a local HTML page to a PNG, off-screen, for composed README and PR images (no desktop, no app state).
//   node_modules\electron\dist\electron.exe qa/render-html.js <page.html> <out.png> [--width=1600] [--scale=2]
// The page sets its own size: the shot is --width wide and as tall as the document.
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const args = process.argv.slice(2).filter((a) => a !== '.' && !a.endsWith('render-html.js'));
const [input, output] = args.filter((a) => !a.startsWith('--'));
const opt = (name, d) => Number((args.find((a) => a.startsWith(`--${name}=`)) ?? '').split('=')[1]) || d;
const width = opt('width', 1600);
const scale = opt('scale', 2);

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: width * scale, height: 800 * scale, show: false, webPreferences: { offscreen: true } });
  w.webContents.on('did-finish-load', () => w.webContents.setZoomFactor(scale));
  await w.loadFile(path.resolve(input));
  // Images and fonts settle before measuring.
  await w.webContents.executeJavaScript('Promise.all([...document.images].map((i) => i.decode().catch(() => {}))).then(() => document.fonts.ready)');
  await new Promise((r) => setTimeout(r, 300));
  const height = await w.webContents.executeJavaScript('Math.ceil(document.documentElement.scrollHeight)');
  w.setContentSize(width * scale, height * scale);
  await new Promise((r) => setTimeout(r, 400));
  const img = await w.webContents.capturePage();
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, img.toPNG());
  console.log(path.resolve(output), `${img.getSize().width}x${img.getSize().height}`);
  app.quit();
});
