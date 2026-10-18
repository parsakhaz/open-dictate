// Desktop QA for dictate: drives the real app with injected keys and a fake mic (WAV), reads the target
// app's text with UI Automation, checks the clipboard, and pulls timings from the log.
// Shared helpers for qa/qa.js.
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const k = require('../node_modules/koffi');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'tmp', 'qa-data');
const OUT = path.join(ROOT, 'tmp', 'qa', 'out');
fs.mkdirSync(OUT, { recursive: true });
const FIX = 'C:\\repos\\experiments\\worktrees\\voice-lab\\voice-lab\\fixtures\\synthetic';
const LOG = path.join(DATA, 'logs', 'dictate.log');

const u = k.load('user32.dll');
const KEYBDINPUT = k.struct('KEYBDINPUT', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr' });
const MOUSEINPUT = k.struct('MOUSEINPUT', { dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr' });
const INPUT = k.struct('INPUT', { type: 'uint32', u: k.union('INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT }) });
const SendInput = u.func('__stdcall', 'SendInput', 'uint32', ['uint32', k.pointer(INPUT), 'int32']);
const SetForegroundWindow = u.func('__stdcall', 'SetForegroundWindow', 'bool', ['intptr']);
const GetForegroundWindow = u.func('__stdcall', 'GetForegroundWindow', 'intptr', []);
const ext = new Set([0xa3, 0xa5, 0x25, 0x26, 0x27, 0x28, 0x2e, 0x24, 0x23]);
const key = (vk, up) => SendInput(1, [{ type: 1, u: { ki: { wVk: vk, wScan: 0, dwFlags: (up ? 2 : 0) | (ext.has(vk) ? 1 : 0), time: 0, dwExtraInfo: 0 } } }], k.sizeof(INPUT));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RCTRL = 0xa3;
async function tap(vk, hold = 60) {
  key(vk, false);
  await sleep(hold);
  key(vk, true);
}

function ps(script) {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim();
}

function setClipboard(text) {
  ps(`Set-Clipboard -Value '${text.replace(/'/g, "''")}'`);
}
function getClipboard() {
  return ps('Get-Clipboard -Raw');
}

/** Text of the window titled like `title`, through UI Automation (Notepad's document, a browser textarea, etc.). */
function readText(title) {
  return ps(`
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Window)
$w = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond) | Where-Object { $_.Current.Name -like '*${title}*' } | Select-Object -First 1
if (-not $w) { 'NO WINDOW'; exit }
$doc = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Document)))
if (-not $doc) { $doc = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Edit))) }
$tp = $null
if ($doc.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) { $tp.DocumentRange.GetText(-1) } else { $vp = $null; if ($doc.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { $vp.Current.Value } else { 'NO TEXT PATTERN' } }
`);
}

function hwndOf(title) {
  const out = ps(`(Get-Process | Where-Object { $_.MainWindowTitle -like '*${title}*' } | Select-Object -First 1).MainWindowHandle`);
  return Number(out) || 0;
}

async function focus(title) {
  const h = hwndOf(title);
  if (!h) throw new Error(`no window ${title}`);
  // An Alt tap lets a background process take the foreground.
  await tap(0x12, 30);
  SetForegroundWindow(h);
  await sleep(300);
  return Number(GetForegroundWindow()) === h;
}

function shot(name) {
  const f = path.join(OUT, `${name}.png`);
  ps(`& '${path.join(ROOT, 'qa', 'shot.ps1')}' -out '${f}'`);
  return f;
}

function logSince(mark) {
  const all = fs.readFileSync(LOG, 'utf8');
  return all.slice(mark);
}
const logMark = () => (fs.existsSync(LOG) ? fs.statSync(LOG).size : 0);

let app;
function startApp(fakeWav, extraEnv = {}) {
  app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.'], {
    cwd: ROOT,
    env: { ...process.env, DICTATE_DATA_DIR: DATA, DICTATE_FAKE_MIC: fakeWav, ...extraEnv },
    stdio: 'ignore',
  });
  return app;
}
async function waitLog(re, ms, mark = 0) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fs.existsSync(LOG) && re.test(logSince(mark))) return true;
    await sleep(200);
  }
  return false;
}
function stopApp() {
  if (app) execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
  app = undefined;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

module.exports = { key, tap, sleep, RCTRL, ps, setClipboard, getClipboard, readText, focus, shot, logMark, logSince, startApp, stopApp, waitLog, check, results, FIX, DATA, OUT, ROOT, hwndOf };

// ---------- caret probe (S3): does the focused control expose a Win32 caret? ----------
const RECT = k.struct('QRECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const GTI = k.struct('QGUITHREADINFO', { cbSize: 'uint32', flags: 'uint32', hwndActive: 'intptr', hwndFocus: 'intptr', hwndCapture: 'intptr', hwndMenuOwner: 'intptr', hwndMoveSize: 'intptr', hwndCaret: 'intptr', rcCaret: RECT });
const GetGUIThreadInfo = u.func('__stdcall', 'GetGUIThreadInfo', 'bool', ['uint32', k.inout(k.pointer(GTI))]);
const GetWindowThreadProcessId = u.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['intptr', k.out(k.pointer('uint32'))]);
function caretInfo() {
  const fg = Number(GetForegroundWindow());
  const tid = GetWindowThreadProcessId(fg, [0]);
  const info = { cbSize: k.sizeof(GTI), flags: 0, hwndActive: 0, hwndFocus: 0, hwndCapture: 0, hwndMenuOwner: 0, hwndMoveSize: 0, hwndCaret: 0, rcCaret: { left: 0, top: 0, right: 0, bottom: 0 } };
  const ok = GetGUIThreadInfo(tid, info);
  return { ok, hwndCaret: Number(info.hwndCaret), rc: info.rcCaret };
}
module.exports.caretInfo = caretInfo;
