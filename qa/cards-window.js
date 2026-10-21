// Offscreen real-renderer/IPC checks. Never moves the OS pointer or opens a desktop card.
// This verifies action logic and native window configuration; manual OS clicking is still required.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { ELECTRON } = require('./agent-bridge');
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'tmp/verify/cards-window', `data-${process.pid}`);
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
  const targets = await until(async () => { try { return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch {} });
  const target = targets.find(t => t.url.endsWith('cards.html'));
  assert.ok(target, 'card renderer exists separately from pill');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  ws.onmessage = e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
  await until(() => fs.existsSync(path.join(DATA, 'agents/channel.json')));
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
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
  socket.write(JSON.stringify({ t: 'hello', token: channel.token, client: { name: 'claude-code', title: 'Offscreen card validation' } }) + '\n');
  await hello;
  fs.appendFileSync(CONTROL, 'inbox busy off\n');
  let card = await call('notify', { title: 'Offscreen standard buttons', urgency: 'needs_you' });
  await until(() => evaluate("!!document.querySelector('.card .snooze')"));
  check('Snooze names the default duration', await evaluate("document.querySelector('.snooze').getAttribute('aria-label')==='Snooze for 3 minutes'"));
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(DATA, 'card.png'), Buffer.from(shot.result.data, 'base64'));
  if (process.platform === 'win32') {
    const k = require('koffi');
    const user = k.load('user32.dll');
    const proto = k.proto('bool __stdcall CardsEnum(intptr hwnd,intptr lp)');
    const enumerate = user.func('bool __stdcall EnumWindows(CardsEnum *cb,intptr lp)');
    const pidOf = user.func('uint __stdcall GetWindowThreadProcessId(intptr hwnd,_Out_ uint *pid)');
    const text = user.func('int __stdcall GetWindowTextW(intptr hwnd,_Out_ uint16 *buf,int count)');
    const style = user.func('uint __stdcall GetWindowLongW(intptr hwnd,int index)');
    const rect = user.func('bool __stdcall GetWindowRect(intptr hwnd,_Out_ int *rect)');
    let native;
    enumerate(hwnd => {
      const pid = [0]; pidOf(hwnd, pid);
      if (pid[0] !== proc.pid) return true;
      const title = Buffer.alloc(1024); text(hwnd, title, 512);
      if (title.toString('utf16le').split('\0')[0] !== 'Dictate cards') return true;
      const bounds = [0, 0, 0, 0]; rect(hwnd, bounds);
      native = { hwnd: String(hwnd), exstyle: style(hwnd, -20), bounds };
      return true;
    }, 0);
    check('card HWND uses normal input and activation styles', native && !(native.exstyle & (0x20 | 0x8000000)));
    check('validation card remains offscreen', native.bounds[2] < 0);
    fs.writeFileSync(path.join(DATA, 'native.json'), JSON.stringify(native, null, 2));
  }
  await click('.snooze');
  await until(async () => (await call('card_status', { card_id: card.card_id })).state === 'snoozed');
  check('Snooze immediately mutates queue and removes card', await evaluate("!document.querySelector('.card') && !!document.querySelector('.toast .undo')"));
  await click('button.capsule.snoozed');
  await until(() => evaluate("!!document.querySelector('.shelf .now')"));
  await evaluate("window.__shelfButton=document.querySelector('.shelf .now');window.__shelfButton.focus()");
  await sleep(1200);
  check('shelf countdown preserves action node and keyboard focus', await evaluate("window.__shelfButton===document.querySelector('.shelf .now')&&document.activeElement===window.__shelfButton"));
  await click('.shelf .now');
  await until(() => evaluate("!!document.querySelector('.card')"));
  await click('.snooze');
  await click('.toast .undo');
  await until(() => evaluate("!!document.querySelector('.card')"));
  await click('.card button[aria-label="Dismiss card"]');
  await until(async () => (await call('card_status', { card_id: card.card_id })).state === 'dismissed');
  check('Dismiss mutates queue', true);
  card = await call('notify', { title: 'Offscreen Escape', urgency: 'needs_you' });
  await until(() => evaluate("!!document.querySelector('.card')"));
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await until(async () => (await call('card_status', { card_id: card.card_id })).state === 'dismissed');
  check('Escape dismisses through real renderer key handler', true);
  card = await call('notify', { title: 'Offscreen Close', urgency: 'needs_you' });
  await until(() => evaluate("!!document.querySelector('.card')"));
  await click('.window-close');
  await until(async () => (await call('card_status', { card_id: card.card_id })).state === 'dismissed');
  check('Close dismisses current card', true);
  await click('.window-close');
  fs.appendFileSync(CONTROL, 'state ' + JSON.stringify({ kind: 'toast', undo: true, message: 'Offscreen mic Undo', ms: 60000 }) + '\n');
  await until(() => evaluate("!document.querySelector('.mic-undo').hidden && document.visibilityState==='visible'"));
  check('fresh mic Undo reopens a previously closed card window', true);
  fs.appendFileSync(CONTROL, 'state {"kind":"info","message":"Done"}\n');

  const openSheet = async (kind, payload) => {
    fs.appendFileSync(CONTROL, `sheet ${kind} ${JSON.stringify(payload)}\n`);
    await connectPage(port, 'sheet.html');
    await until(() => evaluate(`document.body?.dataset.kind===${JSON.stringify(kind)}`));
    await evaluate("window.__clicked='';document.addEventListener('click',e=>{const b=e.target.closest('button');if(b)window.__clicked=b.textContent.trim();},true)");
  };
  await openSheet('round', { position: { n: 1, of: 1 }, chips: [], card: { id: 'audit-round', source: 'Audit', age: 0, title: 'Keyboard test', message: '', choices: ['Approve'], canOpen: false }, lengths: [3, 5], listening: false, heard: '' });
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.startsWith('Skip')).focus()");
  await key('Enter', 'Enter', 13);
  check('Enter activates focused round Skip instead of approving', (await evaluate('window.__clicked')).startsWith('Skip'));
  await click('button[aria-label="Leave round"]');
  await until(() => evaluate('!document.body.dataset.kind'));
  check('Leave round is a working mouse button', true);

  const questions = [{ id: 'q1', header: 'First', options: [{ label: 'A' }, { label: 'B' }], multi: false, other: false }];
  await openSheet('decide', { cardId: 'audit-decide', source: 'Audit', client: 'Audit', title: 'Keyboard test', message: '', questions, answers: [{ picked: [] }], previews: false });
  check('decision options are semantic buttons with pressed state', await evaluate("[...document.querySelectorAll('.dopt')].every(b=>b.tagName==='BUTTON'&&b.hasAttribute('aria-pressed'))"));
  check('hover keeps option nodes alive', await evaluate("(()=>{const b=document.querySelector('.dopt');b.dispatchEvent(new MouseEvent('mouseenter'));return b===document.querySelector('.dopt')})()"));
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Skip').focus()");
  await key('Tab', 'Tab', 9);
  check('decide Tab reaches Submit instead of navigating questions', (await evaluate('document.activeElement.textContent')).startsWith('Submit answers'));
  await evaluate("window.__clicked='';document.querySelector('button.x').focus()");
  await key('Enter', 'Enter', 13);
  await until(() => evaluate('!document.body.dataset.kind'));
  check('Enter on decide Close closes instead of submitting', true);

  await openSheet('lineup', { cardId: 'audit-lineup', title: 'Keyboard test', source: 'Audit', message: '', pick: 'one', max: 1, candidates: [{ label: 'A', caption: '', text: 'Candidate A' }, { label: 'B', caption: '', text: 'Candidate B' }] });
  await evaluate("document.querySelector('button.x').focus()");
  await key('Enter', 'Enter', 13);
  await until(() => evaluate('!document.body.dataset.kind'));
  check('Enter on lineup Close closes instead of submitting picks', true);
  await openSheet('lineup', { cardId: 'audit-lineup-small', title: 'Small work area', source: 'Audit', message: '', pick: 'one', max: 1, candidates: [{ label: 'A', caption: '', text: 'Candidate A' }, { label: 'B', caption: '', text: 'Candidate B' }] });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 360, height: 320, deviceScaleFactor: 1, mobile: false });
  check('small sheet Close remains in reachable viewport', await evaluate("(()=>{const r=document.querySelector('button.x').getBoundingClientRect();return r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()"));
  check('small lineup footer buttons reflow inside viewport', await evaluate("[...document.querySelectorAll('.lu-foot button')].every(b=>{const r=b.getBoundingClientRect();return r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})"));
  const smallShot = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(DATA, 'small-sheet.png'), Buffer.from(smallShot.result.data, 'base64'));
  await connectPage(port, 'picker.html');
  check('empty history offers a real mouse Close button', await evaluate("document.querySelector('button[aria-label=\"Close history\"]')?.tagName==='BUTTON'"));
  fs.appendFileSync(CONTROL, 'picker-render ' + JSON.stringify([{ id: 'audit-history', at: new Date().toISOString(), text: 'History sample', raw: 'Raw history sample' }]) + '\n');
  await until(() => evaluate("!!document.querySelector('button.paste')"));
  check('history has native search, semantic Paste and visible actions', await evaluate("document.querySelector('.query').tagName==='INPUT'&&getComputedStyle(document.querySelector('.actions')).pointerEvents==='auto'&&getComputedStyle(document.querySelector('.actions')).opacity==='1'"));
  const pickerShot = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(DATA, 'history-picker.png'), Buffer.from(pickerShot.result.data, 'base64'));
  await evaluate("window.__clicked='';document.addEventListener('click',e=>{const b=e.target.closest('button');if(b)window.__clicked=b.textContent.trim();},true);document.querySelector('button.close').focus()");
  await key('Enter', 'Enter', 13);
  check('picker Enter activates focused Close rather than pasting selected history', await evaluate("window.__clicked==='Close'"));
  fs.appendFileSync(CONTROL, 'picker-render []\n');
  await until(() => evaluate("!document.querySelector('button.paste')"));

  fs.appendFileSync(CONTROL, 'settings-page general\n');
  await connectPage(port, 'settings.html');
  await until(() => evaluate("!!document.querySelector('.navitem')"));
  check('settings navigation consists of semantic buttons', await evaluate("[...document.querySelectorAll('.navitem')].every(b=>b.tagName==='BUTTON')"));
  await evaluate("navigator.mediaDevices.getUserMedia=async()=>{throw new Error('Audit skips physical microphone capture')}");
  fs.appendFileSync(CONTROL, 'settings-page microphone\n');
  await until(() => evaluate("!!document.querySelector('input[name=\"mic\"]')"));
  check('microphone selection uses native radio controls with visible keyboard focus', await evaluate("(()=>{const input=document.querySelector('input[name=\"mic\"]');input.focus();return input.type==='radio'&&getComputedStyle(input.nextElementSibling).outlineStyle!=='none'})()"));
  fs.appendFileSync(CONTROL, 'settings-page history\n');
  await until(() => evaluate("document.querySelector('h1')?.textContent==='History'"));
  check('settings history uses native controls', await evaluate("!!document.querySelector('select')&&[...document.querySelectorAll('button')].some(b=>b.textContent==='Clear')"));
  fs.appendFileSync(CONTROL, 'settings-page start\n');
  await until(() => evaluate("!!document.querySelector('button[data-wiz=\"next\"]')"));
  check('welcome has a semantic next button', await evaluate("document.querySelector('[data-wiz=\"next\"]').tagName==='BUTTON'"));
  const errors = fs.readFileSync(path.join(DATA, 'logs/dictate.log'), 'utf8').split('\n').filter(l => /renderer .*error|renderer .*unhandled|cards renderer gone/.test(l));
  check('no card renderer errors', errors.length === 0);
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  fs.writeFileSync(path.join(DATA, 'results.json'), JSON.stringify({ checks, limitation: 'No OS pointer input: manual click validation remains required.' }, null, 2));
  ws?.close(); socket?.destroy();
  if (proc) { fs.appendFileSync(CONTROL, 'quit\n'); await sleep(1000); if (proc.exitCode === null) proc.kill(); }
});
