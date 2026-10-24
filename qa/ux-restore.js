// Offscreen real-renderer/IPC checks. Never moves the OS pointer or opens a desktop card.
// This verifies action logic and native window configuration; manual OS clicking is still required.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { ELECTRON } = require('./agent-bridge');
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'tmp/verify/ux-restore', `data-${process.pid}`);
const CONTROL = path.join(DATA, 'control.txt');
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(CONTROL, '');
fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ onboarded: true, hotkeys: [{ keys: [0x81] }], toggle: null, picker: null, sounds: false }));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { const value = await fn(); if (value) return value; await sleep(100); } throw Error('Timed out'); }
let proc, ws, socket, seq = 1;
const pending = new Map();
const appPending = new Map();
const checks = [];
function check(name, ok) { assert.ok(ok, name); checks.push(name); console.log('PASS', name); }
function cdp(method, params) {
  const id = seq++;
  const promise = new Promise(resolve => pending.set(id, resolve));
  ws.send(JSON.stringify({ id, method, params }));
  return promise;
}
async function evaluate(expression) { const reply = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (reply.result?.exceptionDetails) throw Error(JSON.stringify(reply.result.exceptionDetails)); return reply.result?.result?.value; }
async function call(tool, args = {}) {
  const id = seq++;
  const promise = new Promise(resolve => appPending.set(id, resolve));
  socket.write(JSON.stringify({ t: 'call', id, tool, args }) + '\n');
  const reply = await promise;
  if (reply.error) throw Error(reply.error);
  return reply.result;
}
async function click(selector) { check(`semantic button ${selector}`, await evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});if(!b||b.tagName!=='BUTTON')return false;b.click();return true;})()`)); }
async function connectPage(port, suffix) {
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.url.endsWith(suffix)));
  ws?.close();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => ws.onopen = resolve);
  ws.onmessage = e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
}
async function key(key, code, vk) {
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
}
async function main() {
  proc = spawn(ELECTRON, ['.', '--remote-debugging-port=0'], { cwd: ROOT, env: { ...process.env, DICTATE_DATA_DIR: DATA, DICTATE_QA_CONTROL: CONTROL, DICTATE_QA_SINK: 'none', DICTATE_SMOKE_SKIP_INSTANCE_LOCK: '1', DICTATE_PILL_SHOTS: path.join(DATA, 'shots'), PANE_SESSION_ID: '', PANE_PANEL_ID: '', PANE_DIR: path.join(DATA, 'no-pane') }, stdio: 'ignore' });
  const port = await until(() => { const f = path.join(DATA, 'DevToolsActivePort'); return fs.existsSync(f) && fs.readFileSync(f, 'utf8').split('\n')[0]; });
  await connectPage(port, 'pill.html');
  await until(() => fs.existsSync(path.join(DATA, 'agents/channel.json')));
  const channel = JSON.parse(fs.readFileSync(path.join(DATA, 'agents/channel.json')));
  socket = net.connect(channel.path);
  let buf = '';
  const hello = new Promise(resolve => socket.on('data', chunk => {
    buf += chunk;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.t === 'hello') resolve(m);
      if (m.t === 'result') { appPending.get(m.id)?.(m); appPending.delete(m.id); }
    }
  }));
  socket.write(JSON.stringify({ t: 'hello', token: channel.token, client: { name: 'claude-code', title: 'Offscreen original UX validation' } }) + '\n');
  await hello;
  fs.appendFileSync(CONTROL, 'inbox busy off\n');
  const k = require('koffi'), user = k.load('user32.dll');
  const proto = k.proto('bool __stdcall OriginalPillEnum(intptr hwnd,intptr lp)');
  const enumerate = user.func('bool __stdcall EnumWindows(OriginalPillEnum *cb,intptr lp)');
  const pidOf = user.func('uint __stdcall GetWindowThreadProcessId(intptr hwnd,_Out_ uint *pid)');
  const text = user.func('int __stdcall GetWindowTextW(intptr hwnd,_Out_ uint16 *buf,int count)');
  const style = user.func('uint __stdcall GetWindowLongW(intptr hwnd,int index)');
  const rect = user.func('bool __stdcall GetWindowRect(intptr hwnd,_Out_ int *rect)');
  const visible = user.func('bool __stdcall IsWindowVisible(intptr hwnd)');
  let hwnd;
  enumerate(h => { const pid = [0]; pidOf(h, pid); if (pid[0] !== proc.pid) return true; const title = Buffer.alloc(1024); text(h, title, 512); if (title.toString('utf16le').split('\0')[0] === 'dictate') hwnd = h; return true; }, 0);
  check('single original pill HWND exists', !!hwnd);
  check('real pill never activates and starts click-through', (style(hwnd, -20) & (0x20 | 0x8000000)) === (0x20 | 0x8000000));
  const snapshot = async name => { const shot = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(DATA, name + '.png'), Buffer.from(shot.result.data, 'base64')); };
  await sleep(1200);
  let card = await call('notify', { title: 'Original compact card', message: 'Original floating surface; native input enabled.', urgency: 'needs_you' });
  await until(() => evaluate("!!document.querySelector('.card')"));
  check('original hover disclosure restored', await evaluate("!document.querySelector('.snz')"));
  check('no container header or added Close chrome', await evaluate("!document.querySelector('.window-head,.window-close')&&getComputedStyle(document.body).backgroundColor==='rgba(0, 0, 0, 0)'"));
  fs.appendFileSync(CONTROL, 'cards-hover on\n');
  await until(() => evaluate("!!document.querySelector('.snz button')"));
  await sleep(350);
  await snapshot('expanded');
  check('one Snooze button, for the first length', await evaluate("[...document.querySelectorAll('.snz button')].map(b=>b.textContent).join(',')==='◷Snooze 3 min'"));
  await click('.snz button[data-min="3"]');
  await until(async () => (await call('card_status', { card_id: card.card_id })).state === 'snoozed');
  await until(() => evaluate("!!document.querySelector('.toast')"));
  await snapshot('snooze-toast');
  await until(() => evaluate("!document.querySelector('.toast')"));
  check('original five-second toast automatically disappears', true);
  await snapshot('snoozed-badge');
  check('only original compact snoozed capsule remains', await evaluate("(()=>{const b=document.querySelector('.capsule.snoozed');const r=b.getBoundingClientRect();return r.width<200&&r.height<=30&&!document.querySelector('.card,.toast,.window-head,.window-close')})()"));
  await click('.capsule.snoozed');
  await until(() => evaluate("!!document.querySelector('.shelfrow button.x')"));
  await click('.shelfrow button.x');
  await until(() => !visible(hwnd));
  check('last content removed hides native HWND; no invisible permanent input window', true);
  fs.appendFileSync(CONTROL, 'cards-hover off\n');
  card = await call('notify', { title: 'Dismiss original card', urgency: 'needs_you' });
  await until(() => evaluate("!!document.querySelector('.card button.x')"));
  await click('.card button.x');
  await until(async () => (await call('card_status', { card_id: card.card_id })).state === 'dismissed');
  await until(() => !visible(hwnd));
  check('original dismiss cross mutates queue and automatically hides empty host', true);
  fs.appendFileSync(CONTROL, 'state {"kind":"toast","message":"Microphone changed","undo":true,"ms":600}\n');
  await until(() => evaluate("document.querySelector('#root').classList.contains('visible')&&!document.querySelector('.status .undo').hidden"));
  await snapshot('mic-undo');
  await until(() => !visible(hwnd));
  check('original mic Undo placement and toast auto-hide restored', true);
  const bounds = [0, 0, 0, 0]; rect(hwnd, bounds);
  check('validation stayed offscreen', bounds[2] < 0);
  fs.writeFileSync(path.join(DATA, 'native.json'), JSON.stringify({ hwnd: String(hwnd), exstyle: style(hwnd, -20).toString(16), bounds, hiddenWhenEmpty: !visible(hwnd) }, null, 2));
  console.log('Evidence', DATA);
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  fs.writeFileSync(path.join(DATA, 'results.json'), JSON.stringify({ checks, limitation: 'Offscreen renderer/IPC and native policy only; restored UX needs user visual approval.' }, null, 2));
  ws?.close(); socket?.destroy();
  if (proc) { fs.appendFileSync(CONTROL, 'quit\n'); await sleep(1000); if (proc.exitCode === null) proc.kill(); }
});
