// Off-screen journeys for the agent cards on the pill (issue #9): a click on a choice answers the ask, the card shows
// its whole title and message, eased open and capped, it stays up while a voice reply is held, and info cards last
// about 4.5 s (longer while hovered) while the vocabulary review stays until handled. The real app on a throwaway
// profile, agents simulated by the real MCP bridge; clicks are input events sent into the pill page and the key is
// the QA control file, so the OS pointer and keyboard are never touched.
// The voice reply needs the speech model: set DICTATE_MODELS_DIR to an isolated copy (scripts/setup-test-model.mjs).
// Writes tmp/cards-journeys/report.json and screenshots in tmp/cards-journeys/shots; exits non-zero on a failed check.
//   pnpm build && node qa/cards-journeys.js
// DICTATE_QA_SHOTS_ONLY=1 takes the screenshots without the checks, for a "before" run of an older build.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { agentSession, ELECTRON } = require('./agent-bridge');

const ROOT = path.resolve(process.env.DICTATE_QA_APP_ROOT || path.join(__dirname, '..'));
const OUT = path.resolve(__dirname, '..', 'tmp', process.env.DICTATE_QA_SHOTS_ONLY ? 'cards-journeys-before' : 'cards-journeys');
const DATA = path.join(OUT, 'data');
const SHOTS = path.join(OUT, 'shots');
const CONTROL = path.join(DATA, 'control.txt');
const LOG = path.join(DATA, 'logs', 'dictate.log');
const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'two-sentences.wav');
const MODELS = process.env.DICTATE_MODELS_DIR;
const shotsOnly = !!process.env.DICTATE_QA_SHOTS_ONLY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cmd = (line) => fs.appendFileSync(CONTROL, `${line}\n`);
const log = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '');
const checks = [];
function check(journey, what, ok, detail) {
  if (shotsOnly) return;
  checks.push({ journey, what, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${journey} ${what}${ok ? '' : ` :: ${JSON.stringify(detail)}`}`);
}

function launch() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ onboarded: true, hotkeys: [{ keys: [0x81] }], toggle: null, picker: null, sounds: false, cleanup: 'off' }));
  fs.writeFileSync(CONTROL, '');
  const env = { ...process.env, DICTATE_DATA_DIR: DATA, DICTATE_QA_SINK: 'none', DICTATE_QA_CONTROL: CONTROL, DICTATE_PILL_SHOTS: SHOTS, DICTATE_CAPTURE: 'browser', DICTATE_FAKE_MIC: FIXTURE, PANE_SESSION_ID: '', PANE_PANEL_ID: '', PANE_DIR: path.join(OUT, 'no-pane') };
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

/** Asks the app a QA question and parses the JSON it logs back. */
async function qa(line, re) {
  const mark = log().length;
  cmd(line);
  const m = await untilLog(re, 5000, mark);
  return m ? JSON.parse(m[1]) : null;
}
const dump = () => qa('cards-dump', /QA cards (.+)\n/);
const layout = () => qa('card-layout', /QA card-layout (.+)\n/);

async function shot(name) {
  const file = path.join(SHOTS, `a-${name}.png`);
  fs.rmSync(file, { force: true });
  cmd(`shot ${name}`);
  for (let i = 0; i < 50 && !fs.existsSync(file); i++) await sleep(100);
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  const app = launch();
  const sessions = [];
  const session = (o) => {
    const s = agentSession(DATA, o);
    sessions.push(s);
    return s;
  };
  try {
    check('setup', 'the app opened the agent channel', await untilLog(/agents: channel open/), log().slice(-2000));
    if (MODELS) check('setup', 'the speech model loaded', await untilLog(/speech model loaded/, 60_000), log().slice(-1500));
    const claude = session({ client: 'claude-code', title: 'Claude Code', cwd: path.join(ROOT, 'docs') });

    // 1. A click on a choice answers the ask. 2/3. The whole title and message show at rest, eased open.
    const title = 'Which environment should the migration run against before the release goes out tonight?';
    const message = 'The schema change adds two columns and backfills them. Staging has a copy of last week’s data; prod has the real traffic.';
    const ask = claude.call('ask', { question: title, message, choices: ['Staging', 'Prod', 'Both', 'Neither'], timeout_s: 120 });
    await sleep(900);
    await shot('01-ask-at-rest');
    let l = await layout();
    check('glance', 'at rest the whole title shows, with the message', l && !l.titleClipped && l.text.includes(title) && l.text.includes('backfills'), l);
    cmd('cards-hover on');
    await sleep(600);
    await shot('02-ask-hovered');
    l = await layout();
    check('glance', 'hovered, the choices show under the whole title', l && !l.titleClipped && ['Staging', 'Prod', 'Both', 'Neither'].every((c) => l.buttons.includes(c)), l);
    const click = await qa('card-click Prod', /QA card-click "Prod" (.+)\n/);
    check('click', 'the centre of the "Prod" button is the button itself', click?.hit === 'button', click);
    const answer = await Promise.race([ask, sleep(3000).then(() => null)]);
    check('click', 'clicking "Prod" returns that choice to the agent', answer?.result?.answered === true && answer.result.choice === 'Prod', answer);
    if (!answer) cmd('card dismiss');
    cmd('cards-hover off');
    await sleep(500);

    // Every button of a short card takes its click while the pill is idle, the middle ones included (the hidden
    // pill used to sit under the middle of the button row and swallow them).
    for (const pick of ['Neither', 'Both']) {
      const short = claude.call('ask', { question: 'Which region?', choices: ['Staging', 'Prod', 'Both', 'Neither'], timeout_s: 60 });
      await sleep(900);
      cmd('cards-hover on');
      await sleep(500);
      const hit = await qa(`card-click ${pick}`, new RegExp(`QA card-click "${pick}" (.+)\n`));
      check('click', `on a short card, "${pick}" (middle of the row) takes the click`, hit?.hit === 'button', hit);
      const got = await Promise.race([short, sleep(3000).then(() => null)]);
      check('click', `clicking "${pick}" returns it to the agent`, got?.result?.choice === pick, got);
      if (!got) cmd('card dismiss');
      cmd('cards-hover off');
      await sleep(400);
    }

    // Markdown: bold, italic and code styled; other marks dropped; HTML shown as its characters.
    const md = claude.call('ask', { question: '## **Ship** the `v2` API?', message: '**Breaking:** renames `user_id`.\n- see [the plan](https://example.com)\n- <img src=x onerror=alert(1)> stays *text*', timeout_s: 60 });
    await sleep(900);
    await shot('08-markdown');
    l = await layout();
    check('markdown', 'the title shows without its marks', l && l.text.includes('Ship the v2 API?') && !/[#*`]/.test(l.text.split('\n')[1] ?? ''), l);
    check('markdown', 'bold, code and italic are styled, the link is its text, lists are lines', l && ['strong:Breaking:', 'code:user_id', 'em:text'].every((x) => l.styled.includes(x)) && l.text.includes('\nsee the plan\n'), l);
    check('markdown', 'an <img onerror> tag shows as its characters and is never an element', l && l.text.includes('<img src=x onerror=alert(1)> stays text') && l.elements === 0, l);
    cmd('card dismiss');
    await md;
    await sleep(400);

    // A very long title and message: shown whole, the card capped and scrolling inside.
    const long = claude.call('ask', { question: `Before I continue: ${'should the importer keep the legacy column names and translate them on read, '.repeat(2)}or rename them now?`, message: 'Details. '.repeat(150).trim(), choices: ['Keep', 'Rename'], timeout_s: 120 });
    await sleep(900);
    await shot('03-long-at-rest');
    l = await layout();
    // The tools cap the title at a few lines and the message at a paragraph; the card still fits the pill window.
    check('cap', 'the longest card the tools allow fits above the pill, its title whole', l && l.cardHeight <= 300 && !l.titleClipped, l);
    cmd('cards-hover on');
    await sleep(600);
    await shot('04-long-hovered');
    cmd('card dismiss');
    await long;
    cmd('cards-hover off');
    await sleep(500);

    // 4. The card stays up while the person holds the key to answer it.
    const spoken = claude.call('ask', { question: 'What should the release notes lead with?', timeout_s: 120 });
    await sleep(900);
    cmd('cards-hover on');
    await sleep(400);
    cmd('card arm-reply');
    await sleep(300);
    l = await layout();
    check('reply', 'Hold to reply marks the card armed', (await dump())?.armed && l?.buttons.includes('Hold your key to reply'), l);
    cmd('cards-hover off');
    const mark = log().length;
    cmd('down');
    await sleep(1500);
    await shot('05-replying');
    const d = await dump();
    l = await layout();
    check('reply', 'while the key is held, the card being answered stays on the pill', d?.top?.title === 'What should the release notes lead with?' && !!d.replying, d);
    check('reply', 'the card says it is being answered', l?.replying && /Replying by voice/.test(l.text), l);
    if (MODELS) {
      check('reply', 'one dictation uses up Hold to reply', d?.armed === null, d);
      const p = await qa('pill-dump', /QA pill (.+)\n/);
      check('reply', 'the pill says which card the words go to', p?.above === 'Answering: What should the release notes lead with?', p);
    }
    if (MODELS) {
      await sleep(2500);
      cmd('up');
      await untilLog(/reply-preview|dictation \d+: final/, 30_000, mark);
      await sleep(400);
      await shot('06-reply-preview');
      const r = await Promise.race([spoken, sleep(20_000).then(() => null)]);
      check('reply', 'the spoken answer reaches the agent', r?.result?.answered === true && r.result.text.length > 0, r);
    } else {
      cmd('up');
      await sleep(1500);
      cmd('card dismiss');
      await spoken;
    }
    await sleep(1500);

    // 5. Info cards last about 4.5 s, paused while hovered; the vocabulary review stays.
    const t0 = Date.now();
    await claude.call('notify', { title: 'Build finished', message: 'All 312 tests passed.' });
    await sleep(Math.max(0, 3800 - (Date.now() - t0)));
    check('timing', 'an info card is still up after 3.8 s', (await dump())?.top?.title === 'Build finished');
    await sleep(Math.max(0, 5600 - (Date.now() - t0)));
    check('timing', 'and gone by 5.6 s', (await dump())?.top === null);
    await claude.call('notify', { title: 'Deploy started' });
    await sleep(1000);
    cmd('cards-hover on');
    await sleep(6000);
    check('timing', 'a hovered info card waits', (await dump())?.top?.title === 'Deploy started');
    cmd('cards-hover off');
    // It had 1 s on screen before the hover: 3.5 s are left.
    await sleep(2500);
    check('timing', 'after the pointer leaves it gets the rest of its time', (await dump())?.top?.title === 'Deploy started');
    await sleep(2000);
    check('timing', 'and then fades', (await dump())?.top === null);
    // Pointed at with almost no time left: it still stays about 2 s after the pointer leaves.
    const t1 = Date.now();
    await claude.call('notify', { title: 'Lint clean' });
    await sleep(Math.max(0, 4000 - (Date.now() - t1)));
    cmd('cards-hover on');
    await sleep(3000);
    check('timing', 'a card pointed at near the end of its time never fades while pointed at', (await dump())?.top?.title === 'Lint clean');
    cmd('cards-hover off');
    await sleep(1200);
    check('timing', 'it is still up 1.2 s after the pointer leaves', (await dump())?.top?.title === 'Lint clean');
    await sleep(2300);
    check('timing', 'and gone by 3.5 s after', (await dump())?.top === null);
    const codex = session({ client: 'codex-mcp-client', title: 'Codex', cwd: path.join(ROOT, 'docs') });
    await codex.call('propose_vocabulary', { terms: [{ term: 'Turso' }, { term: 'pgvector' }, { term: 'Hono' }, { term: 'Drizzle' }, { term: 'Supabase' }, { term: 'Bun' }] });
    await codex.close();
    await sleep(500);
    await shot('07-vocab');
    await sleep(7000);
    const v = await dump();
    check('timing', 'the vocabulary review is still up 7 s later, after the agent disconnected', /^Suggests \d+ terms/.test(v?.top?.title ?? ''), v);
  } finally {
    for (const s of sessions.splice(0)) await s.close();
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    else app.kill('SIGKILL');
    await sleep(1500);
  }

  fs.writeFileSync(path.join(OUT, 'report.json'), `${JSON.stringify({ at: new Date().toISOString(), voiceReply: !!MODELS, checks }, null, 2)}\n`);
  const failed = checks.filter((c) => !c.ok);
  console.log(`${checks.length - failed.length}/${checks.length} checks passed${MODELS ? '' : ' (voice reply delivery skipped: no DICTATE_MODELS_DIR)'}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
