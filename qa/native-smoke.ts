// A real isolated desktop target: native clipboard → native paste → renderer value, then a physical
// modifier pair through the OS hook. Read-only permission checks never fake or prompt for macOS TCC.
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, ClipboardItem, clipboard } from 'electron';
import koffi from 'koffi';
import { KeyHook } from '../src/main/keyhook';
import { realPasteSink } from '../src/main/output';
import type { FromHook } from '../src/native/keyhook-worker';
import { createMacDesktop } from '../src/native/macos';
import { foregroundWindow, isWindow, platformCapabilities, setForeground, typeText } from '../src/native/platform';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

async function physicalRightCtrl(): Promise<void> {
  if (process.platform === 'win32') {
    const user = koffi.load('user32.dll');
    const ki = koffi.struct('QA_KEYBDINPUT', { vk: 'uint16', scan: 'uint16', flags: 'uint32', time: 'uint32', extra: 'uintptr' });
    const mi = koffi.struct('QA_MOUSEINPUT', { x: 'int32', y: 'int32', data: 'uint32', flags: 'uint32', time: 'uint32', extra: 'uintptr' });
    const input = koffi.struct('QA_INPUT', { type: 'uint32', data: koffi.union('QA_INPUT_UNION', { ki, mi }) });
    const send = user.func('__stdcall', 'SendInput', 'uint32', ['uint32', koffi.pointer(input), 'int32']);
    const stroke = (up: boolean) => ({ type: 1, data: { ki: { vk: 0xa3, scan: 0, flags: 1 | (up ? 2 : 0), time: 0, extra: 0 } } });
    assert(send(1, [stroke(false)], koffi.sizeof(input)) === 1, 'SendInput rejected Right Ctrl down');
    await wait(60);
    assert(send(1, [stroke(true)], koffi.sizeof(input)) === 1, 'SendInput rejected Right Ctrl up');
  } else if (process.platform === 'darwin') {
    const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
    const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
    const create = cg.func('CGEventCreateKeyboardEvent', 'void *', ['void *', 'uint16', 'bool']);
    const flags = cg.func('CGEventSetFlags', 'void', ['void *', 'uint64']);
    const post = cg.func('CGEventPost', 'void', ['uint32', 'void *']);
    const release = cf.func('CFRelease', 'void', ['void *']);
    for (const down of [true, false]) {
      const event = create(null, 62, down);
      assert(event, 'Quartz could not construct Right Ctrl');
      try { flags(event, down ? 1 << 18 : 0); post(0, event); } finally { release(event); }
      await wait(60);
    }
  } else {
    const x11 = koffi.load('libX11.so.6');
    const xtst = koffi.load('libXtst.so.6');
    const open = x11.func('XOpenDisplay', 'void *', ['str']);
    const close = x11.func('XCloseDisplay', 'int', ['void *']);
    const symbol = x11.func('XStringToKeysym', 'ulong', ['str']);
    const code = x11.func('XKeysymToKeycode', 'uint8', ['void *', 'ulong']);
    const sync = x11.func('XSync', 'int', ['void *', 'bool']);
    const send = xtst.func('XTestFakeKeyEvent', 'int', ['void *', 'uint', 'bool', 'ulong']);
    const display = open(process.env.DISPLAY ?? null);
    assert(display, 'XTest could not open the current display');
    try {
      const ctrl = code(display, symbol('Control_R'));
      assert(ctrl, 'X11 keyboard has no Right Ctrl mapping');
      for (const down of [true, false]) {
        assert(send(display, ctrl, down, 0), 'XTest rejected Right Ctrl');
        sync(display, false);
        await wait(60);
      }
    } finally { close(display); }
  }
}

async function saveClipboard(): Promise<Record<string, Blob | Electron.ClipboardBookmark>[]> {
  const snapshot: Record<string, Blob | Electron.ClipboardBookmark>[] = [];
  for (const item of await clipboard.read()) {
    const formats: Record<string, Blob | Electron.ClipboardBookmark> = {};
    for (const type of item.types) formats[type] = await item.getType(type);
    if (item.types.length) snapshot.push(formats);
  }
  return snapshot;
}

async function run(): Promise<void> {
  await app.whenReady();
  const reportPath = process.env.DICTATE_NATIVE_QA_REPORT!;
  const report: Record<string, unknown> = { ok: false, status: 'failed', platform: process.platform, arch: process.arch, electron: process.versions.electron, checks: [] };
  const checks = report.checks as string[];
  const events: FromHook[] = [];
  let hook: KeyHook | undefined;
  let original: Awaited<ReturnType<typeof saveClipboard>> | undefined;
  const ownText = new Set(['QA clipboard baseline', 'Native cross-platform paste ✓ — سلام']);
  let exitCode = 1;
  try {
    // This exercises real framework symbols and Cocoa messages even on a runner whose TCC is denied.
    if (process.platform === 'darwin') {
      const desktop = createMacDesktop();
      report.macNative = { foregroundPid: desktop.foregroundWindow(), lowPower: desktop.batterySaverOn(), listening: desktop.listeningAllowed(), posting: desktop.postingAllowed() };
      checks.push('macOS Cocoa/Quartz framework initialization');
    }
    const capabilities = platformCapabilities();
    report.capabilities = capabilities;
    original = await saveClipboard();
    await clipboard.write([new ClipboardItem({ 'text/plain': 'QA clipboard baseline', 'text/html': '<b>QA clipboard baseline</b>' })]);
    assert(await clipboard.readText() === 'QA clipboard baseline', 'Native clipboard round trip failed');
    checks.push('native clipboard write/read');
    if (!capabilities.automaticPaste || !capabilities.globalHotkeys) {
      report.status = 'blocked';
      report.prerequisite = capabilities.reason ?? 'Native global keyboard input and automatic paste are unavailable';
      exitCode = 2;
      return;
    }
    const target = new BrowserWindow({ width: 720, height: 420, title: 'Dictate native input QA', webPreferences: { sandbox: true } });
    await target.loadURL(`data:text/html,${encodeURIComponent('<html><body style="font:20px sans-serif;background:#f1f1f1;padding:24px"><h2>Native Dictate input QA</h2><textarea autofocus style="width:95%;height:190px;font-size:20px"></textarea></body></html>')}`);
    target.show(); target.focus();
    await wait(400);
    const identity = foregroundWindow();
    assert(identity > 1 && isWindow(identity), 'No valid native foreground identity');
    assert(setForeground(identity), 'Could not restore native target focus');
    report.target = identity;
    checks.push('native foreground identity/refocus');
    await wait(120);
    const sink = realPasteSink({ ownPid: -1, modifiersDown: () => false, log: (level, message) => console.log(level, message) });
    const text = 'Native cross-platform paste ✓ — سلام';
    const delivery = await sink.deliver(text, 'paste');
    await wait(250);
    const value = await target.webContents.executeJavaScript('document.querySelector("textarea").value');
    assert(value === text, `Native paste did not land exactly: ${JSON.stringify({ delivery, value })}`);
    const kept = await clipboard.readText();
    assert(kept === (delivery.confirmed ? 'QA clipboard baseline' : text), 'Clipboard restore/retention mismatch');
    report.delivery = delivery;
    report.pasted = value;
    checks.push('Unicode clipboard paste into real textarea', delivery.confirmed ? 'clipboard snapshot restored' : 'unconfirmed caret retains copied result');
    await target.webContents.executeJavaScript('document.querySelector("textarea").value=""');
    const literal = 'Literal "quoted"\nASCII fallback';
    assert(typeText(literal), 'Native typing rejected literal fallback');
    await wait(250);
    const typed = await target.webContents.executeJavaScript('document.querySelector("textarea").value');
    assert(typed === literal, `Native typing did not land exactly: ${JSON.stringify(typed)}`);
    report.typed = typed;
    checks.push('literal native typing fallback');
    if (process.platform === 'linux') {
      assert(!typeText('Unicode کوردی'), 'Unreliable Unicode XTest fallback claimed success');
      checks.push('unsupported Unicode typing rejects before partial delivery');
    }
    hook = new KeyHook(process.env.DICTATE_NATIVE_QA_HOOK!, (event) => events.push(event), (level, message) => console.log(level, message));
    hook.start();
    for (let i = 0; i < 40 && !events.some((event) => event.type === 'ready'); i++) await wait(50);
    assert(events.some((event) => event.type === 'ready'), `Native hook never became ready: ${JSON.stringify(events)}`);
    await wait(200);
    await physicalRightCtrl();
    await wait(200);
    assert(events.some((event) => event.type === 'key' && event.vk === 0xa3 && event.down), `Native hook missed Right Ctrl down: ${JSON.stringify(events)}`);
    assert(events.some((event) => event.type === 'key' && event.vk === 0xa3 && !event.down), 'Native hook missed Right Ctrl up');
    assert(!events.some((event) => event.type === 'key' && event.vk === 0xa2), 'Physical Right Ctrl produced an unexpected left-side modifier');
    checks.push('native physical Right Ctrl down/up through real hook');
    hook.stop(); hook = undefined;
    report.events = events;
    fs.writeFileSync(`${reportPath}.png`, (await target.webContents.capturePage()).toPNG());
    report.screenshot = `${reportPath}.png`;
    report.ok = true;
    report.status = 'passed';
    exitCode = 0;
  } catch (error) {
    report.error = (error as Error).stack ?? String(error);
    report.events = events;
  } finally {
    hook?.stop();
    try {
      if (original && ownText.has(await clipboard.readText())) {
        if (original.length) await clipboard.write(original.map((formats) => new ClipboardItem(formats)));
        else clipboard.clear();
      }
    } catch (error) {
      report.clipboardRestoreError = (error as Error).message;
      if (report.ok) { report.ok = false; report.status = 'failed'; exitCode = 1; }
    }
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`NATIVE_INPUT_${String(report.status).toUpperCase()}`);
    app.exit(exitCode);
  }
}

void run().catch((error) => { console.error(error); app.exit(1); });
