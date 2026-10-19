// Screenshots of the real settings window, off-screen, with a made-up state: no tray, no keyboard hook, no models,
// so it is safe to run while dictate itself is running. Writes tmp/settings-shots/<name>.png.
//   pnpm build && node_modules\electron\dist\electron.exe qa/settingsshots.js [page ...] [--set={"json":"patch"}]
// Pages are the sidebar labels (default: "Hotkeys & output"). Each shot is 900 px wide and as tall as the page.
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { buildSync } = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tmp', 'settings-shots');
const args = process.argv.slice(2);
const pages = args.filter((a) => !a.startsWith('--') && a !== '.' && !a.endsWith('.js'));
const patch = JSON.parse((args.find((a) => a.startsWith('--set=')) ?? '--set={}').slice(6));

/** The app's own defaults, bundled from source so the shots never drift from them. */
function load(entry) {
  const code = buildSync({ entryPoints: [path.join(ROOT, entry)], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
  const m = { exports: {} };
  new Function('module', 'exports', 'require', code)(m, m.exports, require);
  return m.exports;
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const { defaultSettings } = load('src/core/settings.ts');
  const { bindingLabel } = load('src/core/hotkeys.ts');
  let settings = { ...defaultSettings([{ term: 'Kubernetes' }]), onboarded: true, ...patch };
  const state = () => ({
    settings,
    labels: { hotkey: bindingLabel(settings.hotkeys[0] ?? null), hotkeys: settings.hotkeys.map((b) => bindingLabel(b)), toggle: bindingLabel(settings.toggle), picker: bindingLabel(settings.picker) },
    devices: [{ deviceId: 'amd', groupId: 'g', label: 'Microphone Array (AMD Audio Device)' }],
    mic: null,
    defaultMicLabel: 'Microphone Array (AMD Audio Device)',
    gain: 30,
    micBluetooth: false,
    stt: 'ready',
    sttError: '',
    servers: { gemma: 'ready', emberon: 'ready' },
    effectiveChain: settings.cleanup,
    onBattery: false,
    missing: [],
    history: { count: 12, samples: 12, median: 718 },
    logFile: 'dictate.log',
    version: '0.1.0',
    platform: { platform: process.platform, displayServer: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'macos' : 'x11', globalHotkeys: true, canSwallowKeys: process.platform === 'win32', automaticPaste: true, accessibilityRequired: process.platform === 'darwin', accessibilityGranted: true },
    microphonePermission: 'granted',
    setup: {phase:'idle'}, speechInstalled:true, shortcutRegistered:false, startupError:'', recording:false, automation:true,
  });
  ipcMain.handle('dictate:get-state', () => state());
  ipcMain.handle('dictate:set-settings', (_e, p) => {
    settings = { ...settings, ...p };
    return state();
  });
  ipcMain.handle('dictate:record-binding', () => null);
  ipcMain.on('dictate:renderer-error', (_e, page, msg) => console.error(`renderer ${page}: ${msg}`));

  const w = new BrowserWindow({ width: 900, height: 680, show: false, backgroundColor: '#202020', webPreferences: { preload: path.join(ROOT, 'out', 'main', 'preload.js'), offscreen: true, contextIsolation: true, sandbox: false } });
  await w.loadFile(path.join(ROOT, 'out', 'renderer', 'settings.html'));
  fs.mkdirSync(OUT, { recursive: true });
  for (const label of pages.length ? pages : ['Hotkeys & output']) {
    const height = await w.webContents.executeJavaScript(`(async () => {
      const b = [...document.querySelectorAll('nav *')].find((e) => e.textContent.trim() === ${JSON.stringify(label)} && e.onclick !== undefined);
      b?.click();
      await new Promise((r) => setTimeout(r, 300));
      const c = document.querySelector('main.content');
      return Math.max(680, (c?.scrollHeight ?? 0) + 60);
    })()`);
    w.setContentSize(900, Math.min(4000, height));
    await new Promise((r) => setTimeout(r, 400));
    const img = await w.webContents.capturePage();
    const file = path.join(OUT, `${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`);
    fs.writeFileSync(file, img.toPNG());
    console.log(file);
  }
  app.quit();
});
