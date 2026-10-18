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
/** A key event with an explicit scan code (AltGr's fake Left Ctrl is scan code 0x21D). */
const keyScan = (vk, scan, up) => SendInput(1, [{ type: 1, u: { ki: { wVk: vk, wScan: scan, dwFlags: up ? 2 : 0, time: 0, dwExtraInfo: 0 } } }], k.sizeof(INPUT));
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

const UIA = `Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
function Win($t) { $A::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.Name -like "*$t*" } | Select-Object -First 1 }`;

/** Text of the window titled like `title`, through UI Automation: Notepad's document, a browser textarea, a terminal buffer. */
function readText(title) {
  return ps(`${UIA}
$w = Win '${title}'
if (-not $w) { 'NO WINDOW'; exit }
$all = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition ($A::IsTextPatternAvailableProperty), $true))
# a document (Notepad, a page) or a terminal buffer, not a tab title
$el = $all | Where-Object { $_.Current.ControlType.ProgrammaticName -eq 'ControlType.Document' -or $_.Current.ClassName -eq 'TermControl' } | Select-Object -First 1
if (-not $el) { $el = $all | Select-Object -First 1 }
$tp = $null; $vp = $null
if ($el -and $el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) { $tp.DocumentRange.GetText(-1); exit }
$el = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition ($A::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Edit)))
if ($el -and $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { $vp.Current.Value } else { 'NO TEXT' }
`);
}

// The person's clipboard (text and HTML) is saved before the run and put back after it.
const CLIP = path.join(ROOT, 'tmp', 'qa', 'clipboard');
function clipPs(script) {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-STA', '-Command', `Add-Type -AssemblyName System.Windows.Forms; ${script}`], { encoding: 'utf8' }).trim();
}
function saveClipboard() {
  // A run that died before restoring left the person's clipboard here: keep it, never overwrite it.
  if (fs.existsSync(CLIP)) return;
  fs.mkdirSync(CLIP, { recursive: true });
  try {
    clipPs(`$o = [System.Windows.Forms.Clipboard]::GetDataObject(); foreach ($f in 'UnicodeText','HTML Format') { $v = $o.GetData($f); if ($v -ne $null) { [IO.File]::WriteAllText((Join-Path '${CLIP}' (($f -replace ' ','') + '.txt')), [string]$v, [Text.Encoding]::UTF8) } }`);
  } catch (err) {
    // An empty snapshot must never be "restored" over the person's clipboard later.
    fs.rmSync(CLIP, { recursive: true, force: true });
    throw new Error(`cannot read the clipboard (is the screen locked?): ${String(err.message).trim().split(String.fromCharCode(10))[0]}`);
  }
}
function restoreClipboard() {
  if (!fs.existsSync(CLIP)) return;
  clipPs(`$d = New-Object System.Windows.Forms.DataObject; foreach ($f in 'UnicodeText','HTML Format') { $p = Join-Path '${CLIP}' (($f -replace ' ','') + '.txt'); if (Test-Path $p) { $d.SetData($f, [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)) } }; [System.Windows.Forms.Clipboard]::SetDataObject($d, $true)`);
  fs.rmSync(CLIP, { recursive: true, force: true });
}

/** The UI Automation control type of the focused element, e.g. ControlType.Document, ControlType.MenuItem. */
function focusedControl() {
  return ps(`${UIA}\n$f = $A::FocusedElement; if ($f) { $f.Current.ControlType.ProgrammaticName + ' ' + $f.Current.Name } else { 'none' }`);
}
/** Focus is in a text control: an Alt release did not move it to a menu bar or key tips. */
function focusInText() {
  return /^ControlType\.(Document|Edit)/.test(focusedControl());
}

function hwndOf(title) {
  return Number(ps(`${UIA}\n$w = Win '${title}'; if ($w) { $w.Current.NativeWindowHandle } else { 0 }`)) || 0;
}

async function focus(title) {
  const h = hwndOf(title);
  if (!h) throw new Error(`no window ${title}`);
  await tap(0x88, 30); // an unassigned key: it lets us take the foreground (an Alt tap would open menu key tips)
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
  // The mark is a byte offset (the log has non-ASCII text such as "—"), so slice the bytes, not the string.
  return fs.readFileSync(LOG).subarray(mark).toString('utf8');
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

/** Lets go of every modifier: a run that dies mid-press must not leave Ctrl held (Esc would then open Start). */
function releaseModifiers() {
  for (const vk of [0xa3, 0xa2, 0x11, 0xa1, 0xa0, 0x10, 0xa5, 0xa4, 0x12]) key(vk, true);
}
process.on('exit', releaseModifiers);

/** Ctrl+W, only when the foreground window is the one we opened (its title starts with `prefix`). */
async function closeTab(prefix) {
  const t = fgTitle().replace(/^\*/, '');
  if (!t.startsWith(prefix)) {
    console.log(`not closing: the foreground is "${t}", not ${prefix}`);
    return false;
  }
  key(0x11, false);
  await tap(0x57);
  key(0x11, true);
  await sleep(600);
  return true;
}

module.exports = { keyScan, focusedControl, focusInText, releaseModifiers, closeTab, saveClipboard, restoreClipboard, key, tap, sleep, RCTRL, ps, setClipboard, getClipboard, readText, focus, shot, logMark, logSince, startApp, stopApp, waitLog, check, results, FIX, DATA, OUT, ROOT, hwndOf };

// ---------- caret probe (S3): does the focused control expose a Win32 caret? ----------
const RECT = k.struct('QRECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const GTI = k.struct('QGUITHREADINFO', { cbSize: 'uint32', flags: 'uint32', hwndActive: 'intptr', hwndFocus: 'intptr', hwndCapture: 'intptr', hwndMenuOwner: 'intptr', hwndMoveSize: 'intptr', hwndCaret: 'intptr', rcCaret: RECT });
const GetGUIThreadInfo = u.func('__stdcall', 'GetGUIThreadInfo', 'bool', ['uint32', k.inout(k.pointer(GTI))]);
const GetWindowThreadProcessId = u.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['intptr', k.out(k.pointer('uint32'))]);
const GetWindowTextW = u.func('__stdcall', 'GetWindowTextW', 'int', ['intptr', 'void *', 'int']);
/** The foreground window's title. */
function fgTitle() {
  const b = Buffer.alloc(1024);
  const n = GetWindowTextW(GetForegroundWindow(), b, 512);
  return b.toString('utf16le', 0, n * 2);
}
module.exports.fgTitle = fgTitle;
const GetClassNameW = u.func('__stdcall', 'GetClassNameW', 'int', ['intptr', 'void *', 'int']);
function caretInfo() {
  const fg = Number(GetForegroundWindow());
  const tid = GetWindowThreadProcessId(fg, [0]);
  const info = { cbSize: k.sizeof(GTI), flags: 0, hwndActive: 0, hwndFocus: 0, hwndCapture: 0, hwndMenuOwner: 0, hwndMoveSize: 0, hwndCaret: 0, rcCaret: { left: 0, top: 0, right: 0, bottom: 0 } };
  const ok = GetGUIThreadInfo(tid, info);
  const cls = Buffer.alloc(512);
  const n = info.hwndFocus ? GetClassNameW(info.hwndFocus, cls, 256) : 0;
  const fc = Buffer.alloc(512);
  const m = GetClassNameW(fg, fc, 256);
  return { ok, hwndCaret: Number(info.hwndCaret), rc: info.rcCaret, focusClass: cls.toString('utf16le', 0, n * 2), windowClass: fc.toString('utf16le', 0, m * 2) };
}
module.exports.caretInfo = caretInfo;
