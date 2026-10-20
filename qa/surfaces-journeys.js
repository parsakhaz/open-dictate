// Off-screen journeys for the agent surfaces (J1–J16 of the cover sheet), one file per lane in qa/surfaces/. The real
// app on a throwaway profile and a throwaway Pane folder, agents simulated by the real MCP bridge, keys and clicks
// through the QA control file: the OS pointer, keyboard, real Pane and real agent configs are never touched.
// Each lane file exports { lane, settings?, journeys: [{ id, name, run(ctx) }] }; ctx is below.
// Writes tmp/surfaces-journeys/report.json and screenshots in tmp/surfaces-journeys/shots; exits non-zero on a failed check.
//   pnpm build && node qa/surfaces-journeys.js            every lane
//   node qa/surfaces-journeys.js P0 L1                    only these lanes
// Voice journeys need the speech model: set DICTATE_MODELS_DIR to an isolated copy (scripts/setup-test-model.mjs).
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { agentSession, ELECTRON } = require('./agent-bridge');

const ROOT = path.resolve(process.env.DICTATE_QA_APP_ROOT || path.join(__dirname, '..'));
const OUT = path.resolve(__dirname, '..', 'tmp', 'surfaces-journeys');
const DATA = path.join(OUT, 'data');
const SHOTS = path.join(OUT, 'shots');
const PANE_DIR = path.join(OUT, 'pane');
const AGENT_HOME = path.join(OUT, 'agent-home');
const CONTROL = path.join(DATA, 'control.txt');
const LOG = path.join(DATA, 'logs', 'dictate.log');
const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'two-sentences.wav');
const MODELS = process.env.DICTATE_MODELS_DIR;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cmd = (line) => fs.appendFileSync(CONTROL, `${line}\n`);
const log = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '');
const checks = [];

function loadLanes(only) {
  const dir = path.join(__dirname, 'surfaces');
  const lanes = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort().map((f) => require(path.join(dir, f)));
  return only.length ? lanes.filter((l) => only.includes(l.lane)) : lanes;
}

function launch(lanes) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(PANE_DIR, { recursive: true });
  fs.mkdirSync(AGENT_HOME, { recursive: true });
  // The base profile of the cards journeys, plus whatever each lane needs (its keys, its section).
  const settings = Object.assign({ onboarded: true, hotkeys: [{ keys: [0x81] }], toggle: null, picker: null, sounds: false, cleanup: 'off' }, ...lanes.map((l) => l.settings ?? {}));
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify(settings));
  fs.writeFileSync(CONTROL, '');
  const env = { ...process.env, DICTATE_DATA_DIR: DATA, DICTATE_QA_SINK: 'none', DICTATE_QA_CONTROL: CONTROL, DICTATE_PILL_SHOTS: SHOTS, DICTATE_CAPTURE: 'browser', DICTATE_FAKE_MIC: FIXTURE, DICTATE_AGENT_HOME: AGENT_HOME, PANE_SESSION_ID: '', PANE_PANEL_ID: '', PANE_DIR };
  if (!MODELS) delete env.DICTATE_MODELS_DIR;
  return spawn(ELECTRON, ['.'], { cwd: ROOT, env, stdio: 'ignore' });
}

async function untilLog(re, ms = 30_000, from = 0) {
  for (const t = Date.now(); Date.now() - t < ms; await sleep(100)) {
    const m = log().slice(from).match(re);
    if (m) return m;
  }
  return null;
}

/** Sends a QA line and parses the JSON the app logs back for it. */
async function qa(line, re, ms = 5000) {
  const mark = log().length;
  cmd(line);
  const m = await untilLog(re, ms, mark);
  return m ? JSON.parse(m[1]) : null;
}

/** A PNG of the pill window (shots/a-<name>.png). */
async function shot(name) {
  const file = path.join(SHOTS, `a-${name}.png`);
  fs.rmSync(file, { force: true });
  cmd(`shot ${name}`);
  for (let i = 0; i < 50 && !fs.existsSync(file); i++) await sleep(100);
  return file;
}

/** A PNG of the sheet window (shots/sheet-<name>.png). */
async function sheetShot(name) {
  const file = path.join(SHOTS, `sheet-${name}.png`);
  fs.rmSync(file, { force: true });
  cmd(`sheet-shot ${name}`);
  for (let i = 0; i < 50 && !fs.existsSync(file); i++) await sleep(100);
  return file;
}

async function main() {
  const only = process.argv.slice(2);
  const lanes = loadLanes(only);
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  const app = launch(lanes);
  const sessions = [];
  const ctx = {
    ROOT, OUT, DATA, SHOTS, PANE_DIR, MODELS,
    sleep, cmd, log, untilLog, qa, shot, sheetShot,
    /** An agent connected through the real bridge: { call(name, args), list(), close() }. */
    session: (o) => {
      const s = agentSession(DATA, o);
      sessions.push(s);
      return s;
    },
    cards: () => qa('cards-dump', /QA cards (.+)\n/),
    sheet: () => qa('sheet-dump', /QA sheet (.+)\n/),
    check: null,
  };
  try {
    const opened = await untilLog(/agents: channel open/);
    checks.push({ journey: 'setup', what: 'the app opened the agent channel', ok: !!opened });
    if (MODELS) checks.push({ journey: 'setup', what: 'the speech model loaded', ok: !!(await untilLog(/speech model loaded/, 60_000)) });
    for (const lane of lanes) {
      for (const j of lane.journeys) {
        ctx.check = (what, ok, detail) => {
          checks.push({ lane: lane.lane, journey: j.id, what, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
          console.log(`${ok ? 'PASS' : 'FAIL'} ${lane.lane} ${j.id} ${what}${ok ? '' : ` :: ${JSON.stringify(detail)}`}`);
        };
        console.log(`-- ${lane.lane} ${j.id} ${j.name}`);
        try {
          await j.run(ctx);
        } catch (err) {
          ctx.check(`ran without throwing (${err.message})`, false, err.stack);
        }
      }
    }
  } finally {
    for (const s of sessions.splice(0)) await s.close();
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    else app.kill('SIGKILL');
    await sleep(1500);
  }

  fs.writeFileSync(path.join(OUT, 'report.json'), `${JSON.stringify({ at: new Date().toISOString(), lanes: lanes.map((l) => l.lane), voice: !!MODELS, checks }, null, 2)}\n`);
  const failed = checks.filter((c) => !c.ok);
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
