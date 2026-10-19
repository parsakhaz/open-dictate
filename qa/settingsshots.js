// Screenshots of the real settings window, off-screen, with a made-up state: no tray, no keyboard hook, no models,
// so it is safe to run while dictate itself is running. Writes tmp/settings-shots/<name>.png.
//   pnpm build && node_modules\electron\dist\electron.exe qa/settingsshots.js [page ...] [--set={"json":"patch"}]
// Pages are the sidebar labels (default: "Hotkeys & output"). Each shot is 900 px wide and as tall as the page.
//   ... qa/settingsshots.js --walkthrough=welcome,licences,download,download-error,disk,hardware,microphone,hotkey,try,done
// renders Getting started's steps on a fresh profile instead, one shot each (walkthrough-<step>.png).
// --scale=2 renders at twice the pixel density.
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { buildSync } = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tmp', 'settings-shots');
const args = process.argv.slice(2);
const pages = args.filter((a) => !a.startsWith('--') && a !== '.' && !a.endsWith('.js'));
const patch = JSON.parse((args.find((a) => a.startsWith('--set=')) ?? '--set={}').slice(6));
const walk = (args.find((a) => a.startsWith('--walkthrough=')) ?? '').slice(14).split(',').filter(Boolean);
const scale = Number((args.find((a) => a.startsWith('--scale=')) ?? '--scale=1').slice(8)) || 1;
// --fixed keeps every shot at the window's 900 x 680, for media with consistent framing.
const fixed = args.includes('--fixed');
const OUTDIR = (args.find((a) => a.startsWith('--out=')) ?? '').slice(6) || OUT;

const HARDWARE = { summary: 'No GPU found, 32 GB RAM. Emberon cleaned the sample in 0.41 s.', chain: 'emberon', emberonMs: 410, gemmaChainMs: null, offerGemma: true, measuredAt: '2026-10-18T22:00:00.000Z' };
/** Each walkthrough shot: the saved step plus the made-up state that step shows. */
const STEP_STATE = {
  welcome: {},
  licences: {},
  download: { essentialsReady: false, speechInstalled: false, setup: { phase: 'downloading', kind: 'essentials', file: 'Emberon-2-Q4_K_M.gguf', received: 41e6, total: 199996928, overallReceived: 505e6, overallTotal: 683e6, bytesPerSecond: 18.4e6, etaSeconds: 10, step: 1, steps: 3 } },
  'download-error': { step: 'download', essentialsReady: false, speechInstalled: false, setup: { phase: 'error', kind: 'essentials', message: 'Couldn’t download Emberon-2-Q4_K_M.gguf: connection lost at 41%. Retry to resume.' } },
  disk: { step: 'download', essentialsReady: false, speechInstalled: false, setup: { phase: 'error', kind: 'essentials', message: String.raw`Not enough disk space: 1.5 GB needed, 0.4 GB free on C:\Users\you\AppData\Roaming\dictate\models.` } },
  hardware: { settings: { hardware: HARDWARE } },
  microphone: {},
  hotkey: {},
  try: { practice: { raw: 'testing my new dictation app um it runs entirely on my own computer', text: 'Testing my new dictation app. It runs entirely on my own computer.', ms: 412, cleaned: true } },
  done: {},
};

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
  // The shipped starting vocabulary, so the Vocabulary page looks as it does after install.
  const vocab = JSON.parse(fs.readFileSync(path.join(ROOT, 'defaults', 'vocabulary.json'), 'utf8'));
  let settings = { ...defaultSettings(vocab.terms ?? vocab), onboarded: true, ...patch };
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
    setup: {phase:'idle'}, speechInstalled:true, shortcutRegistered:false, shortcutRequested:false, startupError:'', recording:false, automation:true,
    essentialsReady: true, gemmaInstalled: false, sizes: { essentials: 683e6, gemma: 3106738272 }, hardwareRunning: false, hardwareError: '', update: { status: 'up-to-date', mode: 'install', checkedAt: '2026-10-18T21:00:00.000Z' }, dataDir: String.raw`C:\Users\you\AppData\Roaming\dictate`,
    ...extra,
  });
  let extra = {};
  ipcMain.handle('dictate:get-state', () => state());
  ipcMain.handle('dictate:set-settings', (_e, p) => {
    settings = { ...settings, ...p };
    return state();
  });
  ipcMain.handle('dictate:record-binding', () => null);
  for (const ch of ['dictate:practice', 'dictate:hardware-check', 'dictate:open-url', 'dictate:open-data', 'dictate:setup-models', 'dictate:cancel-setup']) ipcMain.handle(ch, () => state());
  ipcMain.handle('dictate:take-page', () => null);
  ipcMain.on('dictate:renderer-error', (_e, page, msg) => console.error(`renderer ${page}: ${msg}`));

  const w = new BrowserWindow({ width: 900 * scale, height: 680 * scale, show: false, enableLargerThanScreen: true, backgroundColor: '#202020', webPreferences: { preload: path.join(ROOT, 'out', 'main', 'preload.js'), offscreen: true, contextIsolation: true, sandbox: false } });
  const html = path.join(ROOT, 'out', 'renderer', 'settings.html');
  fs.mkdirSync(OUTDIR, { recursive: true });
  const shoot = async (name) => {
    const height = await w.webContents.executeJavaScript(`Math.max(680, (document.querySelector('main.content')?.scrollHeight ?? 0) + 60)`);
    w.setContentSize(900 * scale, (fixed ? Math.max(680, Math.min(900, height)) : Math.min(4000, height)) * scale);
    await new Promise((r) => setTimeout(r, 400));
    const img = await w.webContents.capturePage();
    const file = path.join(OUTDIR, `${name}.png`);
    fs.writeFileSync(file, img.toPNG());
    console.log(file);
  };
  w.webContents.on('did-finish-load', () => w.webContents.setZoomFactor(scale));
  if (walk.length) {
    const base = settings;
    for (const name of walk) {
      const { step = name, settings: sp = {}, practice, ...rest } = STEP_STATE[name] ?? {};
      settings = { ...base, onboarded: false, licencesSeen: true, onboardingStep: step, ...sp };
      extra = rest;
      await w.loadFile(html);
      await new Promise((r) => setTimeout(r, 400));
      if (practice) w.webContents.send('dictate:practice-result', practice);
      await new Promise((r) => setTimeout(r, 200));
      await shoot(`walkthrough-${name}`);
    }
    return app.quit();
  }
  await w.loadFile(html);
  for (const label of pages.length ? pages : ['Hotkeys & output']) {
    const height = await w.webContents.executeJavaScript(`(async () => {
      // A nav button is its icon then its label.
      const b = [...document.querySelectorAll('nav .navitem')].find((e) => e.lastChild?.textContent.trim() === ${JSON.stringify(label)});
      b?.click();
      await new Promise((r) => setTimeout(r, 300));
      const c = document.querySelector('main.content');
      return Math.max(680, (c?.scrollHeight ?? 0) + 60);
    })()`);
    w.setContentSize(900 * scale, (fixed ? 680 : Math.min(4000, height)) * scale);
    await new Promise((r) => setTimeout(r, 400));
    const img = await w.webContents.capturePage();
    const file = path.join(OUTDIR, `${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`);
    fs.writeFileSync(file, img.toPNG());
    console.log(file);
  }
  app.quit();
});
