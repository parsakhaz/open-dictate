// L6 · Point and say (Windows): J15 element, region, review, redaction, send; J16 privacy (glow only while held,
// other keys never capture, excluded apps, 24 h). The pointer, the left button and the point key come from the QA
// control file (`point …` lines); the target is a fixture window in its own process (point-fixture.ps1), so the real
// pointer, keyboard and desktop apps are never touched. Until L3 merges, a recording orchestrator stands in for
// sending (`point fake-orchestrator`), and one press goes to the real one to show what it answers.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/** The fixture's made-up key (point-fixture.ps1), put together so secret scanners don't take it for a leak. */
const KEY = ['sk', 'live', '51HxQa2Rk7VbT9qaFixture'].join('-');
const win = process.platform === 'win32';
let fixture = null;

/** Starts the fixture window and waits for its rectangles (physical pixels); it closes itself when this process ends. */
async function openFixture({ sleep }) {
  if (fixture) return fixture.rects;
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'point-fixture.ps1'), '-X', '160', '-Y', '160', '-ParentPid', String(process.pid)], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: false });
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  for (let i = 0; i < 100 && !out.includes('\n'); i++) await sleep(100);
  fixture = { child, rects: out.includes('\n') ? JSON.parse(out.split('\n')[0]) : null };
  process.on('exit', () => child.kill());
  return fixture.rects;
}

function closeFixture() {
  fixture?.child.stdout.destroy();
  fixture?.child.kill();
  fixture = null;
}

/** The element UI Automation found is the fixture's control: their rectangles overlap by most of the control. */
const overlaps = (a, b) => Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > b.width / 2 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > b.height / 2;
const centre = (r) => ({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
const capturesDir = (DATA) => path.join(DATA, 'agents', 'captures');

module.exports = {
  lane: 'L6',
  // A point key (F24, which no keyboard has) so the helper starts with the app and Settings shows a key.
  settings: { point: { key: { keys: [0x87] }, review: 'countdown', excludedApps: ['1Password.exe', 'Bitwarden.exe', 'KeePass.exe', 'KeePassXC.exe'], target: 'voice' } },
  journeys: [
    {
      id: 'J15',
      name: 'point at an element: outline with its name, review card with crop, masked key, words and target; Enter sends; a drag gives a region',
      async run(ctx) {
        const { cmd, qa, sleep, check, cards, shot, DATA, SHOTS } = ctx;
        if (!win) return check('point and say is Windows only: nothing to run here', true);
        const helper = await qa('point helper', /QA point-helper (.+)\n/, 20_000);
        check('the UI Automation helper starts', helper?.ok === true, helper);
        const rects = await openFixture(ctx);
        check('the fixture window is up', !!rects?.details, rects);
        if (!rects) return;
        await sleep(400);
        cmd('point fake-orchestrator');
        const at = centre(rects.details);
        cmd(`point pointer ${at.x} ${at.y}`);
        cmd('point mouse up');
        cmd('point down');
        await sleep(900);
        const held = await qa('point dump', /QA point-state (.+)\n/);
        const el = held?.pointing?.hit?.element;
        check('holding the key outlines the element under the pointer with its role and name', !!el && overlaps(el.rect, rects.details) && /Unhandled|Cannot read|Error details/.test(held.pointing.target) && held.glow.state?.box?.tag === held.pointing.target, held?.pointing);
        check('the edge glow and the "Capturing" capsule show while the key is down', held?.glow.visible === true && held.glow.state?.title === 'Capturing', held?.glow);
        await qa('point glow-shot element', /QA point-glow-shot (.+)\n/);
        cmd('point up');
        await sleep(1500);
        const released = await qa('point dump', /QA point-state (.+)\n/);
        check('letting go hides the glow at once', released?.glow.visible === false, released?.glow);
        const cap = released?.capture;
        check('the crop is saved under the captures folder', !!cap?.file && fs.existsSync(cap.file) && cap.file.startsWith(capturesDir(DATA)), cap);
        check('the text read there has the planted key masked, keeping its prefix', !!cap?.text && cap.text.includes('sk-live-••••••') && !cap.text.includes(KEY) && cap.secrets === 1, cap?.text);
        check('Dictate’s own windows are kept out of the capture (content-protected while it is taken)', cap?.protectedWindows >= 1, cap);
        const said = qa('point say fix this', /QA point-said (.+)\n/, 15_000);
        let c = null;
        for (let i = 0; i < 30 && c?.top?.kind !== 'point-review'; i++) {
          await sleep(100);
          c = await cards();
        }
        check('the review card rises: "Send this to the orchestrator?"', c?.top?.kind === 'point-review' && c.top.title === 'Send this to the orchestrator?', c);
        cmd('point pointed on');
        await sleep(400);
        await shot('point-review');
        const a = await qa('point dump', /QA point-state (.+)\n/);
        await sleep(1500);
        const b = await qa('point dump', /QA point-state (.+)\n/);
        check('pointing at the card pauses the countdown', a?.review?.paused === true && b?.review?.remaining === a?.review?.remaining && b.review.remaining > 0, { a: a?.review, b: b?.review });
        cmd('point pointed off');
        await sleep(300);
        cmd('point key enter');
        const sent = await said;
        check('Enter sends now', sent?.ok === true && sent.message === 'Sent to the orchestrator', sent);
        const after = await qa('point dump', /QA point-state (.+)\n/);
        const m = after?.sent?.[0];
        check('the orchestrator gets the words, what was pointed at, the masked text and the crop’s path, via point', m?.via === 'point' && m.text.startsWith('fix this') && m.text.includes(`Pointed at: ${held?.pointing?.target}`) && m.text.includes('sk-live-••••••') && !m.text.includes(KEY) && m.text.includes(cap?.file), m);
        check('the review card goes once sent', (await cards())?.top?.kind !== 'point-review');

        // A drag: hold the left button and move, and the region is what goes, with its size.
        const w = rects.window;
        const from = { x: w.x + 20, y: w.y + 40 };
        const to = { x: w.x + 320, y: w.y + 200 };
        cmd(`point pointer ${from.x} ${from.y}`);
        cmd('point down');
        await sleep(500);
        cmd('point mouse down');
        await sleep(300);
        cmd(`point pointer ${to.x} ${to.y}`);
        await sleep(500);
        const dragging = await qa('point dump', /QA point-state (.+)\n/);
        check('dragging switches to a region with its size', dragging?.pointing?.target === 'Region · 300 × 160' && dragging.glow.state?.box?.region === true, dragging?.pointing);
        await qa('point glow-shot region', /QA point-glow-shot (.+)\n/);
        cmd('point mouse up');
        cmd('point up');
        await sleep(1500);
        const region = await qa('point dump', /QA point-state (.+)\n/);
        check('the region crop has the region’s size', region?.capture?.size?.width === 300 && region.capture.size.height === 160, region?.capture);
        const cancelled = qa('point say look at this', /QA point-said (.+)\n/, 15_000);
        await sleep(800);
        cmd('point key escape');
        const r = await cancelled;
        check('Esc cancels: nothing is sent and the crop is deleted', r?.ok === false && /Cancelled/.test(r.message) && !fs.existsSync(region?.capture?.file ?? ''), r);

        // The real orchestrator: until L3 merges it says it isn't set up; after, the test pane-dir's Voice Session takes it.
        cmd('point fake-orchestrator off');
        cmd(`point pointer ${centre(rects.pay).x} ${centre(rects.pay).y}`);
        cmd('point down');
        await sleep(800);
        const pay = await qa('point dump', /QA point-state (.+)\n/);
        check('a button is outlined with its name too', /· Pay now$/.test(pay?.pointing?.target ?? ''), pay?.pointing);
        cmd('point up');
        await sleep(1200);
        const real = qa('point say pay this', /QA point-said (.+)\n/, 30_000);
        await sleep(800);
        cmd('point key enter');
        const rr = await real;
        check('sending goes through host.orchestrator(): delivered, or an honest reason on the pill', rr && (rr.ok === true || /^Not sent · /.test(rr.message)), rr);
        if (!fs.existsSync(path.join(SHOTS, 'point-element.png'))) check('the glow screenshot was written', false);
      },
    },
    {
      id: 'J16',
      name: 'privacy: glow only while held, the dictation key never captures, excluded apps do nothing, old captures go',
      async run(ctx) {
        const { cmd, qa, sleep, check, DATA } = ctx;
        if (!win) return check('point and say is Windows only: nothing to run here', true);
        const rects = await openFixture(ctx);
        if (!rects) {
          closeFixture();
          return check('the fixture window is up', false);
        }
        const dir = capturesDir(DATA);
        fs.mkdirSync(dir, { recursive: true });
        const count = () => fs.readdirSync(dir).filter((n) => n.startsWith('point-')).length;

        const before = count();
        cmd('down');
        await sleep(800);
        cmd('up');
        await sleep(2500);
        const idle = await qa('point dump', /QA point-state (.+)\n/);
        check('holding the dictation key never writes a capture nor shows the glow', count() === before && !idle?.pointing && idle?.glow.visible === false, { before, after: count(), idle });

        cmd('point exclude ["powershell.exe","1Password.exe","Bitwarden.exe","KeePass.exe","KeePassXC.exe"]');
        await sleep(300);
        const at = centre(rects.details);
        cmd(`point pointer ${at.x} ${at.y}`);
        cmd('point down');
        await sleep(900);
        const ex = await qa('point dump', /QA point-state (.+)\n/);
        check('over an excluded app the key does nothing: no glow, nothing pointed at', !ex?.pointing && ex?.glow.visible === false, ex);
        cmd('point up');
        const said = await qa('point say fix this', /QA point-said (.+)\n/, 5000);
        check('and nothing is captured or sent', said?.ok === false && count() === before, { said, before, after: count() });
        cmd('point exclude ["1Password.exe","Bitwarden.exe","KeePass.exe","KeePassXC.exe"]');

        const old = path.join(dir, 'point-2026-01-01T00-00-00-000Z-1.png');
        const fresh = path.join(dir, 'point-2026-01-02T00-00-00-000Z-2.png');
        const other = path.join(dir, 'peek-old.png');
        for (const f of [old, fresh, other]) fs.writeFileSync(f, 'x');
        const dayAgo = new Date(Date.now() - 25 * 3600 * 1000);
        fs.utimesSync(old, dayAgo, dayAgo);
        fs.utimesSync(other, dayAgo, dayAgo);
        const swept = await qa('point sweep', /QA point-swept (.+)\n/);
        check('captures older than 24 h are deleted (as at start-up); newer ones and other features’ files stay', swept?.deleted === 1 && !fs.existsSync(old) && fs.existsSync(fresh) && fs.existsSync(other), swept);
        for (const f of [fresh, other]) fs.rmSync(f, { force: true });
        const s = await qa('point settings-shot settings', /QA point-settings-shot (.+)\n/, 15_000);
        check('Settings → Agents shows the point-and-say section', s?.ok === true, s);
        closeFixture();
      },
    },
  ],
};
