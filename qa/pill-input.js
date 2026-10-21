// Visible Windows source preview and native mouse regression checks (isolated profile).
// pnpm build && node qa/pill-input.js           # verifies and closes its own app
// pnpm build && node qa/pill-input.js --preview # leaves seeded card open until Ctrl+C
// Needs an unlocked desktop. Moves the OS pointer; does not type into other apps.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { agentSession, ELECTRON } = require('./agent-bridge');
const k = require('koffi');
const u = k.load('user32.dll');
const pointType = k.struct('PillPoint', { x: 'int', y: 'int' });
const WindowAt = u.func('__stdcall', 'WindowFromPoint', 'intptr', [pointType]);
const SetCursorPos = u.func('bool __stdcall SetCursorPos(int x, int y)');
const mouse = u.func('void __stdcall mouse_event(uint flags, uint dx, uint dy, uint data, uintptr extra)');
const gdi = k.load('gdi32.dll');
const MakeRegion = gdi.func('intptr __stdcall CreateRectRgn(int left, int top, int right, int bottom)');
const ReadRegion = gdi.func('uint __stdcall GetRegionData(intptr region, uint count, _Out_ void *data)');
const DeleteRegion = gdi.func('bool __stdcall DeleteObject(intptr region)');
const WindowRegion = u.func('int __stdcall GetWindowRgn(intptr hwnd, intptr region)');
const Foreground = u.func('intptr __stdcall GetForegroundWindow()');
const Affinity = u.func('bool __stdcall GetWindowDisplayAffinity(intptr hwnd, _Out_ uint *affinity)');
const GetRect = u.func('bool __stdcall GetWindowRect(intptr hwnd, _Out_ int *rect)');
const Thread = u.func('uint __stdcall GetWindowThreadProcessId(intptr hwnd, _Out_ uint *pid)');
const Title = u.func('int __stdcall GetWindowTextW(intptr hwnd, _Out_ uint16 *text, int count)');
const enumType = k.proto('bool __stdcall EnumPill(intptr hwnd, intptr param)');
const EnumWindows = u.func('bool __stdcall EnumWindows(EnumPill *callback, intptr param)');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tmp', 'verify', 'pill-input');
const preview = process.argv.includes('--preview');
const DATA = path.join(OUT, `data-${process.pid}`);
const CONTROL = path.join(DATA, 'control.txt');
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(CONTROL, '');
fs.writeFileSync(
  path.join(DATA, 'settings.json'),
  JSON.stringify({ onboarded: true, hotkeys: [{ keys: [0x81] }], toggle: null, picker: null, sounds: false }),
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc,
  agent,
  ws,
  seq = 1;
const waiting = new Map();
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(ok ? 'PASS' : 'FAIL', name, JSON.stringify(detail));
  if (!ok) throw Error(name);
}
async function evaluate(expression) {
  const id = seq++;
  const p = new Promise((r) => waiting.set(id, r));
  ws.send(
    JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }),
  );
  return (await p).result?.result?.value;
}
async function waitFor(fn) {
  for (let i = 0; i < 100; i++) {
    const r = await fn();
    if (r) return r;
    await sleep(100);
  }
  throw Error('wait timed out');
}
let hwnd, rect;
async function click(label) {
  const at = await evaluate(
    `(()=>{const b=[...document.querySelectorAll('button')].find(b=>!b.hidden&&b.getClientRects().length&&(b.textContent.trim()===${JSON.stringify(label)}||b.title===${JSON.stringify(label)}));if(!b)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
  );
  if (!at) throw Error('missing ' + label);
  const foreground = Foreground();
  SetCursorPos(
    Math.round(rect[0] + (at.x * (rect[2] - rect[0])) / 600),
    Math.round(rect[1] + (at.y * (rect[3] - rect[1])) / 420),
  );
  mouse(2, 0, 0, 0, 0);
  mouse(4, 0, 0, 0, 0);
  await sleep(250);
  check('focus preserved: ' + label, Foreground() === foreground);
}
async function snapshot(name) {
  const id = seq++;
  const p = new Promise((r) => waiting.set(id, r));
  ws.send(JSON.stringify({ id, method: 'Page.captureScreenshot', params: { format: 'png' } }));
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from((await p).result.data, 'base64'));
  const region = MakeRegion(0, 0, 0, 0);
  try {
    check(`${name}: native region present`, WindowRegion(hwnd, region) > 0);
    const size = ReadRegion(region, 0, null);
    const bytes = Buffer.alloc(size);
    ReadRegion(region, size, bytes);
    const rects = [];
    for (let offset = 32; offset + 16 <= size; offset += 16)
      rects.push([0, 4, 8, 12].map((i) => bytes.readInt32LE(offset + i)));
    fs.writeFileSync(
      path.join(OUT, `${name}-region.json`),
      JSON.stringify({ width: rect[2] - rect[0], height: rect[3] - rect[1], rects }),
    );
  } finally {
    DeleteRegion(region);
  }
}
async function main() {
  proc = spawn(ELECTRON, ['.', '--remote-debugging-port=0'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DICTATE_DATA_DIR: DATA,
      DICTATE_QA_CONTROL: CONTROL,
      DICTATE_QA_SINK: 'none',
      DICTATE_SMOKE_SKIP_INSTANCE_LOCK: '1',
      DICTATE_PILL_SHOTS: '',
      PANE_SESSION_ID: '',
      PANE_PANEL_ID: '',
      PANE_DIR: path.join(DATA, 'no-pane'),
    },
    stdio: 'ignore',
  });
  proc.on('error', (error) => console.error(error));
  const portFile = path.join(DATA, 'DevToolsActivePort');
  const port = await waitFor(() => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').split('\n')[0]);
  const target = await waitFor(async () => {
    try {
      return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) =>
        t.url.endsWith('pill.html'),
      );
    } catch {}
  });
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => {
    const v = JSON.parse(m.data);
    waiting.get(v.id)?.(v);
    waiting.delete(v.id);
  };
  await waitFor(() => fs.existsSync(path.join(DATA, 'agents', 'dictate-mcp.js')));
  agent = agentSession(DATA, { cwd: ROOT });
  await agent.list();
  await agent.call('notify', { title: 'agent-e2e-pill-first', urgency: 'needs_you' });
  await waitFor(() => evaluate("document.querySelector('.card')?.innerText.includes('agent-e2e-pill-first')"));
  await sleep(400);
  const affinities = [];
  const cb = k.register((h) => {
    const pid = [0];
    Thread(h, pid);
    const t = new Uint16Array(256);
    Title(h, t, 256);
    const title = Buffer.from(t.buffer).toString('utf16le').split('\0')[0];
    if (/dictate/i.test(title)) {
      const a = [999];
      Affinity(h, a);
      affinities.push({ pid: pid[0], title, affinity: a[0] });
    }
    if (pid[0] === proc.pid && title === 'dictate') hwnd = h;
    return true;
  }, k.pointer(enumType));
  EnumWindows(cb, 0);
  k.unregister(cb);
  fs.writeFileSync(path.join(OUT, 'window-affinities.json'), JSON.stringify(affinities, null, 2));
  if (!hwnd) throw Error('no pill HWND');
  rect = [0, 0, 0, 0];
  GetRect(hwnd, rect);
  if (preview) {
    console.log(
      `Local preview PID ${proc.pid}; profile ${DATA}. Try Snooze, Undo, shelf, Now, Dismiss. Ctrl+C closes only this preview.`,
    );
    await new Promise((resolve) => process.once('SIGINT', resolve));
    return;
  }
  check('unused native window bounds pass through', WindowAt({ x: rect[0] + 5, y: rect[1] + 5 }) !== hwnd);
  const affinity = [999];
  Affinity(hwnd, affinity);
  check('pill capture affinity is WDA_NONE', affinity[0] === 0, { hwnd: String(hwnd), rect, affinity });
  await snapshot('01-card');
  await evaluate(
    'window.__regionFrames=0;window.__originalRAF=window.requestAnimationFrame;window.requestAnimationFrame=(fn)=>{window.__regionFrames++;return window.__originalRAF(fn);};',
  );
  await sleep(300);
  check('settled card schedules no geometry frames', await evaluate('window.__regionFrames===0'));
  check(
    'actions visible without hover',
    await evaluate("[...document.querySelectorAll('.card button')].some(b=>b.textContent.trim()==='3m')"),
  );
  await click('3m');
  await waitFor(() => evaluate("!!document.querySelector('.inbox .toast')"));
  check('OS Snooze click removed card', await evaluate("!document.querySelector('.card')"));
  await snapshot('02-snooze-undo');
  await click('Undo');
  await waitFor(() => evaluate("!!document.querySelector('.card')"));
  await click('Dismiss');
  await waitFor(() => evaluate("!document.querySelector('.card')"));
  await agent.call('notify', { title: 'agent-e2e-pill-replacement', urgency: 'needs_you' });
  await waitFor(() => evaluate("document.querySelector('.card')?.innerText.includes('replacement')"));
  await sleep(300);
  await click('5m');
  await waitFor(() => evaluate("!!document.querySelector('.inbox .toast')"));
  await click('Show snoozed cards');
  await waitFor(() => evaluate("!!document.querySelector('.shelf')"));
  await snapshot('03-shelf');
  await click('Now');
  await waitFor(() => evaluate("!!document.querySelector('.card')"));
  await click('Dismiss');
  const answer = agent.call('ask', { question: 'agent-e2e-pill-choice', choices: ['Staging', 'Production'] });
  await waitFor(() => evaluate("document.querySelector('.card')?.innerText.includes('agent-e2e-pill-choice')"));
  await sleep(300);
  await click('Staging');
  const reply = await answer;
  check('OS choice read back over MCP', reply.result?.choice === 'Staging', reply);
  fs.appendFileSync(
    CONTROL,
    'state {"kind":"toast","message":"Local microphone Undo preview","undo":true,"ms":10000}\n',
  );
  await waitFor(() =>
    evaluate(
      "document.querySelector('.status .pill').dataset.kind==='toast' && getComputedStyle(document.querySelector('.status')).opacity==='1'",
    ),
  );
  await sleep(100);
  await snapshot('04-status-undo');
  await click('Undo');
  await waitFor(() => evaluate("document.querySelector('.status .pill').dataset.kind==='info'"));
  await sleep(300);
  await snapshot('05-status-idle');
  const idleAt = await evaluate(
    "(()=>{const r=document.querySelector('.status .pill').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()",
  );
  check(
    'idle status passes native input',
    WindowAt({ x: Math.round(rect[0] + idleAt.x), y: Math.round(rect[1] + idleAt.y) }) !== hwnd,
  );
  fs.appendFileSync(
    CONTROL,
    'state {"kind":"listening","mode":"push-to-talk","finish":"Release to finish"}\npartial A wide dictation status preview verifies text and hint geometry.\n',
  );
  await waitFor(() =>
    evaluate(
      "document.querySelector('.above.shown') && document.querySelector('.status .pill').dataset.kind==='listening'",
    ),
  );
  await sleep(350);
  await snapshot('06-status-hint');
  check('all OS clicks completed', true);
}
main()
  .catch((e) => {
    results.push({ error: e.stack });
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    fs.writeFileSync(
      path.join(OUT, preview ? 'preview-results.json' : 'os-results.json'),
      JSON.stringify(results, null, 2),
    );
    ws?.close();
    await agent?.close();
    if (proc) {
      fs.appendFileSync(CONTROL, 'quit\n');
      await sleep(1000);
      if (proc.exitCode === null) proc.kill();
    }
  });
