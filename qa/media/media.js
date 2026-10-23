// README media from the real pill and picker pages, off-screen, on a synthetic desktop (no app, no keyboard,
// no clipboard, nothing personal). The live words, levels and timings come from the real recognizer and cleanup
// on fixtures/two-sentences.wav (qa/media/demo-timeline.json, made by qa/fixture-timeline.mjs).
//   pnpm build && node_modules\electron\dist\electron.exe qa/media/media.js [stills] [picker] [demo]
// Writes tmp/media/*.png and tmp/media/demo-frames/; qa/media/build.mjs frames and encodes them into docs/media.
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'tmp', 'media');
const timeline = JSON.parse(fs.readFileSync(path.join(__dirname, 'demo-timeline.json'), 'utf8'));
const wanted = process.argv.slice(2).filter((a) => !a.endsWith('.js') && a !== '.');
const jobs = wanted.length ? wanted : ['stills', 'picker', 'demo'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 1280;
const H = 720;
const SCALE = 2;

/** 50 ms RMS levels of the fixture, the same measure the pill's waveform shows. */
function levels(file) {
  const b = fs.readFileSync(file);
  let at = 12;
  let data;
  let rate = 16000;
  while (at < b.length) {
    const id = b.toString('ascii', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === 'fmt ') rate = b.readUInt32LE(at + 12);
    if (id === 'data') data = b.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size % 2);
  }
  const step = rate / 20;
  const out = [];
  for (let i = 0; i + step * 2 <= data.length / 2; i += step) {
    let sum = 0;
    for (let j = 0; j < step; j++) {
      const x = data.readInt16LE((i + j) * 2) / 32768;
      sum += x * x;
    }
    out.push(Math.sqrt(sum / step));
  }
  return out;
}

let win;
/** One off-screen window, reloaded per scene. */
async function open(page, look = '') {
  win ??= new BrowserWindow({ width: W * SCALE, height: H * SCALE, show: false, enableLargerThanScreen: true, backgroundColor: '#0b0d12', webPreferences: { offscreen: true, contextIsolation: false, zoomFactor: SCALE } });
  win.setContentSize(W * SCALE, H * SCALE);
  const w = win;
  w.webContents.setFrameRate(30);
  w.webContents.removeAllListeners('paint');
  await w.loadFile(path.join(__dirname, page));
  await sleep(400);
  if (look) await w.webContents.executeJavaScript(`document.body.classList.add(${JSON.stringify(look)})`);
  const emit = (channel, ...args) => w.webContents.executeJavaScript(`window.__emit(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`);
  const js = (code) => w.webContents.executeJavaScript(code);
  return { w, emit, js };
}

async function save(w, name, rect) {
  const img = await w.webContents.capturePage(rect);
  fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
  console.log(name, img.getSize());
}

/** The pill with room for its shadow, in DIPs. */
async function pillRect(js) {
  const r = await js(`(() => { const b = document.querySelector('.pill').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; })()`);
  const m = 28;
  // CSS pixels to the window's device-independent pixels (the page is zoomed by SCALE).
  return { x: Math.floor((r.x - m) * SCALE), y: Math.floor((r.y - m) * SCALE), width: Math.ceil((r.w + 2 * m) * SCALE), height: Math.ceil((r.h + 2 * m) * SCALE) };
}

const LISTEN = { kind: 'listening', mode: 'push-to-talk', finish: 'Release to finish' };
const partialAt = (t) => [...timeline.partials].reverse().find((p) => p.t <= t)?.text ?? '';

async function feedLevels(emit, lv, from, n) {
  for (let i = 0; i < n; i++) {
    await emit('dictate:level', lv[Math.min(lv.length - 1, from + i)]);
    await sleep(50);
  }
}

async function stills(lv) {
  // The state strip: each state cropped on a plain backdrop.
  const { w, emit, js } = await open('pill-scene.html', 'plain');
  await emit('dictate:pill-config', { variant: 'a', showText: true });
  // Starting: the mic is still opening, so the waveform is grey and flat.
  await emit('dictate:pill', { ...LISTEN, starting: true });
  await sleep(600);
  await save(w, 'pill-starting', await pillRect(js));
  // Listening, with the live words as they arrive.
  await emit('dictate:live');
  await emit('dictate:partial', partialAt(5.9));
  await feedLevels(emit, lv, Math.round(4.4 * 20) - 14, 14);
  await sleep(250);
  await save(w, 'pill-listening', await pillRect(js));
  // Cleaning, after the key is released.
  await emit('dictate:partial', timeline.raw);
  await emit('dictate:pill', { kind: 'cleaning' });
  await sleep(500);
  await save(w, 'pill-cleaning', await pillRect(js));
  await emit('dictate:pill', { kind: 'done', message: 'Pasted' });
  await sleep(500);
  await save(w, 'pill-pasted', await pillRect(js));
  await emit('dictate:pill', { kind: 'copied', message: 'Copied · press Ctrl+V' });
  await sleep(500);
  await save(w, 'pill-copied', await pillRect(js));
  await emit('dictate:pill', { kind: 'error', message: 'Microphone unplugged — it’s in History' });
  await sleep(500);
  await save(w, 'pill-error', await pillRect(js));

  // The hero: the pill listening over a blurred editor.
  const hero = await open('pill-scene.html', 'blur');
  await hero.emit('dictate:pill-config', { variant: 'a', showText: true });
  await hero.emit('dictate:pill', LISTEN);
  await hero.emit('dictate:live');
  await hero.emit('dictate:partial', partialAt(9.1));
  await feedLevels(hero.emit, lv, Math.round(9.1 * 20) - 14, 14);
  await sleep(250);
  await save(hero.w, 'hero');
}

async function picker() {
  const { w, emit } = await open('picker-scene.html');
  const now = Date.parse('2026-10-18T16:00:00Z');
  const ago = (min) => new Date(now - min * 60_000).toISOString();
  const items = [
    { id: '1', at: ago(2), raw: 'ship the release notes after the build goes green', text: 'Ship the release notes after the build goes green.', ms: 412 },
    { id: '2', at: ago(14), raw: 'can you move standup to ten thirty tomorrow', text: 'Can you move standup to 10:30 tomorrow?', ms: 388, pinned: true },
    { id: '3', at: ago(41), raw: 'the flaky test is the postgres migration one not the cache', text: 'The flaky test is the Postgres migration one, not the cache.', ms: 455 },
    { id: '4', at: ago(95), raw: 'deploy the kubernetes cluster with terraform and send the logs to click house', text: 'Deploy the Kubernetes cluster with Terraform and send the logs to ClickHouse.', ms: 610 },
    { id: '5', at: ago(60 * 26), raw: 'thanks everyone great demo today', text: 'Thanks, everyone. Great demo today!', ms: 301 },
    { id: '6', at: ago(60 * 50), raw: 'add use effect cleanup so the socket closes', text: 'Add useEffect cleanup so the socket closes.', ms: 377 },
  ];
  await emit('dictate:picker-open', { items, now, hotkey: 'Right Ctrl', localKeys: false });
  await sleep(600);
  await save(w, 'picker');
}

/** A real-time dictation: frames from the offscreen paint stream, with their times, for build.mjs to encode. */
async function demo(lv) {
  const frames = path.join(OUT, 'demo-frames');
  fs.rmSync(frames, { recursive: true, force: true });
  fs.mkdirSync(frames, { recursive: true });
  const { w, emit, js } = await open('pill-scene.html');
  await emit('dictate:pill-config', { variant: 'a', showText: true });
  const list = [];
  const t0 = Date.now();
  let n = 0;
  let busy = false;
  w.webContents.on('paint', (_e, _dirty, image) => {
    if (busy) return;
    busy = true;
    const file = `${String(n++).padStart(5, '0')}.jpg`;
    fs.writeFileSync(path.join(frames, file), image.toJPEG(90));
    list.push({ file, t: (Date.now() - t0) / 1000 });
    busy = false;
  });
  const lead = 1.2;
  await sleep(lead * 1000);
  // Key down: the pill starts grey while the mic opens, then listens.
  await js(`document.getElementById('keycue').classList.add('on', 'held')`);
  await emit('dictate:pill', { ...LISTEN, starting: true });
  await sleep(250);
  await emit('dictate:live');
  const start = Date.now();
  const events = timeline.partials.map((p) => ({ at: p.t, run: () => emit('dictate:partial', p.text) }));
  lv.forEach((l, i) => events.push({ at: i * 0.05, run: () => emit('dictate:level', l) }));
  events.sort((a, b) => a.at - b.at);
  for (const e of events) {
    const wait = start + e.at * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    void e.run();
  }
  await sleep(Math.max(0, start + timeline.seconds * 1000 - Date.now()) + 200);
  // Key up: the final words, then cleanup, then the text lands in the editor.
  await js(`document.getElementById('keycue').classList.remove('held')`);
  await emit('dictate:partial', timeline.raw);
  await emit('dictate:pill', { kind: 'transcribing' });
  await sleep(timeline.flushMs);
  await emit('dictate:pill', { kind: 'cleaning' });
  await sleep(timeline.cleanupMs);
  await js(`(() => { const t = document.getElementById('typed'); t.innerHTML = ''; const s = document.createElement('span'); s.className = 'typed'; s.textContent = ${JSON.stringify(`${timeline.cleaned} `)}; t.append(s); setTimeout(() => s.classList.add('settled'), 600); })()`);
  await emit('dictate:pill', { kind: 'done', message: 'Pasted' });
  await js(`document.getElementById('keycue').classList.remove('on')`);
  await sleep(2600);
  fs.writeFileSync(path.join(frames, 'frames.json'), JSON.stringify({ list, end: (Date.now() - t0) / 1000 }, null, 1));
  console.log(`demo: ${list.length} frames over ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const lv = levels(path.join(ROOT, 'fixtures', timeline.wav));
  if (jobs.includes('stills')) await stills(lv);
  if (jobs.includes('picker')) await picker();
  if (jobs.includes('demo')) await demo(lv);
  app.quit();
});
