// Screenshots of the real pill window in every state, for each design variant (DICTATE_PILL_VARIANT=a|b|c).
// Headless: the pill sits off-screen and is captured by Electron; the fixture WAV drives the live states;
// no keys are injected and nothing is pasted. Writes tmp/pill-shots/<variant>-<state>.png.
//   node qa/pillshots.js [a b c]
//   node qa/pillshots.js cards   (agents' cards, driven through the real MCP bridge; no models needed)
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { agentSession } = require('./agent-bridge');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'tmp', 'qa-pill-data');
const SHOTS = path.join(ROOT, 'tmp', 'pill-shots');
const LOG = path.join(DATA, 'logs', 'dictate.log');
const CONTROL = path.join(DATA, 'control.txt');
const WAV = 'C:\\repos\\experiments\\worktrees\\voice-lab\\voice-lab\\fixtures\\readaloud\\three-sentences.wav';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cmd = (line) => fs.appendFileSync(CONTROL, `${line}\n`);
const since = (m) => (fs.existsSync(LOG) ? fs.readFileSync(LOG).subarray(m).toString('utf8') : '');

/** Electron's helpers let go of the profile a moment after taskkill. */
const rmData = () => fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });

async function run(variant) {
  rmData();
  fs.rmSync(path.join(SHOTS, `${variant}-*`), { force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ onboarded: true, hotkey: { keys: [0x87] }, toggle: null, picker: null, micOrder: [], sounds: false }));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.'], {
    cwd: ROOT,
    env: { ...process.env, DICTATE_DATA_DIR: DATA, DICTATE_FAKE_MIC: WAV, DICTATE_QA_SINK: 'none', DICTATE_QA_CONTROL: CONTROL, DICTATE_PILL_SHOTS: SHOTS, DICTATE_PILL_VARIANT: variant },
    stdio: 'ignore',
  });
  try {
    for (let t = Date.now(); !/gemma ready/.test(since(0)) && Date.now() - t < 40000; ) await sleep(200);
    await sleep(500);
    // Start-up (mic still opening), first session: with the hint.
    cmd(JSON.stringify({ kind: 'listening', mode: 'push-to-talk', finish: 'Release to finish', starting: true }).replace(/^/, 'state '));
    await sleep(900);
    cmd('state {"kind":"hidden"}');
    await sleep(400);
    // Push-to-talk on the fixture: live words, then transcribing, cleaning, done.
    cmd('down');
    await sleep(3800);
    cmd('shot listening-words');
    await sleep(3200);
    cmd('shot listening-long');
    await sleep(600);
    cmd('up');
    for (let t = Date.now(); !/release-to-output/.test(since(0)) && Date.now() - t < 15000; ) await sleep(100);
    await sleep(1500);
    // Hands-free (a double-tap).
    cmd('down');
    await sleep(60);
    cmd('up');
    await sleep(120);
    cmd('down');
    await sleep(60);
    cmd('up');
    await sleep(2500);
    cmd('shot listening-handsfree-words');
    cmd('down');
    await sleep(60);
    cmd('up');
    for (let t = Date.now(); since(0).split('release-to-output').length < 3 && Date.now() - t < 15000; ) await sleep(100);
    await sleep(1500);
    // A line longer than the pill: the newest words stay in view and the start fades out.
    cmd('state {"kind":"listening","mode":"push-to-talk","finish":"Release to finish"}');
    cmd('partial Run the tests again and show me what fails. Have Codex write the Terraform module, then let Opus review it before we apply it to Kubernetes');
    await sleep(700);
    cmd('shot listening-overflow');
    await sleep(200);
    // Outcomes that the fixture does not produce.
    cmd('state {"kind":"copied","message":"Pasted · also on the clipboard"}');
    await sleep(800);
    cmd('state {"kind":"error","message":"Microphone error: the device was unplugged"}');
    await sleep(800);
  } finally {
    execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
  }
}

/** Agents' cards: collapsed, expanded, replying, the preview, consent, stacked and the list, as real cards. */
async function runCards() {
  rmData();
  fs.rmSync(path.join(SHOTS, 'cards-*'), { force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ onboarded: true, hotkeys: [{ keys: [0x81] }], toggle: null, picker: null, sounds: false, agentHistory: true }));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.'], {
    cwd: ROOT,
    env: { ...process.env, DICTATE_DATA_DIR: DATA, DICTATE_QA_SINK: 'none', DICTATE_QA_CONTROL: CONTROL, DICTATE_PILL_SHOTS: SHOTS, DICTATE_PILL_VARIANT: 'cards', PANE_SESSION_ID: '', PANE_PANEL_ID: '' },
    stdio: 'ignore',
  });
  const sessions = [];
  try {
    for (let t = Date.now(); !/agents: channel open/.test(since(0)) && Date.now() - t < 30000; ) await sleep(200);
    // A Pane tab when this runs inside one (names come from runpane, read-only); a plain folder otherwise.
    const pane = process.env.PANE_SESSION_ID ? { PANE_SESSION_ID: process.env.PANE_SESSION_ID, PANE_PANEL_ID: process.env.PANE_PANEL_ID } : {};
    const codex = agentSession(DATA, { client: 'codex-mcp-client', title: 'Codex', env: pane, cwd: ROOT });
    sessions.push(codex);
    await codex.call('notify', { title: 'Approve the migration?', message: 'Dropping users.legacy_id rewrites 2.1 M rows. Say “go” to run it on staging first, or tell me what to change.', urgency: 'needs_you', choices: ['Staging', 'Prod'], link: 'https://github.com/parsakhaz/open-dictate/pull/7' });
    await sleep(900);
    cmd('shot collapsed');
    await sleep(500);
    cmd('cards-hover on');
    await sleep(600);
    cmd('shot expanded');
    await sleep(500);
    cmd('cards-hover off');
    cmd('state {"kind":"listening","mode":"push-to-talk","finish":"Release to finish","replyTo":"Codex"}');
    cmd('partial use staging');
    await sleep(700);
    cmd('shot replying');
    await sleep(300);
    cmd('state {"kind":"reply-preview","message":"Use staging.","to":"Codex"}');
    await sleep(700);
    cmd('shot preview');
    await sleep(300);
    cmd('state {"kind":"hidden"}');
    const claude = agentSession(DATA, { client: 'claude-code', title: 'Claude Code', cwd: ROOT });
    sessions.push(claude);
    const consent = claude.call('read_history', { query: 'migration' });
    await sleep(900);
    cmd('shot consent');
    await sleep(300);
    cmd('card consent deny');
    await consent;
    const cursor = agentSession(DATA, { client: 'cursor-vscode', title: 'Cursor', cwd: path.join(ROOT, 'docs') });
    sessions.push(cursor);
    await claude.call('notify', { title: 'Tests are green', urgency: 'needs_you' });
    await cursor.call('notify', { title: 'Which branch should I rebase?', urgency: 'needs_you' });
    await sleep(900);
    cmd('shot stacked');
    await sleep(300);
    cmd('cards-list');
    await sleep(600);
    cmd('shot list');
    await sleep(500);
  } finally {
    for (const s of sessions) await s.close();
    execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
  }
}

(async () => {
  if (process.argv[2] === 'cards') {
    await runCards();
    console.log(`cards: ${fs.readdirSync(SHOTS).filter((f) => f.startsWith('cards-')).join(', ')}`);
    if (!process.env.KEEP) rmData();
    return;
  }
  fs.rmSync(SHOTS, { recursive: true, force: true });
  const variants = process.argv.slice(2).length ? process.argv.slice(2) : ['a', 'b', 'c'];
  for (const v of variants) {
    await run(v);
    console.log(`${v}: ${fs.readdirSync(SHOTS).filter((f) => f.startsWith(`${v}-`)).join(', ')}`);
  }
  if (!process.env.KEEP) rmData();
})();
