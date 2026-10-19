// Desktop QA for dictate, on an unlocked Windows desktop. It drives the real app with injected keys (it types
// into Notepad, an Edge window and a terminal it opens) and plays a WAV through the capture path instead of the mic.
// Run from dictate/ after `pnpm build`:   node qa/qa.js            (all scenarios)
//                                         node qa/qa.js ptt picker  (some: ptt toggle esc escclean tap single second picker altgr browser body terminal crash mic)
//                                         node qa/qa.js --key=ralt  (Right Alt as the dictation key)
//                                         node qa/qa.js --key=f13   (F13, as a mouse button mapped in Options+ or G HUB
//                                                                    sends it, plus Right Alt as a second key)
// Results: tmp/qa/out/summary.json and screenshots in tmp/qa/out/. App data goes to tmp/qa-data (not your real settings).
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const q = require('./run');

// --key=ralt runs everything with Right Alt as the dictation key (Right Alt+V for the picker), as on keyboards
// without Right Ctrl. --key=f13 uses F13, injected like vendor mouse software does (no dictate marker), with
// Right Alt as a second dictation key and Right Ctrl+V for the picker. The keys used are the QA profile's settings.
const keyArg = (process.argv.find((a) => a.startsWith('--key=')) ?? '--key=rctrl').slice(6);
const F13 = 0x7c;
const RALT = 0xa5;
const HK = keyArg === 'ralt' ? RALT : keyArg === 'f13' ? F13 : q.RCTRL;
const DEDICATED = HK === F13;
/** The picker's modifier: the dictation key, except with F13 (F13+V is no shortcut anyone would press). */
const PK = DEDICATED ? q.RCTRL : HK;
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const want = (n) => !only.length || only.includes(n);
const WAV = path.join(q.FIX, 's1.wav');
// A new file each run: rewriting a file Notepad still has open makes it ask about the conflict.
const NOTE = path.join(q.ROOT, 'tmp', 'qa', `target-notepad-${Date.now()}.txt`);
fs.mkdirSync(path.dirname(NOTE), { recursive: true });
const HOLD = 5400;
const latencies = [];
let notepadWasRunning = true;

function msFrom(log) {
  const m = [...log.matchAll(/dictation (\d+) ms release-to-output · (.*)/g)];
  return m.length ? { ms: Number(m[m.length - 1][1]), detail: m[m.length - 1][2] } : null;
}

async function closeNotepadTab(wasRunning) {
  if (q.hwndOf('target-notepad') && (await q.focus('target-notepad'))) {
    q.key(0x11, false);
    await q.tap(0x53); // Ctrl+S: our scratch file, so closing it never prompts
    q.key(0x11, true);
    await q.sleep(400);
    await q.closeTab('target-notepad');
  }
  if (q.hwndOf('target-notepad')) console.log('Notepad tab target-notepad left open');
  else if (!wasRunning) q.ps('Get-Process notepad -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }');
  fs.rmSync(NOTE, { force: true });
}

async function dictateHold(holdMs = HOLD) {
  const mark = q.logMark();
  q.key(HK, false);
  await q.sleep(holdMs);
  q.key(HK, true);
  const ok = await q.waitLog(/release-to-output|nothing heard/, 15000, mark);
  await q.sleep(500);
  return { ok, log: q.logSince(mark) };
}

(async () => {
  fs.mkdirSync(q.DATA, { recursive: true });
  const settingsFile = path.join(q.DATA, 'settings.json');
  const s = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
  const devFile = path.join(q.DATA, 'qa-devices.json');
  const AMD = { deviceId: 'amd', groupId: 'g-amd', label: 'Microphone Array (AMD Audio Device)' };
  const BOYA = { deviceId: 'boya', groupId: 'g-boya', label: 'Microphone (BOYA mini 2) (2e8a:00f2)' };
  // The preferred mic (BOYA) starts unplugged, so plugging it in switches to it.
  const micOrder = want('mic') ? [{ label: BOYA.label }, { label: AMD.label }] : [];
  delete s.hotkey;
  const hotkeys = DEDICATED ? [{ keys: [F13] }, { keys: [RALT] }] : [{ keys: [HK] }];
  Object.assign(s, { onboarded: true, micOrder, output: 'paste', cleanup: 'gemma-emberon', toggle: null, pressEnter: false, hotkeys, picker: { keys: [PK, 0x56] } });
  fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2));
  fs.rmSync(path.join(q.DATA, 'history.json'), { force: true });
  fs.writeFileSync(NOTE, '');
  q.saveClipboard();
  fs.writeFileSync(devFile, JSON.stringify({ list: [AMD], defaultLabel: AMD.label }));

  const mark0 = q.logMark();
  q.startApp(WAV, want('mic') ? { DICTATE_QA_DEVICES: devFile } : {});
  const loaded = await q.waitLog(/gemma ready/, 30000, mark0);
  await q.waitLog(/speech model loaded/, 10000, mark0);
  q.check('app starts and loads models', loaded);

  // Windows 11 Notepad reopens the person's previous tabs in the window it starts. The QA works in its own tab and
  // closes only that tab (saved first, so no prompt), and closes the window only if Notepad was not already open.
  notepadWasRunning = q.ps('(Get-Process notepad -ErrorAction SilentlyContinue | Measure-Object).Count') !== '0';
  spawn('notepad.exe', [NOTE], { detached: true, stdio: 'ignore' });
  await q.sleep(1500);
  const title = 'target-notepad';
  let base = '';

  if (want('ptt')) {
    for (let i = 1; i <= 5; i++) {
      q.check(`ptt ${i}: notepad focused`, await q.focus(title));
      if (i === 1) q.check('caret probe: Notepad shows a caret', q.caretInfo().hwndCaret !== 0, JSON.stringify(q.caretInfo()));
      q.setClipboard(`SENTINEL-${i}`);
      const before = q.readText(title);
      const shotAt = i === 1 ? setTimeout(() => q.shot('ptt-listening'), 2500) : null;
      const r = await dictateHold();
      if (shotAt) clearTimeout(shotAt);
      const after = q.readText(title);
      const added = after.slice(before.length).trim();
      const m = msFrom(r.log);
      if (m) latencies.push(m.ms);
      q.check(`ptt ${i}: text pasted into Notepad`, added.length > 10, JSON.stringify(added).slice(0, 120));
      q.check(`ptt ${i}: release-to-paste`, !!m && m.ms < 2500, m ? `${m.ms} ms · ${m.detail}` : 'no timing');
      await q.sleep(300);
      q.check(`ptt ${i}: clipboard restored`, q.getClipboard() === `SENTINEL-${i}`, q.getClipboard().slice(0, 60));
      q.check(`ptt ${i}: focus still in the text (no menu bar)`, q.focusInText(), q.focusedControl());
      // a space between dictations, like a person would type
      await q.tap(0x20);
    }
    base = q.readText(title);
  }

  if (want('toggle')) {
    await q.focus(title);
    const before = q.readText(title);
    const mark = q.logMark();
    await q.tap(HK, 70);
    await q.sleep(120);
    await q.tap(HK, 70);
    await q.sleep(2500);
    q.shot('toggle-listening');
    await q.sleep(HOLD - 2500);
    await q.tap(HK, 70);
    await q.waitLog(/release-to-output|nothing heard/, 15000, mark);
    await q.sleep(500);
    const added = q.readText(title).slice(before.length).trim();
    q.check('double-tap toggle: dictation pasted after the stopping tap', added.length > 10, JSON.stringify(added).slice(0, 120));
    q.check('double-tap toggle: mode logged', /dictation \d+ ms/.test(q.logSince(mark)));
    q.check('double-tap toggle: focus still in the text (no menu bar)', q.focusInText(), q.focusedControl());
  }

  if (want('esc')) {
    await q.focus(title);
    const before = q.readText(title);
    const mark = q.logMark();
    q.key(HK, false);
    await q.sleep(1500);
    await q.tap(0x1b);
    await q.sleep(200);
    q.key(HK, true);
    await q.sleep(2500);
    q.check('Esc cancels: nothing typed', q.readText(title) === before);
    q.check('Esc cancels: no dictation delivered', !/release-to-output/.test(q.logSince(mark)));
  }

  if (want('escclean')) {
    // Esc after release, while the words are still being cleaned (B4): nothing is pasted.
    await q.focus(title);
    const before = q.readText(title);
    const mark = q.logMark();
    q.key(HK, false);
    await q.sleep(HOLD);
    q.key(HK, true);
    await q.waitLog(/stt final/, 8000, mark);
    await q.tap(0x1b);
    await q.waitLog(/cancelled with Esc|release-to-output/, 8000, mark);
    await q.sleep(800);
    q.check('Esc while cleaning: nothing typed', q.readText(title) === before);
    q.check('Esc while cleaning: cancelled, not delivered', /cancelled with Esc/.test(q.logSince(mark)) && !/release-to-output/.test(q.logSince(mark)), q.logSince(mark).split('\n').filter((l) => /cancel|release-to/.test(l)).join(' | ').slice(0, 200));
    q.check('Esc while cleaning: the Esc never reached Notepad (focus still in the text)', q.focusInText(), q.focusedControl());
  }

  if (want('single') && DEDICATED) {
    // A dedicated key: one tap starts hands-free, the next tap finishes (A1). Notepad never sees F13.
    await q.focus(title);
    const before = q.readText(title);
    const mark = q.logMark();
    await q.tap(HK, 70);
    await q.sleep(2500);
    q.shot('f13-single-tap-listening');
    await q.sleep(HOLD - 2500);
    await q.tap(HK, 70);
    await q.waitLog(/release-to-output|nothing heard/, 15000, mark);
    await q.sleep(500);
    const added = q.readText(title).slice(before.length).trim();
    q.check('F13 single tap: hands-free, pasted after the next tap', added.length > 10, JSON.stringify(added).slice(0, 120));
    q.check('F13 single tap: focus still in the text', q.focusInText(), q.focusedControl());
  }

  if (want('second') && DEDICATED) {
    // Several dictation keys (B2): Right Alt still dictates next to F13.
    await q.focus(title);
    const before = q.readText(title);
    const mark = q.logMark();
    q.key(RALT, false);
    await q.sleep(HOLD);
    q.key(RALT, true);
    await q.waitLog(/release-to-output|nothing heard/, 15000, mark);
    await q.sleep(500);
    const added = q.readText(title).slice(before.length).trim();
    q.check('Right Alt next to F13: a hold dictates', added.length > 10, JSON.stringify(added).slice(0, 120));
    q.check('Right Alt next to F13: no menu bar', q.focusInText(), q.focusedControl());
  }

  if (want('tap') && !DEDICATED) {
    await q.focus(title);
    const before = q.readText(title);
    const mark = q.logMark();
    await q.tap(HK, 80);
    await q.sleep(150);
    q.shot('lone-tap');
    await q.sleep(1500);
    q.check('lone tap: nothing typed', q.readText(title) === before);
    q.check('lone tap: no dictation', !/release-to-output|stt final/.test(q.logSince(mark)));
    q.check('lone tap: focus still in the text (no menu bar)', q.focusInText(), q.focusedControl());
    // Right Ctrl + End: a real shortcut, must reach Notepad and not dictate
    await q.focus(title);
    q.key(HK, false);
    await q.sleep(100);
    await q.tap(0x24); // Home: Ctrl+Home goes to the start of the document
    await q.sleep(60);
    q.key(HK, true);
    await q.sleep(1500);
    q.check('Right Ctrl + key: no dictation', !/release-to-output|stt final/.test(q.logSince(mark)));
  }

  if (want('picker')) {
    await q.focus(title);
    // put the caret at the end again
    q.key(PK, false);
    await q.tap(0x23);
    q.key(PK, true);
    await q.sleep(500);
    const before = q.readText(title);
    const fgBefore = q.hwndOf(title);
    q.key(PK, false);
    await q.sleep(80);
    await q.tap(0x56);
    await q.sleep(60);
    q.key(PK, true);
    await q.sleep(600);
    q.shot('picker-open');
    q.check('Right Ctrl+V: V did not reach Notepad', q.readText(title) === before);
    await q.tap(0x28); // Down: second entry
    await q.sleep(150);
    await q.tap(0x0d); // Enter
    await q.sleep(1200);
    const added = q.readText(title).slice(before.length).trim();
    q.check('picker: Enter pastes the chosen entry into Notepad', added.length > 10, JSON.stringify(added).slice(0, 120));
    q.check('picker: Notepad kept focus', q.hwndOf(title) === fgBefore);
    q.check('picker: focus still in the text (no menu bar)', q.focusInText(), q.focusedControl());
    // filter + Esc
    q.key(PK, false);
    await q.tap(0x56);
    q.key(PK, true);
    await q.sleep(500);
    for (const c of 'zzz') await q.tap(c.toUpperCase().charCodeAt(0));
    await q.sleep(300);
    q.shot('picker-filter-empty');
    await q.tap(0x1b);
    await q.sleep(400);
    const after2 = q.readText(title);
    q.check('picker: typed filter and Esc never reach Notepad', after2 === before + (after2.slice(before.length)) && !/zzz/.test(after2));
  }

  if (want('altgr') && !DEDICATED) {
    // On AltGr layouts Windows sends a fake Left Ctrl (scan code 0x21D) with Right Alt.
    await q.focus(title);
    const before = q.readText(title);
    const mark = q.logMark();
    q.keyScan(0xa2, 0x21d, false);
    q.key(HK, false);
    await q.sleep(HOLD);
    q.keyScan(0xa2, 0x21d, true);
    q.key(HK, true);
    await q.waitLog(/release-to-output|nothing heard/, 15000, mark);
    await q.sleep(500);
    const added = q.readText(title).slice(before.length).trim();
    q.check('AltGr: a hold with the fake Left Ctrl still dictates', added.length > 10, JSON.stringify(added).slice(0, 120));
    q.check('AltGr: focus still in the text', q.focusInText(), q.focusedControl());
  }

  if (want('browser')) {
    const html = "data:text/html,<title>dictate-qa-browser</title><textarea autofocus style='width:90vw;height:80vh;font-size:20px'></textarea>";
    spawn('cmd', ['/c', 'start', '', 'msedge', '--new-window', html], { stdio: 'ignore' });
    await q.sleep(3500);
    q.check('browser: textarea window focused', await q.focus('dictate-qa-browser'));
    console.log(`info caret probe, Edge textarea: ${JSON.stringify(q.caretInfo())}`);
    q.setClipboard('SENTINEL-browser');
    const r = await dictateHold();
    const text = q.readText('dictate-qa-browser');
    q.check('browser: text pasted into a textarea', text.trim().length > 10, JSON.stringify(text).slice(0, 120));
    q.check('browser: clipboard restored', q.getClipboard() === 'SENTINEL-browser');
    q.check('browser: delivery confirmed', /· pasted$/m.test(r.log), (msFrom(r.log) ?? {}).detail);
    q.check('browser: focus still in the textarea (no menu)', q.focusInText(), q.focusedControl());
    // a second dictation lands too: the first did not move focus to the browser's menu
    await dictateHold(2500);
    q.check('browser: a second dictation follows the first', (q.readText('dictate-qa-browser').match(/Kubernetes/g) ?? []).length >= 2);
    q.shot('browser');
    await q.focus('dictate-qa-browser');
    await q.closeTab('dictate-qa-browser');
  }

  if (want('body')) {
    const html = "data:text/html,<title>dictate-qa-body</title><p style='font-size:20px'>No text field here.</p>";
    spawn('cmd', ['/c', 'start', '', 'msedge', '--new-window', html], { stdio: 'ignore' });
    await q.sleep(3500);
    q.check('body: page window focused', await q.focus('dictate-qa-body'));
    console.log(`info caret probe, Edge page body: ${JSON.stringify(q.caretInfo())}`);
    q.setClipboard('SENTINEL-body');
    const r = await dictateHold();
    q.shot('body');
    // Chromium shows no Win32 caret even in a textarea, so a page body cannot be told apart: dictate pastes,
    // restores the clipboard, and the words are in the history (Right Ctrl+V).
    q.check('body: clipboard restored', q.getClipboard() === 'SENTINEL-body', q.getClipboard().slice(0, 60));
    q.check('body: the dictation is in the history', fs.readFileSync(path.join(q.DATA, 'history.json'), 'utf8').includes('Kubernetes'), (msFrom(r.log) ?? {}).detail);
    await q.focus('dictate-qa-body');
    await q.closeTab('dictate-qa-body');
  }

  if (want('terminal')) {
    const term = spawn('cmd.exe', ['/c', 'start', '"dictate-qa-term"', 'cmd.exe', '/k', 'title dictate-qa-term'], { stdio: 'ignore' });
    await q.sleep(2000);
    q.check('terminal: focused', await q.focus('dictate-qa-term'));
    console.log(`info caret probe, terminal: ${JSON.stringify(q.caretInfo())}`);
    q.setClipboard('SENTINEL-term');
    await dictateHold();
    await q.sleep(500);
    q.shot('terminal');
    const t = q.readText('dictate-qa-term');
    q.check('terminal: text pasted at the prompt', /\w{3,}.*\w{3,}/.test(t.split('\n').filter((l) => l.includes('>')).pop() ?? ''), JSON.stringify(t.split('\n').filter((l) => l.includes('>')).pop() ?? '').slice(0, 140));
    q.check('terminal: clipboard restored', q.getClipboard() === 'SENTINEL-term');
    // The tab may live in the person's own Windows Terminal: never kill a process, type exit into our tab.
    if ((await q.focus('dictate-qa-term')) && q.fgTitle().includes('dictate-qa-term')) {
      await q.tap(0x1b);
      for (const c of 'EXIT') await q.tap(c.charCodeAt(0), 20);
      await q.tap(0x0d);
      await q.sleep(800);
    }
    if (q.hwndOf('dictate-qa-term')) console.log('terminal tab dictate-qa-term left open');
    void term;
  }

  if (want('crash')) {
    await q.focus(title);
    const before = q.readText(title);
    const mark = q.logMark();
    // Gemma dies near the end of the hold, so it is still restarting when the cleanup runs.
    const kill = setTimeout(() => {
      execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='llama-server.exe'\" | Where-Object { $_.CommandLine -like '*gemma-4*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"]);
    }, HOLD - 600);
    const r = await dictateHold();
    clearTimeout(kill);
    const added = q.readText(title).slice(before.length).trim();
    q.check('Gemma crash: dictation still pasted', added.length > 10, JSON.stringify(added).slice(0, 120));
    q.check('Gemma crash: fallback logged', /gemma (skipped|error|timeout)/.test(r.log), (msFrom(r.log) ?? {}).detail);
    q.check('Gemma crash: server restarted', await q.waitLog(/gemma ready/, 20000, mark));
  }

  if (want('mic')) {
    // plug the preferred BOYA in
    const mark = q.logMark();
    fs.writeFileSync(devFile, JSON.stringify({ list: [AMD, BOYA], defaultLabel: AMD.label }));
    q.check('mic: reconnect logged as a switch', await q.waitLog(/switched to Microphone \(BOYA/, 3000, mark));
    await q.sleep(300);
    q.shot('mic-switched');
    fs.writeFileSync(devFile, JSON.stringify({ list: [AMD], defaultLabel: AMD.label }));
    await q.waitLog(/disconnected — using/, 3000, mark);
    await q.sleep(300);
    q.shot('mic-disconnected');
    q.check('mic: disconnect toast logged', /disconnected — using/.test(q.logSince(mark)), q.logSince(mark).split('\n').filter((l) => /mic|switch|disconnect/i.test(l)).join(' | ').slice(0, 300));
    // mid-recording unplug keeps the words
    fs.writeFileSync(devFile, JSON.stringify({ list: [AMD, BOYA], defaultLabel: AMD.label }));
    await q.sleep(2500);
    await q.focus(title);
    const before = q.readText(title);
    const m2 = q.logMark();
    q.key(HK, false);
    await q.sleep(2000);
    fs.writeFileSync(devFile, JSON.stringify({ list: [AMD], defaultLabel: AMD.label }));
    await q.sleep(HOLD - 2000);
    q.key(HK, true);
    await q.waitLog(/release-to-output|nothing heard/, 15000, m2);
    await q.sleep(500);
    const added = q.readText(title).slice(before.length).trim();
    q.check('mic: unplug mid-recording still delivers the words', added.length > 10, JSON.stringify(added).slice(0, 120));
  }

  q.stopApp();
  q.restoreClipboard();
  await closeNotepadTab(notepadWasRunning);
  const sorted = [...latencies].sort((a, b) => a - b);
  const summary = { results: q.results, latencies, median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null };
  fs.writeFileSync(path.join(q.OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\n${q.results.filter((r) => r.ok).length}/${q.results.length} passed; release-to-paste ms: ${latencies.join(', ')} (median ${summary.median})`);
})().catch(async (e) => {
  console.error(e);
  q.stopApp();
  q.restoreClipboard();
  await closeNotepadTab(notepadWasRunning);
  process.exit(1);
});
