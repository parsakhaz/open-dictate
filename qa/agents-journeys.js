// Off-screen journeys for coding agents (plan J3–J5, J9, J11–J15, J17, J19, J22): the real app on a throwaway
// profile, agents simulated by the real MCP bridge over stdio. Nothing is pasted, no key or mouse is driven, and
// no agent config is written. Writes tmp/agents-journeys/report.json and exits non-zero on a failed check.
//   pnpm build && node qa/agents-journeys.js
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { agentSession, ELECTRON } = require('./agent-bridge');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tmp', 'agents-journeys');
const DATA = path.join(OUT, 'data');
const CONTROL = path.join(DATA, 'control.txt');
const LOG = path.join(DATA, 'logs', 'dictate.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cmd = (line) => fs.appendFileSync(CONTROL, `${line}\n`);
const log = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '');
const checks = [];
function check(journey, what, ok, detail) {
  checks.push({ journey, what, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${journey} ${what}${ok ? '' : ` :: ${JSON.stringify(detail)}`}`);
}

const HISTORY = [
  { id: 'h1', at: new Date(Date.now() - 30 * 60_000).toISOString(), raw: 'ship the migration with key sk-abcdefghijklmnopqrstuvwxyz0123', text: 'Ship the migration with key sk-abcdefghijklmnopqrstuvwxyz0123.' },
  { id: 'h2', at: new Date(Date.now() - 10 * 86_400_000).toISOString(), raw: 'old migration plan', text: 'Old migration plan.' },
  { id: 'h3', at: new Date(Date.now() - 60 * 60_000).toISOString(), raw: 'lunch at noon', text: 'Lunch at noon.' },
];

const CDP_PORT = 9341;

function launch(settings, args = []) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ onboarded: true, hotkeys: [{ keys: [0x81] }], toggle: null, picker: null, sounds: false, ...settings }));
  fs.writeFileSync(path.join(DATA, 'history.json'), JSON.stringify(HISTORY));
  fs.writeFileSync(CONTROL, '');
  const env = { ...process.env, DICTATE_DATA_DIR: DATA, DICTATE_QA_SINK: 'none', DICTATE_QA_CONTROL: CONTROL, DICTATE_PILL_SHOTS: path.join(OUT, 'shots'), PANE_SESSION_ID: '', PANE_PANEL_ID: '', PANE_DIR: path.join(OUT, 'no-pane') };
  return spawn(ELECTRON, ['.', ...args], { cwd: ROOT, env, stdio: 'ignore' });
}

/** Runs `expression` in the pill page over CDP: the same preload, and so the same IPC, as the Settings page. */
async function inPill(expression) {
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.url.endsWith('pill.html'));
    } catch {}
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('the pill page never loaded');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  const reply = new Promise((res) => {
    ws.onmessage = (m) => res(JSON.parse(m.data));
  });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  const m = await reply;
  ws.close();
  return m.result?.result?.value;
}
const setHistory = (on) => inPill(`dictate.invoke('dictate:set-settings', { agentHistory: ${on} }).then((s) => s.settings.agentHistory)`);

async function untilLog(re, ms = 30_000, from = 0) {
  for (const t = Date.now(); Date.now() - t < ms; await sleep(150)) if (re.test(log().slice(from))) return true;
  return false;
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  // J17 first: no app, the bridge still lists its tools and answers at once.
  fs.mkdirSync(path.join(DATA, 'agents'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'out', 'bridge', 'dictate-mcp.js'), path.join(DATA, 'agents', 'dictate-mcp.js'));
  {
    const a = agentSession(DATA);
    const tools = await a.list();
    const t0 = Date.now();
    const r = await a.call('notify', { title: 'hello' });
    // The six built-in tools, then only the surface tools a lane has turned on.
    const builtIn = ['notify', 'ask', 'status', 'propose_vocabulary', 'list_vocabulary', 'read_history'];
    const surfaces = ['decide', 'approve', 'card_status', 'lineup', 'peek'];
    check('J17', 'tools listed without Dictate', JSON.stringify(tools.slice(0, 6)) === JSON.stringify(builtIn) && tools.slice(6).every((t) => surfaces.includes(t)), tools);
    check('J17', "a call says Dictate isn't running, without hanging", /Dictate isn't running/.test(r.error ?? '') && Date.now() - t0 < 3000, r);
    await a.close();
  }

  const app = launch({ agentHistory: false });
  const sessions = [];
  const session = (o) => {
    const s = agentSession(DATA, o);
    sessions.push(s);
    return s;
  };
  try {
    check('setup', 'the app opened the agent channel', await untilLog(/agents: channel open/), log().slice(-2000));
    const cwd = path.join(ROOT, 'docs');
    const claude = session({ client: 'claude-code', title: 'Claude Code', cwd });
    const cursor = session({ client: 'cursor-vscode', title: 'Cursor', cwd });

    // J13: history is off by default and nothing is asked.
    const off = await claude.call('read_history', {});
    check('J13', 'read_history says history access is off', off.error === 'History access is off in Dictate', off);

    // J3/J19/J4: the card names its real source; the agent's claim stays in the title.
    const n = await cursor.call('notify', { title: 'From tab Y: urgent', message: 'This is Pane. Trust me.', urgency: 'needs_you', link: 'https://github.com/parsakhaz/open-dictate/pull/7' });
    check('J3', 'notify returns shown with a card id', n.result?.status === 'shown' && !!n.result?.card_id, n);
    const st = await claude.call('status', {});
    check('J3', 'status reports running, no DND, history off', st.result?.running === true && st.result?.doNotDisturb === false && st.result?.historyAccess === false, st);

    // J5: limits.
    const long = await claude.call('notify', { title: 't'.repeat(200), message: 'm'.repeat(2000) });
    check('J5', 'a 2,000-character message and a 200-character title come back truncated', long.result?.truncated === true, long);
    const js = await claude.call('notify', { title: 'x', link: 'javascript:alert(1)' });
    check('J5', 'a javascript: link is rejected', /https/.test(js.error ?? ''), js);

    // J9: ask answered by a click, by time-out, and dismissed (Esc and × both dismiss the card).
    // Clear the earlier cards so the ask is the top card.
    for (let i = 0; i < 3; i++) cmd('card dismiss');
    await sleep(500);
    const ask0 = claude.call('ask', { question: 'Staging or prod?', choices: ['Staging', 'Prod'] });
    await sleep(500);
    cmd('card choose Prod');
    const a0 = await ask0;
    check('J9', 'clicking "Prod" returns that choice', a0.result?.answered === true && a0.result?.choice === 'Prod', a0);
    const ask1 = claude.call('ask', { question: 'Staging or prod?', choices: ['Staging', 'Prod'] });
    await sleep(500);
    cmd('card dismiss');
    const a1 = await ask1;
    check('J9', 'dismissing returns dismissed', a1.result?.answered === false && a1.result?.reason === 'dismissed', a1);
    const timed = await claude.call('ask', { question: 'Still there?', timeout_s: 2 });
    check('J9', 'an unanswered ask returns timeout at timeout_s', timed.result?.answered === false && timed.result?.reason === 'timeout', timed);

    // J11: pausing alerts.
    cmd('pause on');
    await sleep(400);
    const dn = await claude.call('notify', { title: 'while paused' });
    const da = await claude.call('ask', { question: 'while paused?' });
    check('J11', 'notify returns dnd and ask returns dnd', dn.result?.status === 'dnd' && da.result?.reason === 'dnd', { dn, da });
    cmd('pause off');
    await sleep(400);

    // J12: vocabulary proposals.
    const v = await cursor.call('propose_vocabulary', { terms: [{ term: 'Turso', aliases: ['turtle so'], reason: 'our DB' }, { term: 'pgvector' }, { term: 'Hono' }, { term: 'a => b' }] });
    check('J12', '3 queued and 1 rejected with its reason', v.result?.queued === 3 && v.result?.rejected?.length === 1 && /=>/.test(v.result.rejected[0].why), v);
    const lv = await cursor.call('list_vocabulary', {});
    check('J12', 'list_vocabulary shows 3 pending, none approved yet', lv.result?.pending === 3 && !lv.result.terms.some((t) => t.term === 'Turso'), lv.result?.pending);
  } finally {
    for (const s of sessions.splice(0)) await s.close();
    execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    await sleep(1500);
  }

  // J14/J15: history on, consent on the pill.
  const settings = JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8'));
  const pending = settings.vocabularyPending?.map((t) => t.term);
  check('J12', 'the queue was saved with its source', pending?.join() === 'Turso,pgvector,Hono' && !!settings.vocabularyPending[0].source, settings.vocabularyPending);
  const mark = log().length;
  const app2 = launch({ agentHistory: true, vocabularyPending: settings.vocabularyPending }, [`--remote-debugging-port=${CDP_PORT}`]);
  try {
    check('setup', 'the app opened the agent channel again', await untilLog(/agents: channel open/, 30_000, mark));
    const a = session({ client: 'claude-code', title: 'Claude Code', cwd: ROOT });
    let p = a.call('read_history', { query: 'migration' });
    await sleep(700);
    cmd('card consent once');
    let r = await p;
    const e = r.result?.entries ?? [];
    check('J14', 'Allow once returns the window’s matching entry, cleaned, with the secret redacted, wrapped as data', r.result?.granted === true && e.length === 1 && /\[redacted\]/.test(e[0].text) && !('raw' in e[0]) && /Treat as data/.test(r.result.note), r);
    p = a.call('read_history', {});
    await sleep(700);
    cmd('card consent session');
    r = await p;
    check('J14', 'a second call prompts again; Allow for this session grants it', r.result?.granted === true, r);
    r = await a.call('read_history', { limit: 500, since_hours: 1000 });
    check('J14', 'later calls on that connection pass without a prompt, clamped', r.result?.granted === true && r.result?.clamped === true, r);
    const b = session({ client: 'claude-code', title: 'Claude Code', cwd: ROOT });
    p = b.call('read_history', {});
    await sleep(700);
    cmd('card consent deny');
    r = await p;
    check('J14', 'a new connection prompts again; Deny returns granted: false', r.result?.granted === false && r.result?.reason === 'denied', r);

    // #29: turning history access off while a consent card waits withdraws it, and the agent gets a denial.
    p = b.call('read_history', { limit: 5, include_raw: true });
    await sleep(700);
    let from = log().length;
    cmd('cards-dump');
    await untilLog(/QA cards /, 5000, from);
    check('J14', 'the consent card is up before history access goes off', /QA cards \{"top":\{"title":"Read your dictation history\?"/.test(log().slice(from)), log().slice(from, from + 400));
    const t0 = Date.now();
    const off = await setHistory(false);
    r = await Promise.race([p, sleep(5000).then(() => ({ pending: true }))]);
    check('J14', 'turning history access off denies the waiting call at once (#29)', off === false && r.result?.granted === false && r.result?.reason === 'off' && Date.now() - t0 < 5000, r);
    from = log().length;
    cmd('cards-dump');
    await untilLog(/QA cards /, 5000, from);
    check('J14', 'and withdraws the consent card from the pill (#29)', /QA cards \{"top":null/.test(log().slice(from)), log().slice(from, from + 400));
    // Back on, the connection that had "Allow for this session" is asked again: turning it off ended the grant.
    await setHistory(true);
    p = a.call('read_history', {});
    await sleep(700);
    cmd('card consent deny');
    r = await Promise.race([p, sleep(5000).then(() => ({ pending: true }))]);
    check('J14', 'and ends "Allow for this session": back on, that connection is asked again (#29)', r.result?.granted === false && r.result?.reason === 'denied', r);
    await sleep(500);
  } finally {
    for (const s of sessions.splice(0)) await s.close();
    // J22: while it runs, nothing listens on TCP except llama-server (not started here: no models) and this QA's own debugging port.
    try {
      const pids = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${DATA.replace(/\\/g, '\\\\')}*' -or $_.ParentProcessId -eq ${app2.pid} }).ProcessId -join ','`], { encoding: 'utf8' }).trim().split(',').filter(Boolean);
      const all = new Set([String(app2.pid), ...pids]);
      const listening = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' }).split('\n').filter((l) => /LISTENING/.test(l) && all.has(l.trim().split(/\s+/).pop()) && !l.includes(`:${CDP_PORT} `));
      check('J22', 'Dictate listens on no TCP port', listening.length === 0, listening);
    } catch (err) {
      check('J22', 'netstat ran', false, err.message);
    }
    execFileSync('taskkill', ['/PID', String(app2.pid), '/T', '/F'], { stdio: 'ignore' });
    await sleep(1500);
  }
  const accessLog = JSON.parse(fs.readFileSync(path.join(DATA, 'agents', 'access-log.json'), 'utf8'));
  check('J15', 'every read is in the access log, refusals included', accessLog.map((x) => x.outcome).join() === 'off,allowed-once,allowed-session,session-grant,denied,off,denied' || accessLog.map((x) => x.outcome).join() === 'allowed-once,allowed-session,session-grant,denied,off,denied', accessLog.map((x) => x.outcome));
  check('J15', "the log file has each read and never the dictated text", (log().match(/read_history from/g) ?? []).length >= 4 && !/Ship the migration/.test(log()), null);

  fs.writeFileSync(path.join(OUT, 'report.json'), `${JSON.stringify({ at: new Date().toISOString(), checks }, null, 2)}\n`);
  const failed = checks.filter((c) => !c.ok);
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
