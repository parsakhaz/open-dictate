// Drives Getting started in the real app on a fresh profile, through Chrome DevTools: no physical keyboard,
// the fixture WAV as the microphone and a control file as the dictation key. Real downloads (about 0.7 GB).
//   node qa/walkthrough.mjs --app <Dictate executable> [--profile <dir>] [--shots <dir>] [--report <json>]
//                           [--full-disk-profile <dir on a small volume>]
// Journey: welcome → licences → download, quit at ~25% and relaunch (resumes at the step and the byte) → speed
// check → microphone → key → a practice dictation of fixtures/two-sentences.wav → done → Finish. With
// --full-disk-profile it then starts a fresh profile there and expects the disk-space refusal.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const value = (name, d) => { const i = args.indexOf(name); return i < 0 ? d : args[i + 1]; };
const appExe = value('--app');
if (!appExe) throw new Error('--app <Dictate executable> is required');
const profile = path.resolve(value('--profile', fs.mkdtempSync(path.join(os.tmpdir(), 'dictate-walkthrough-'))));
const shots = path.resolve(value('--shots', path.join(root, 'tmp', 'walkthrough')));
const reportFile = path.resolve(value('--report', path.join(shots, 'report.json')));
const fullDisk = value('--full-disk-profile');
const wav = path.join(root, 'fixtures', 'two-sentences.wav');
const control = path.join(profile, 'qa-control.txt');
const PORT = 9333;
fs.mkdirSync(shots, { recursive: true });
const report = { ok: false, platform: process.platform, arch: process.arch, profile, steps: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const note = (step, data = {}) => { report.steps.push({ step, at: new Date().toISOString(), ...data }); console.log(step, JSON.stringify(data)); };

function wavSeconds(file) {
  const b = fs.readFileSync(file);
  const byteRate = b.readUInt32LE(28);
  let at = 12;
  while (at < b.length) {
    const id = b.toString('ascii', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === 'data') return size / byteRate;
    at += 8 + size;
  }
  throw new Error('no data chunk');
}

let child;
function launch(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const env = { ...process.env, DICTATE_DATA_DIR: dataDir, DICTATE_FAKE_MIC: wav, DICTATE_CAPTURE: 'browser', DICTATE_QA_CONTROL: path.join(dataDir, 'qa-control.txt') };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(appExe, [`--remote-debugging-port=${PORT}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => undefined);
  child.stderr.on('data', () => undefined);
}

async function quit(dataDir) {
  fs.appendFileSync(path.join(dataDir, 'qa-control.txt'), 'quit\n');
  for (let i = 0; i < 100 && child.exitCode === null; i++) await sleep(100);
  if (child.exitCode === null) child.kill('SIGKILL');
  await sleep(500);
}

/** A tiny CDP client for the Settings page. */
async function connect() {
  let target;
  for (let i = 0; i < 150 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.url.endsWith('settings.html'));
    } catch {}
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('the Settings window never opened');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); waiting.get(msg.id)?.(msg); waiting.delete(msg.id); };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(`${expression}: ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`);
    return r.result?.result?.value;
  };
  const until = async (expression, what, ms = 30_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await evaluate(expression).catch(() => undefined);
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(250);
    }
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(r.result.data, 'base64'));
  };
  const click = (wiz) => evaluate(`(() => { const b = document.querySelector('[data-wiz="${wiz}"]'); if (!b) throw new Error('no ${wiz} button'); b.click(); return true; })()`);
  return { evaluate, until, shot, click, close: () => ws.close() };
}

// Parenthesised: they are spliced into larger expressions (`${text}.includes(...)`).
const heading = `(document.querySelector('main h1')?.textContent ?? '')`;
const text = `(document.querySelector('main')?.innerText ?? '')`;
const percent = `Number(/Downloading… (\\d+)%/.exec(document.querySelector('main')?.innerText ?? '')?.[1] ?? -1)`;
const bytes = `(/([\\d.]+) (MB|GB) of/.exec(document.querySelector('[data-download-detail]')?.textContent ?? '') ?? []).slice(1).join(' ')`;

try {
  launch(profile);
  let p = await connect();
  await p.until(`${text}.includes('Welcome to dictate')`, 'the welcome step');
  await p.shot('1-welcome');
  note('welcome');
  await p.click('next');
  await p.until(`${heading} === 'Models and licences'`, 'the licences step');
  await p.shot('2-licences');
  note('licences', { skip: await p.evaluate(`!!document.querySelector('[data-wiz="skip"]')`) });
  await p.click('next');
  await p.until(`${percent} >= 25`, 'the download to reach 25%', 10 * 60_000);
  const cut = { percent: await p.evaluate(percent), bytes: await p.evaluate(bytes) };
  await p.shot('3-download');
  note('download running, quitting the app', cut);
  p.close();
  await quit(profile);

  launch(profile);
  p = await connect();
  await p.until(`${heading} === 'Download'`, 'the walkthrough to resume at the download step');
  await p.shot('3b-resumed-step');
  note('relaunched: resumed at the download step');
  await p.click('start-download');
  await p.until(`${percent} >= 0`, 'the resumed download');
  const resumed = { percent: await p.evaluate(percent), bytes: await p.evaluate(bytes) };
  note('download resumed', resumed);
  if (resumed.percent < cut.percent) throw new Error(`the download restarted: ${resumed.percent}% < ${cut.percent}%`);
  await p.until(`${text}.includes('Downloaded and verified')`, 'the download to finish', 15 * 60_000);
  await p.shot('3c-downloaded');
  note('downloaded and verified');
  await p.click('next');
  await p.until(`document.querySelector('[data-hardware-summary]')?.textContent`, 'the speed check', 5 * 60_000);
  await p.shot('4-speed-check');
  note('speed check', { summary: await p.evaluate(`document.querySelector('[data-hardware-summary]').textContent`) });
  await p.click('next');
  await p.until(`${heading} === 'Your microphone'`, 'the microphone step');
  await p.shot('5-microphone');
  await p.click('next');
  await p.until(`${heading} === 'Your dictation key'`, 'the key step');
  await p.shot('6-key');
  await p.click('next');
  await p.until(`!!document.querySelector('[data-practice]')`, 'the practice box', 60_000);
  await sleep(1500);
  const hold = wavSeconds(wav) * 1000 + 800;
  // The practice box takes a dictation only while Settings is in front, as a person clicking into it would.
  // A person clicks into the box, which makes the window key. Here: ask the app, and on macOS LaunchServices
  // (macOS ignores focus requests from an app launched outside the GUI session), until the page has focus.
  let focused = false;
  for (let i = 0; i < 8 && !focused; i++) {
    fs.appendFileSync(control, 'focus\n');
    if (process.platform === 'darwin') spawn('open', ['-a', appExe.replace(/\/Contents\/MacOS\/[^/]+$/, '')]);
    await sleep(1200);
    focused = await p.evaluate('document.hasFocus()');
  }
  note('settings window focused for the practice box', { focused });
  if (focused) {
    fs.appendFileSync(control, 'down\n');
    await sleep(hold);
    fs.appendFileSync(control, 'up\n');
    const practiced = await p.until(`document.querySelector('[data-practice-text]')?.textContent`, 'the practice dictation to land in the box', 30_000);
    await p.shot('7-try-it');
    note('practice dictation', { text: practiced, detail: await p.evaluate(`document.querySelector('.practiceresult')?.innerText`) });
  } else {
    // Without focus the dictation would go to whatever app is in front, as it should: not verified here.
    report.practiceUnverified = 'the OS did not give Settings focus in this session';
    await p.shot('7-try-it-unfocused');
  }
  await p.click('next');
  await p.until(`${heading} === 'You are set'`, 'the done step');
  await p.shot('8-done');
  await p.click('next');
  await p.until(`${heading} === 'Hotkeys & output'`, 'Settings after Finish');
  await p.shot('9-settings');
  p.close();
  // Settings are saved debounced; quitting flushes them.
  await quit(profile);
  const saved = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
  note('finished', { onboarded: saved.onboarded, onboardingStep: saved.onboardingStep, cleanup: saved.cleanup, hardware: saved.hardware?.summary });
  if (!saved.onboarded) throw new Error('settings.json is not onboarded after Finish');

  if (fullDisk) {
    launch(fullDisk);
    p = await connect();
    await p.until(`${text}.includes('Welcome to dictate')`, 'the welcome step on the small volume');
    await p.click('next');
    await p.until(`${heading} === 'Models and licences'`, 'licences');
    await p.click('next');
    const message = await p.until(`document.querySelector('[data-download-error]')?.textContent`, 'the disk-space refusal', 60_000);
    await p.shot('3d-disk-full');
    const models = path.join(fullDisk, 'models');
    const parts = fs.existsSync(models) ? fs.readdirSync(models, { recursive: true }).filter((f) => String(f).endsWith('.part')) : [];
    note('full disk', { message, partFiles: parts.length });
    if (!/^Not enough disk space/.test(message)) throw new Error(`expected the disk-space refusal, got: ${message}`);
    p.close();
    await quit(fullDisk);
  }
  report.ok = true;
} catch (err) {
  report.error = err.stack ?? String(err);
  console.error(report.error);
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}
