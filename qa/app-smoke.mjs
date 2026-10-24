// Full app wiring: real WAV -> AudioWorklet capture -> utility recognizer -> output/history, then Escape, which
// delivers nothing but keeps what was heard in history.
// Model fixture and synthetic hotkey are declared; this does not prove a physical mic or native shortcut.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (key, fallback) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
const root = path.resolve(import.meta.dirname, '..');
const reportFile = path.resolve(option('--report', path.join(root, 'tmp/app-smoke/report.json')));
const executable = option('--executable', createRequire(import.meta.url)('electron'));
if (!process.env.DICTATE_MODELS_DIR) throw new Error('DICTATE_MODELS_DIR must point at the verified speech model directory');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dictate-app-qa-'));
const control = path.join(profile, 'control.txt');
const logfile = path.join(profile, 'logs/dictate.log');
const historyFile = path.join(profile, 'history.json');
const fixture = path.join(root, 'fixtures/two-sentences.wav');
fs.mkdirSync(path.dirname(reportFile), { recursive: true });
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ onboarded: true, cleanup: 'off', sounds: false, startAtLogin: false, output: 'clipboard', hotkeys: [{ keys: [0xa3] }] }));
function durationMs(file) {
  const wav = fs.readFileSync(file);
  let rate, bytesPerSample, channels;
  for (let i = 12; i + 8 <= wav.length;) {
    const size = wav.readUInt32LE(i + 4), body = i + 8;
    if (wav.toString('ascii', i, i + 4) === 'fmt ') { channels = wav.readUInt16LE(body + 2); rate = wav.readUInt32LE(body + 4); bytesPerSample = wav.readUInt16LE(body + 14) / 8; }
    if (wav.toString('ascii', i, i + 4) === 'data') return Math.ceil(size / (rate * channels * bytesPerSample) * 1000);
    i = body + size + size % 2;
  }
  throw new Error('Fixture has no audio data');
}
const pause = ms => new Promise(r => setTimeout(r, ms));
let spawnError;
const alive = () => child.exitCode === null && child.signalCode === null && !spawnError;
const readLog = () => fs.existsSync(logfile) ? fs.readFileSync(logfile, 'utf8') : '';
async function until(test, label, timeout = 45_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (test()) return; if (!alive()) throw new Error(`App exited ${child.exitCode ?? child.signalCode ?? spawnError?.message} during ${label}`); await pause(100); }
  throw new Error(`Timed out waiting for ${label}\n${readLog()}`);
}
const env = { ...process.env, DICTATE_DATA_DIR: profile, DICTATE_CAPTURE: 'browser', DICTATE_FAKE_MIC: fixture, DICTATE_QA_CONTROL: control, DICTATE_QA_SINK: 'none' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.DICTATE_SMOKE_TEST;
const argv = option('--executable') ? [] : [root];
argv.push('--autoplay-policy=no-user-gesture-required', '--alsa-output-device=null', '--disable-gpu');
if (process.env.DICTATE_SMOKE_NO_SANDBOX === '1' && process.platform === 'linux') argv.push('--no-sandbox');
const child = spawn(executable, argv, { env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.on('error', error => { spawnError = error; });
child.stdout.on('data', b => { output = (output + b).slice(-100000); });
child.stderr.on('data', b => { output = (output + b).slice(-100000); });
const result = { ok: false, platform: process.platform, arch: process.arch, fixture: path.basename(fixture), capture: 'real AudioWorklet with WAV source', nativeKeyboard: false, physicalMicrophone: false, hardwareAccelerationDisabled: true, output: 'log sink and persisted history', singleInstanceLockSkipped: process.env.DICTATE_SMOKE_SKIP_INSTANCE_LOCK === '1' };
try {
  await until(() => /speech model loaded/.test(readLog()) && /pill ready/.test(readLog()) && fs.existsSync(control), 'ready recognizer and capture renderer');
  fs.appendFileSync(control, 'down\n');
  await until(() => /capture 1 on .*\(browser\)/.test(readLog()), 'real browser capture start', 10_000);
  await pause(durationMs(fixture) + 400);
  fs.appendFileSync(control, 'up\n');
  await until(() => fs.existsSync(historyFile) && JSON.parse(fs.readFileSync(historyFile, 'utf8')).length === 1, 'delivered transcript and persisted history', 15_000);
  const first = JSON.parse(fs.readFileSync(historyFile, 'utf8'))[0];
  if (!first.raw.toLowerCase().includes('deploy the kubernetes cluster with terraform') || !first.raw.toLowerCase().includes('nemotron streaming models')) throw new Error(`Unexpected app transcript: ${first.raw}`);
  if (!/QA delivered/.test(readLog())) throw new Error('App did not deliver through its configured output sink');
  result.transcript = first.raw;
  result.savedText = first.text;
  result.historyEntries = 1;
  fs.appendFileSync(control, 'down\n');
  await until(() => /capture 2 on .*\(browser\)/.test(readLog()), 'second real browser capture start', 10_000);
  await until(() => /stt partial 2: recognizer activity/.test(readLog()), 'second-session audio decoded by the real recognizer', 15_000);
  fs.appendFileSync(control, 'escape\nup\n');
  await until(() => /dictation 2: cancelled with Esc while recording, kept in history/.test(readLog()) && JSON.parse(fs.readFileSync(historyFile, 'utf8')).length === 2, 'cancelled recording kept in history', 15_000);
  const kept = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
  if (kept.length !== 2 || !kept[0].raw.trim() || kept[0].text !== kept[0].raw) throw new Error(`Cancelled recording was not kept in history: ${JSON.stringify(kept[0])}`);
  if ((readLog().match(/QA delivered/g) ?? []).length !== 1) throw new Error('Cancelled recording was delivered');
  result.cancelledRecordingNotDelivered = true;
  result.cancelledTranscript = kept[0].raw;
  result.cancellationEvidence = { session: 2, captureStarted: true, recognizerDecodedAudio: true, recognizerFinished: /stt final 2:/.test(readLog()), outputDeliveries: 1, historyEntries: 2 };
  result.ok = true;
} catch (error) { result.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  if (alive() && fs.existsSync(control)) fs.appendFileSync(control, 'quit\n');
  for (let i = 0; i < 50 && alive(); i++) await pause(100);
  if (alive()) {
    result.shutdownForced = true;
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f']);
    else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    result.ok = false; process.exitCode = 1;
  } else result.appExitCode = child.exitCode;
  fs.writeFileSync(reportFile, JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(reportFile + '.log', readLog() + '\n--- Electron output ---\n' + output);
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(JSON.stringify(result, null, 2));
}
