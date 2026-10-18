// Headless QA for native mic capture: no keys are injected and nothing is pasted, so it can run while the
// machine is in use. The hotkey is driven through DICTATE_QA_CONTROL and output goes to the log
// (DICTATE_QA_SINK=none). Its profile uses F24 as the dictation key, so it never reacts to real typing.
//   node qa/native.js            fixture WAV through native capture, then cold/warm timings on the real mic,
//                                then the browser path for comparison
// The real-mic holds are 0.6 s; their text is deleted with the QA profile at the end.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'tmp', 'qa-native-data');
const LOG = path.join(DATA, 'logs', 'dictate.log');
const CONTROL = path.join(DATA, 'control.txt');
const WAV = 'C:\\repos\\experiments\\worktrees\\voice-lab\\voice-lab\\fixtures\\synthetic\\s1.wav';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const mark = () => (fs.existsSync(LOG) ? fs.statSync(LOG).size : 0);
const since = (m) => (fs.existsSync(LOG) ? fs.readFileSync(LOG).subarray(m).toString('utf8') : '');
async function waitLog(re, ms, m) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(100)) if (re.test(since(m))) return true;
  return false;
}

let app;
function start(env) {
  fs.mkdirSync(DATA, { recursive: true });
  app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.'], {
    cwd: ROOT,
    env: { ...process.env, DICTATE_DATA_DIR: DATA, DICTATE_QA_SINK: 'none', DICTATE_QA_CONTROL: CONTROL, ...env },
    stdio: 'ignore',
  });
}
function stop() {
  if (app) execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
  app = undefined;
}
function settings(patch) {
  const f = path.join(DATA, 'settings.json');
  fs.mkdirSync(DATA, { recursive: true });
  const s = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  Object.assign(s, { onboarded: true, hotkey: { keys: [0x87] }, picker: null, toggle: null, cleanup: 'gemma-emberon', micOrder: [] }, patch);
  fs.writeFileSync(f, JSON.stringify(s, null, 2));
}
async function hold(ms) {
  const m = mark();
  fs.appendFileSync(CONTROL, 'down\n');
  await sleep(ms);
  fs.appendFileSync(CONTROL, 'up\n');
  await waitLog(/release-to-output|nothing heard/, 15000, m);
  await sleep(300);
  return since(m);
}
const firstMs = (log) => {
  const x = /first audio (\d+) ms after key down \((cold|warm) mic\)/.exec(log);
  return x ? { ms: Number(x[1]), kind: x[2] } : null;
};
async function boot(env) {
  const m = mark();
  start(env);
  const ok = await waitLog(/gemma ready/, 40000, m);
  await waitLog(/speech model loaded/, 10000, m);
  return { ok, log: () => since(m) };
}

(async () => {
  fs.rmSync(DATA, { recursive: true, force: true });
  const timings = { fixture: [], coldReal: [], idleReal: [], warmReal: [], browserReal: [], browserIdle: [] };
  /** The device powers down within seconds of its last stream: an `idle` hold waits this long first. */
  const IDLE_MS = 25000;

  // 1. The fixture through native capture, end to end.
  settings({ micWarm: 'off' });
  let b = await boot({ DICTATE_FAKE_MIC: WAV });
  check('native: app starts', b.ok);
  check('native: capture ready', /native mic capture ready/.test(b.log()));
  for (let i = 1; i <= 3; i++) {
    const log = await hold(5400);
    const f = firstMs(log);
    if (f) timings.fixture.push(f.ms);
    check(`native fixture ${i}: transcribed and delivered`, /QA delivered \d+ chars: ".*Kubernetes/.test(log), (/QA delivered.*/.exec(log) ?? [''])[0].slice(0, 120));
    check(`native fixture ${i}: first audio logged`, !!f, f ? `${f.ms} ms (${f.kind})` : '');
  }
  stop();

  // 2. The real mic: key down to first audio, cold (Off) then warm (30 s).
  settings({ micWarm: 'off' });
  b = await boot({});
  for (let i = 0; i < 4; i++) {
    const f = firstMs(await hold(600));
    if (f) timings.coldReal.push(f.ms);
    await sleep(800);
  }
  for (let i = 0; i < 2; i++) {
    await sleep(IDLE_MS);
    const f = firstMs(await hold(1200));
    if (f) timings.idleReal.push(f.ms);
  }
  stop();
  settings({ micWarm: '30s' });
  b = await boot({});
  for (let i = 0; i < 4; i++) {
    const f = firstMs(await hold(600));
    if (f) timings[i === 0 ? 'coldReal' : 'warmReal'].push(f.ms);
    await sleep(800);
  }
  const closed = await waitLog(/mic closed \(expired\)/, 33000, mark() - 2000);
  check('warm 30 s: the mic closes after 30 s', closed);
  stop();

  // 3. The browser path on the real mic, for comparison.
  settings({ micWarm: 'off' });
  b = await boot({ DICTATE_CAPTURE: 'browser' });
  for (let i = 0; i < 3; i++) {
    const log = await hold(900);
    const x = /\(browser\), mic open in (\d+) ms after key down/.exec(log);
    if (x) timings.browserReal.push(Number(x[1]));
    await sleep(800);
  }
  for (let i = 0; i < 2; i++) {
    await sleep(IDLE_MS);
    const x = /\(browser\), mic open in (\d+) ms after key down/.exec(await hold(1500));
    if (x) timings.browserIdle.push(Number(x[1]));
  }
  stop();

  const med = (a) => (a.length ? [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)] : null);
  // Recorded, not asserted: on the AMD array the device's own wake-up dominates a cold start (see the PR).
  console.log(`info native cold (recently used) ${JSON.stringify(timings.coldReal)}, native cold (idle ${IDLE_MS / 1000} s) ${JSON.stringify(timings.idleReal)}, browser ${JSON.stringify(timings.browserReal)}, browser idle ${JSON.stringify(timings.browserIdle)}`);
  check('native starts faster than the browser path from idle', med(timings.idleReal) !== null && med(timings.browserIdle) !== null && med(timings.idleReal) < med(timings.browserIdle), `${med(timings.idleReal)} vs ${med(timings.browserIdle)} ms`);
  check('native warm start under 30 ms (real mic, median)', med(timings.warmReal) !== null && med(timings.warmReal) < 30, JSON.stringify(timings.warmReal));
  const summary = { results, timings, medians: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, med(v)])) };
  fs.mkdirSync(path.join(ROOT, 'tmp', 'qa', 'out'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'tmp', 'qa', 'out', 'native.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary.medians));
  // What the real mic heard stays nowhere.
  fs.rmSync(path.join(DATA, 'history.json'), { force: true });
  console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
})().catch((e) => {
  console.error(e);
  stop();
  process.exit(1);
});
