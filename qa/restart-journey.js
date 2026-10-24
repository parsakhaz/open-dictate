// Off-screen journey for cards across a restart: an MCP ask (snoozed once) and a CLI request wait on the pill, the
// app is killed without a chance to save on quit, and after the relaunch both are back, in order, with their snooze
// count, the MCP card's old card_id and the CLI request's id and instance. The real app on a throwaway profile, the
// agent through the real MCP bridge, the CLI through the launcher the app installs in that profile.
// Writes tmp/restart-journey/report.json and screenshots in tmp/restart-journey/shots; exits non-zero on a failed check.
//   pnpm build && node qa/restart-journey.js
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { agentSession, ELECTRON } = require('./agent-bridge');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tmp', 'restart-journey');
const DATA = path.join(OUT, 'data');
const SHOTS = path.join(OUT, 'shots');
const CONTROL = path.join(DATA, 'control.txt');
const LOG = path.join(DATA, 'logs', 'dictate.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cmd = (line) => fs.appendFileSync(CONTROL, `${line}\n`);
const log = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '');
const checks = [];
function check(what, ok, detail) {
  checks.push({ what, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${ok ? '' : ` :: ${JSON.stringify(detail)}`}`);
}

function launch() {
  fs.writeFileSync(CONTROL, '');
  const env = { ...process.env, DICTATE_DATA_DIR: DATA, DICTATE_QA_SINK: 'none', DICTATE_QA_CONTROL: CONTROL, DICTATE_PILL_SHOTS: SHOTS, DICTATE_CAPTURE: 'browser', PANE_SESSION_ID: '', PANE_PANEL_ID: '', PANE_DIR: path.join(OUT, 'no-pane') };
  delete env.DICTATE_MODELS_DIR;
  return spawn(ELECTRON, ['.'], { cwd: ROOT, env, stdio: 'ignore' });
}

function kill(app) {
  if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
  else app.kill('SIGKILL');
}

async function untilLog(re, ms = 30_000, from = 0) {
  for (const t = Date.now(); Date.now() - t < ms; await sleep(100)) {
    const m = log().slice(from).match(re);
    if (m) return m;
  }
  return null;
}

async function qa(line, re) {
  const mark = log().length;
  cmd(line);
  const m = await untilLog(re, 5000, mark);
  return m ? JSON.parse(m[1]) : null;
}
const cards = () => qa('cards-dump', /QA cards (.+)\n/);
const inbox = () => qa('inbox dump', /QA inbox (\{.*\})\r?\n/);
const pill = () => qa('inbox pill none', /QA inbox pill (\{.*\})\r?\n/);

async function shot(name) {
  const file = path.join(SHOTS, `a-${name}.png`);
  fs.rmSync(file, { force: true });
  cmd(`shot ${name}`);
  for (let i = 0; i < 50 && !fs.existsSync(file); i++) await sleep(100);
}

/** The CLI the app installed in the profile, as an agent runs it. */
function cli(args, input) {
  return new Promise((resolve) => {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DICTATE_AGENT_CHANNEL: path.join(DATA, 'agents', 'channel.json') };
    delete env.PANE_SESSION_ID;
    delete env.PANE_PANEL_ID;
    const p = spawn(ELECTRON, [path.join(DATA, 'agents', 'dictate-cli.js'), ...args, '--json'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => {
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve({ unparsed: out });
      }
    });
    p.stdin.end(input ? JSON.stringify(input) : '');
  });
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ onboarded: true, hotkeys: [{ keys: [0x81] }], toggle: null, picker: null, sounds: false, cleanup: 'off' }));
  const sessions = [];
  let app = launch();
  try {
    check('the app opened the agent channel', await untilLog(/agents: channel open/, 60_000));
    check('the pill is ready', await untilLog(/pill ready/, 60_000));
    cmd('inbox busy off');
    const agent = agentSession(DATA, { client: 'claude-code', title: 'Claude Code' });
    sessions.push(agent);
    const ask = agent.call('ask', { question: 'Which region should the nightly backup use?', choices: ['EU', 'US'], timeout_s: 600 });
    let d = null;
    for (let i = 0; i < 40 && d?.top?.title !== 'Which region should the nightly backup use?'; i++) {
      await sleep(250);
      d = await inbox();
    }
    const mcpId = d?.top?.id;
    check('the MCP ask is on the pill', !!mcpId, d);
    cmd('inbox snooze');
    await sleep(400);
    await pill();
    cmd('inbox pill snoozed');
    await sleep(300);
    cmd(`inbox pill now ${mcpId}`);
    await sleep(400);
    const created = await cli(['request', 'create', '--from-json', '-'], { kind: 'ask', args: { question: 'Roll the new checkout out to 10%?', choices: ['Roll it out', 'Wait'] } });
    check('the CLI request is accepted', typeof created.request_id === 'string' && created.terminal === false, created);
    const before = await cards();
    check('both wait on the pill, the older first', JSON.stringify(before?.all) === JSON.stringify(['Which region should the nightly backup use?', 'Roll the new checkout out to 10%?']), before);
    // The cards are saved a moment after each change; give that write its time, then kill without a quit.
    await sleep(1500);
    kill(app);
    await Promise.race([ask, sleep(5000)]);
    await agent.close();
    sessions.length = 0;
    await sleep(1500);

    const mark = log().length;
    app = launch();
    check('the app opened the agent channel again', await untilLog(/agents: channel open/, 60_000, mark));
    check('it says the cards are back', await untilLog(/agents: 2 cards back from before the restart/, 10_000, mark), log().slice(mark).slice(-1500));
    await untilLog(/pill ready/, 60_000, mark);
    cmd('inbox busy off');
    await sleep(1500);
    const after = await cards();
    check('after the restart both cards are back, in the same order', JSON.stringify(after?.all) === JSON.stringify(['Which region should the nightly backup use?', 'Roll the new checkout out to 10%?']), after);
    await shot('restart-back');
    cmd('cards-hover on');
    await sleep(500);
    const p = await pill();
    check('the MCP card kept its snooze count: its button says 5 min', p && /Snooze 5 min/.test(p.chips[0] ?? ''), p);
    await shot('restart-back-hovered');
    cmd('cards-hover off');
    const again = agentSession(DATA, { client: 'claude-code', title: 'Claude Code' });
    sessions.push(again);
    let s = await again.call('card_status', { card_id: mcpId });
    check('card_status still knows the MCP card by its old id', s.result?.state === 'shown', s.result);
    const got = await cli(['request', 'get', created.request_id]);
    check('the CLI request is still pending, with the same id and instance', got.request_id === created.request_id && got.instance_id === created.instance_id && got.terminal === false, got);
    cmd('card choose EU');
    await sleep(600);
    s = await again.call('card_status', { card_id: mcpId });
    check('answering it after the restart reaches card_status under the old id', s.result?.state === 'answered' && s.result.answer?.choice === 'EU', s.result);
    cmd('card choose Roll it out');
    const done = await cli(['request', 'wait', created.request_id, '--timeout', '5s']);
    check('the CLI request gets its answer', done.state === 'answered' && done.result?.choice === 'Roll it out', done);
  } finally {
    for (const x of sessions) await x.close();
    kill(app);
    await sleep(1500);
  }
  fs.writeFileSync(path.join(OUT, 'report.json'), `${JSON.stringify({ at: new Date().toISOString(), checks }, null, 2)}\n`);
  const failed = checks.filter((c) => !c.ok);
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
