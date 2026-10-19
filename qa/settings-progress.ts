import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { bindingLabel } from '../src/core/hotkeys';
import { defaultSettings } from '../src/core/settings';

app.disableHardwareAcceleration();
app.setPath('userData', process.env.DICTATE_SETTINGS_QA_PROFILE!);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report: Record<string, unknown> = { ok: false, platform: process.platform, arch: process.arch, productionRendererAndPreload: true, physicalMicrophone: false };

void app.whenReady().then(async () => {
  let settings = { ...defaultSettings([]), onboarded: false };
  let setup = { phase: 'idle', kind: 'speech', file: '', received: 0, total: 10485760 };
  let onboardingChoice: boolean | undefined;
  let version = '0.1.0';
  const state = () => ({
    settings, setup, speechInstalled: false, stt: 'loading', sttError: '',
    labels: { hotkey: bindingLabel(settings.hotkeys[0] ?? null), hotkeys: settings.hotkeys.map(bindingLabel), toggle: bindingLabel(settings.toggle), picker: bindingLabel(settings.picker) },
    devices: [], mic: null, defaultMicLabel: 'QA microphone', gain: 0, micBluetooth: false,
    servers: { gemma: 'stopped', emberon: 'stopped' }, effectiveChain: settings.cleanup, onBattery: false, missing: [],
    history: { count: 0, samples: 0, median: null }, logFile: 'dictate.log', version,
    platform: { platform: process.platform, displayServer: 'x11', globalHotkeys: true, canSwallowKeys: false, automaticPaste: true, accessibilityRequired: false, accessibilityGranted: true },
    microphonePermission: 'granted', shortcutRegistered: false, shortcutRequested: false, startupError: '', recording: false, automation: true,
  });
  ipcMain.handle('dictate:get-state', state);
  ipcMain.handle('dictate:set-settings', (_event, patch) => { settings = { ...settings, ...patch }; return state(); });
  ipcMain.handle('dictate:finish-onboarding', (_event, on: boolean) => { onboardingChoice = on; settings.onboarded = true; return state(); });
  ipcMain.on('dictate:renderer-error', (_event, page, message) => { throw new Error(`${page}: ${message}`); });
  const win = new BrowserWindow({ width: 1000, height: 800, show: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true } });
  const js = <T>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const check = async (code: string, message: string) => assert.equal(await js(code), true, message);
  try {
    await win.loadFile(path.join(__dirname, 'settings.html'));
    for (let n = 0; n < 100 && !await js<boolean>('document.body.innerText.includes("Welcome to dictate")'); n++) await pause(30);
    await js(`(() => {
      const row = [...document.querySelectorAll('.card')].find(e => e.querySelector('.cardtitle')?.textContent === 'Start at login');
      const input = row.querySelector('input'); input.click();
      if (input.checked) throw new Error('Could not select Start at login Off');
    })()`);
    setup = { ...setup, phase: 'downloading', file: 'speech.tar.bz2', received: 1048576 };
    win.webContents.send('dictate:state', state());
    await pause(60);
    await check(`![...document.querySelectorAll('.card')].find(e => e.querySelector('.cardtitle')?.textContent === 'Start at login').querySelector('input').checked`, 'Start at login choice changed during state refresh');
    await js(`window.__progressControls = { meter: document.querySelector('.meter'), checkbox: [...document.querySelectorAll('.card')].find(e => e.querySelector('.cardtitle')?.textContent === 'Start at login').querySelector('input') }`);
    for (let n = 2; n <= 8; n++) {
      setup = { ...setup, received: n * 1048576 };
      win.webContents.send('dictate:setup-progress', setup);
    }
    await pause(60);
    await check(`document.body.innerText.includes('8 / 10 MB') && document.querySelector('.meter') === window.__progressControls.meter && document.contains(window.__progressControls.checkbox) && !window.__progressControls.checkbox.checked`, 'Download progress replaced the meter/startup control or failed to update');
    report.progressPreservesControls = true;
    await js(`[...document.querySelectorAll('button')].find(e => e.textContent === 'Get started').click()`);
    for (let n = 0; n < 100 && onboardingChoice === undefined; n++) await pause(20);
    assert.equal(onboardingChoice, false, 'Onboarding must submit the chosen Off value');
    report.onboardingOffRetained = true;
    await js(`[...document.querySelectorAll('nav button')].find(e => e.textContent.includes('Advanced')).click()`);
    await js(`(() => { const input = document.querySelector('[data-setting="modelsDir"]'); input.focus(); input.value = '/draft/models folder'; input.setSelectionRange(3, 13); window.__draft = input; })()`);
    setup = { ...setup, received: 9 * 1048576 };
    win.webContents.send('dictate:setup-progress', setup);
    await pause(60);
    await check(`document.activeElement === window.__draft && window.__draft.value === '/draft/models folder' && window.__draft.selectionStart === 3 && window.__draft.selectionEnd === 13`, 'Progress interrupted the active path draft or selection');
    win.webContents.send('dictate:state', state());
    await pause(60);
    await check(`document.activeElement?.dataset.setting === 'modelsDir' && document.activeElement.value === '/draft/models folder' && document.activeElement.selectionStart === 3 && document.activeElement.selectionEnd === 13`, 'A normal state update lost the active path draft or selection');
    await js(`(() => { const input = document.querySelector('[data-setting="tapMs"]'); input.focus(); input.value = '370'; window.__draft = input; })()`);
    win.webContents.send('dictate:setup-progress', { ...setup, phase: 'extracting' });
    await pause(60);
    await check(`document.activeElement === window.__draft && window.__draft.value === '370' && document.body.innerText.includes('Verifying and installing')`, 'Progress interrupted the active number draft or failed to update');
    win.webContents.send('dictate:state', state());
    await pause(60);
    await check(`document.activeElement?.dataset.setting === 'tapMs' && document.activeElement.value === '370'`, 'A normal state update lost the active number draft');
    report.pathDraftAndSelectionRetained = true;
    report.numberDraftRetained = true;
    // Exercise the normal browser/OS input sequence, including blur between press and release.
    // Calling HTMLElement.click() would omit that sequence and miss a mid-press DOM replacement.
    const point = await js<{ x: number; y: number }>(`(() => {
      const button = [...document.querySelectorAll('nav button')].find(e => e.textContent.includes('History'));
      const b = button.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
    })()`);
    await js(`window.__clickEvents = []; for (const type of ['mousedown','focusout','mouseup','click']) document.addEventListener(type, e => window.__clickEvents.push({type, target: e.target.textContent?.slice(0, 60)}), true)`);
    win.focus();
    if (process.platform === 'linux') {
      const bounds = win.getContentBounds();
      const mouse = (...args: string[]) => {
        const p = spawnSync('xdotool', args, { encoding: 'utf8', timeout: 5_000 });
        assert.equal(p.status, 0, p.error?.message ?? p.stderr);
      };
      mouse('mousemove', '--sync', String(bounds.x + point.x), String(bounds.y + point.y));
      mouse('mousedown', '1');
      await pause(100);
      mouse('mouseup', '1');
    } else {
      win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
      win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
      await pause(100);
      win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    }
    await pause(120);
    const heading = await js<string>('document.querySelector("main h1")?.textContent');
    report.pointerClickAfterDeferredState = { source: process.platform === 'linux' ? 'X11 xdotool native mouse' : 'Chromium input events', expectedPage: 'History', actualHeading: heading, events: await js('window.__clickEvents') };
    assert.equal(heading, 'History', 'A pointer click after an Advanced pending render must activate History');
    await js(`[...document.querySelectorAll('nav button')].find(e => e.textContent.includes('Advanced')).click(); document.querySelector('[data-setting="doubleTapMs"]').focus()`);
    version = '0.1.1';
    win.webContents.send('dictate:state', state());
    await pause(60);
    await check(`!document.body.innerText.includes('dictate 0.1.1')`, 'State refresh should defer while the input remains focused');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await pause(120);
    await check(`document.body.innerText.includes('dictate 0.1.1')`, 'Keyboard blur must still flush a deferred state refresh');
    report.keyboardBlurRefreshes = true;
    report.ok = true;
  } catch (error) { report.error = (error as Error).stack ?? String(error); }
  finally {
    fs.writeFileSync(process.env.DICTATE_SETTINGS_QA_REPORT!, `${JSON.stringify(report, null, 2)}\n`);
    app.exit(report.ok ? 0 : 1);
  }
});
