// A card's choice button clicked with the real Windows pointer (issue #9): the pill window is click-through until the
// pointer is over a card, so only real OS input proves a click reaches the button. It MOVES THE MOUSE, so it runs
// only on CI (or with DICTATE_QA_REAL_POINTER=1 on a machine nobody is using). Windows only.
// Writes tmp/cards-pointer/report.json and a screenshot of the screen at each step.
//   pnpm build && node qa/cards-pointer.js
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { agentSession, ELECTRON } = require('./agent-bridge');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tmp', 'cards-pointer');
const DATA = path.join(OUT, 'data');
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

/** Real pointer input through SendInput, and a screenshot of the whole screen. */
const INPUT = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class P {
  [StructLayout(LayoutKind.Sequential)] public struct MI { public int dx; public int dy; public uint data; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct IN { public uint type; public MI mi; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, IN[] i, int size);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int x; public int y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out PT p);
  public static string At() { PT p; GetCursorPos(out p); return p.x + "," + p.y; }
  public static void Send(int x, int y, uint flags) {
    var i = new IN[1]; i[0].type = 0;
    i[0].mi.dx = (int)Math.Round((x - GetSystemMetrics(76)) * 65535.0 / (GetSystemMetrics(78) - 1)); i[0].mi.dy = (int)Math.Round((y - GetSystemMetrics(77)) * 65535.0 / (GetSystemMetrics(79) - 1));
    i[0].mi.flags = flags | 0x8000 | 0x4000; uint sent = SendInput(1, i, Marshal.SizeOf(typeof(IN)));
    Console.WriteLine("pointer " + flags + " to " + x + "," + y + ": sent " + sent + " (size " + Marshal.SizeOf(typeof(IN)) + "), now at " + At());
  }
}
"@
[P]::SetProcessDPIAware() | Out-Null
`;
function pointer(action, x = 0, y = 0, file = '') {
  const steps = {
    move: `[P]::Send(${x}, ${y}, 0x1)`,
    click: `[P]::Send(${x}, ${y}, 0x1); Start-Sleep -Milliseconds 40; [P]::Send(${x}, ${y}, 0x2); Start-Sleep -Milliseconds 60; [P]::Send(${x}, ${y}, 0x4)`,
    shot: `$b = [System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); $bmp.Save('${file}')`,
  };
  execFileSync('powershell', ['-NoProfile', '-Command', `${INPUT}\n${steps[action]}`], { stdio: 'inherit' });
}

async function untilLog(re, ms = 30_000, from = 0) {
  for (const t = Date.now(); Date.now() - t < ms; await sleep(100)) {
    const m = log().slice(from).match(re);
    if (m) return m;
  }
  return null;
}

async function where(line, re) {
  const mark = log().length;
  cmd(line);
  const m = await untilLog(re, 5000, mark);
  return m ? JSON.parse(m[1]) : null;
}

async function main() {
  if (process.platform !== 'win32') return console.log('skipped: Windows only');
  if (!process.env.CI && process.env.DICTATE_QA_REAL_POINTER !== '1') return console.log('skipped: moves the real pointer; set DICTATE_QA_REAL_POINTER=1 on a machine nobody is using');
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ onboarded: true, hotkeys: [{ keys: [0x81] }], toggle: null, picker: null, sounds: false }));
  fs.writeFileSync(CONTROL, '');
  const env = { ...process.env, DICTATE_DATA_DIR: DATA, DICTATE_QA_SINK: 'none', DICTATE_QA_CONTROL: CONTROL, PANE_SESSION_ID: '', PANE_PANEL_ID: '', PANE_DIR: path.join(OUT, 'no-pane') };
  const app = spawn(ELECTRON, ['.'], { cwd: ROOT, env, stdio: 'ignore' });
  let agent;
  try {
    check('the app opened the agent channel and the pill', !!(await untilLog(/agents: channel open/)) && !!(await untilLog(/pill ready/)), log().slice(-2000));
    agent = agentSession(DATA, { cwd: path.join(ROOT, 'docs') });
    const ask = agent.call('ask', { question: 'Which environment should the migration run against before the release tonight?', choices: ['Staging', 'Prod', 'Both', 'Neither'], timeout_s: 60 });
    await sleep(1000);
    const card = await where('card-where', /QA card at (.+)\n/);
    check('the card is on screen', !!card, card);
    if (!card) return;
    // Hover: a few moves onto the card, as a hand would.
    for (let i = 3; i >= 0; i--) {
      pointer('move', card.x + card.width / 2, card.y + card.height / 2 + i * 20);
      await sleep(60);
    }
    await sleep(600);
    pointer('shot', 0, 0, path.join(OUT, '01-hover.png'));
    const prod = await where('card-locate Prod', /QA card-locate "Prod" (.+)\n/);
    check('hovering expands the card and shows its choices', !!prod, prod);
    if (!prod) return;
    pointer('click', prod.x, prod.y);
    const answer = await Promise.race([ask, sleep(4000).then(() => null)]);
    pointer('shot', 0, 0, path.join(OUT, '02-after-click.png'));
    check('a real click on "Prod" returns that choice to the agent', answer?.result?.answered === true && answer.result.choice === 'Prod', answer ?? log().split('\n').filter((l) => /QA card/.test(l)));
  } finally {
    await agent?.close();
    execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    await sleep(1000);
    fs.writeFileSync(path.join(OUT, 'report.json'), `${JSON.stringify({ at: new Date().toISOString(), checks }, null, 2)}\n`);
    const failed = checks.filter((c) => !c.ok);
    console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
    process.exitCode = failed.length ? 1 : 0;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
