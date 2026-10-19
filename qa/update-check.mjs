// Auto-update in a real installed app, as far as it can be tested without publishing releases: the mode this
// build reports, Check now against GitHub Releases, and the off switch.
//   node qa/update-check.mjs --app <Dictate executable> [--report <json>] [--shots <dir>]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const value = (name, d) => { const i = args.indexOf(name); return i < 0 ? d : args[i + 1]; };
const appExe = value('--app');
if (!appExe) throw new Error('--app <Dictate executable> is required');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dictate-update-'));
const shots = path.resolve(value('--shots', path.join(profile, 'shots')));
const reportFile = path.resolve(value('--report', path.join(shots, 'update-report.json')));
const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(shots, { recursive: true });
// An onboarded profile: no walkthrough, and nothing to download for this check.
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ onboarded: true, onboardingStep: 'done', licencesSeen: true, cleanup: 'off', sounds: false }));
const env = { ...process.env, DICTATE_DATA_DIR: profile, DICTATE_QA_CONTROL: path.join(profile, 'qa-control.txt') };
delete env.ELECTRON_RUN_AS_NODE;
const report = { ok: false, platform: process.platform, arch: process.arch };
const child = spawn(appExe, [`--remote-debugging-port=${PORT}`], { env, stdio: 'ignore' });
try {
  await sleep(4000);
  // A second launch opens Settings in the running app (the single-instance handler), then exits.
  spawn(appExe, [], { env, stdio: 'ignore' });
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.url.endsWith('settings.html')); } catch {}
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('Settings never opened');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); waiting.get(msg.id)?.(msg); waiting.delete(msg.id); };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const js = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const shot = async (name) => fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
  const status = () => js(`(() => { const s = document.querySelector('[data-update-status]'); return s ? { status: s.dataset.updateStatus, text: s.textContent } : null; })()`);
  await sleep(1500);
  await js(`[...document.querySelectorAll('nav .navitem')].find((e) => e.lastChild?.textContent.trim() === 'About').click()`);
  await sleep(500);
  report.atStart = await status();
  await js(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Check now')?.click()`);
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const s = await status();
    if (s && s.status !== 'checking' && s.status !== 'idle') { report.afterCheck = s; break; }
  }
  await shot('about-after-check');
  await js(`(() => { const row = [...document.querySelectorAll('.card')].find((c) => c.querySelector('.cardtitle')?.textContent === 'Automatic updates'); row.querySelector('input[type=checkbox]').click(); })()`);
  await sleep(800);
  report.afterOff = await status();
  await shot('about-updates-off');
  ws.close();
  fs.appendFileSync(path.join(profile, 'qa-control.txt'), 'quit\n');
  for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(100);
  report.savedAutoUpdate = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).autoUpdate;
  const log = fs.readFileSync(path.join(profile, 'logs', 'dictate.log'), 'utf8');
  report.updateLogLines = log.split('\n').filter((l) => /update/i.test(l));
  report.ok = !!report.afterCheck && ['up-to-date', 'available', 'error'].includes(report.afterCheck.status) && report.afterOff?.status === 'disabled' && report.savedAutoUpdate === false;
} catch (err) {
  report.error = err.stack ?? String(err);
} finally {
  if (child.exitCode === null) child.kill('SIGKILL');
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
