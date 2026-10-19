// Real packaged startup check: native bindings load inside Electron and its recognizer utility process,
// every actual renderer runs its preload/IPC, and the report is written before the isolated app quits.
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, MessageChannelMain, utilityProcess } from 'electron';
import { STT_MODEL } from '../core/settings';
import { readWav } from '../engine/wav';
import { platformCapabilities } from '../native/platform';

interface RecognizerProbe { sherpa: boolean; inference?: { text: string; partials: number; audioMs: number } }
async function probeRecognizer(): Promise<RecognizerProbe> {
  const child = utilityProcess.fork(path.join(app.getAppPath(), 'out', 'engine', 'stt-worker.js'), [], { stdio: 'pipe' });
  return new Promise<RecognizerProbe>((resolve, reject) => {
    let settled = false;
    let partials = 0;
    let audioPort: Electron.MessagePortMain | undefined;
    const timer = setTimeout(() => { child.kill(); reject(new Error('Recognizer probe timed out')); }, 20_000);
    const finish = (error?: string, result: RecognizerProbe = { sherpa: false }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audioPort?.close();
      child.kill();
      if (error) reject(new Error(error)); else resolve(result);
    };
    child.on('message', (m: { type: string; sherpa?: boolean; message?: string; text?: string; audioMs?: number }) => {
      if (m.type === 'probed') finish(undefined, { sherpa: m.sherpa === true });
      else if (m.type === 'error') finish(m.message || 'Recognizer native binding failed');
      else if (m.type === 'ready') {
        try {
          const { samples, sampleRate } = readWav(process.env.DICTATE_SMOKE_WAV!);
          if (sampleRate !== 16000) throw new Error('Smoke fixture must be 16 kHz');
          audioPort!.postMessage({ type: 'begin', id: 1 });
          for (let i = 0; i < samples.length; i += 1600) audioPort!.postMessage({ type: 'frame', id: 1, samples: samples.slice(i, i + 1600) });
          audioPort!.postMessage({ type: 'end', id: 1 });
        } catch (err) { finish((err as Error).message); }
      } else if (m.type === 'partial') partials++;
      else if (m.type === 'final') {
        const text = m.text ?? '';
        if (!partials || !text.toLowerCase().includes('deploy the kubernetes cluster with terraform') || !text.toLowerCase().includes('nemotron streaming models')) finish(`Packaged recognizer returned an unexpected transcript: ${text}`);
        else finish(undefined, { sherpa: true, inference: { text, partials, audioMs: m.audioMs ?? 0 } });
      }
    });
    child.on('exit', (code) => { if (code !== 0) finish(`Recognizer probe exited: ${code}`); });
    if (process.env.DICTATE_SMOKE_MODEL_DIR && process.env.DICTATE_SMOKE_WAV) {
      const { port1, port2 } = new MessageChannelMain();
      child.postMessage({ type: 'attach' }, [port1]);
      audioPort = port2;
      port2.start();
      child.postMessage({ type: 'init', modelDir: path.join(process.env.DICTATE_SMOKE_MODEL_DIR, STT_MODEL), threads: 4 });
    } else child.postMessage({ type: 'probe' });
  });
}

export async function runSmoke(reportPath: string): Promise<void> {
  const report: Record<string, unknown> = { ok: false, platform: process.platform, arch: process.arch, packaged: app.isPackaged, version: app.getVersion(), hardwareAccelerationDisabled: true, loginItemsUnchanged: true, singleInstanceLockSkipped: process.env.DICTATE_SMOKE_SKIP_INSTANCE_LOCK === '1' };
  try {
    const koffi = require('koffi') as { load: unknown };
    const uiohook = require('uiohook-napi') as { uIOhook: unknown };
    const recognizer = await probeRecognizer();
    report.native = { sherpa: recognizer.sherpa, koffi: typeof koffi.load === 'function', uiohook: !!uiohook.uIOhook };
    if (recognizer.inference) report.inference = recognizer.inference;
    if (!recognizer.sherpa) throw new Error('Recognizer constructor is absent');
    const windows = BrowserWindow.getAllWindows();
    if (windows.length < 3) throw new Error(`Expected settings, pill and history windows; found ${windows.length}`);
    const renderers: { title: string; elements: number; text: string }[] = [];
    for (const w of windows) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const count = await w.webContents.executeJavaScript('document.querySelector("#root")?.children.length ?? 0');
        if (count > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const content = await w.webContents.executeJavaScript('({elements:document.querySelector("#root")?.children.length??0,text:document.body.innerText})') as { elements: number; text: string };
      if (!content.elements) throw new Error(`Renderer did not start: ${w.getTitle()}`);
      renderers.push({ title: w.getTitle(), ...content });
      if (w.getTitle().includes('settings')) {
        // The page's first request crosses the real sandboxed preload and main IPC handlers.
        if (!content.text.includes('Welcome to dictate') && !content.text.includes('Hotkeys & output')) throw new Error('Settings IPC did not render a page');
        if (!w.isVisible()) w.show();
        await w.webContents.executeJavaScript('(async () => { await document.fonts.ready; await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); })()');
        const img = await w.webContents.capturePage();
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(`${reportPath}.png`, img.toPNG());
      }
    }
    report.renderers = renderers;
    report.rendererLoaded = true;
    report.capabilities = platformCapabilities();
    report.ok = true;
  } catch (err) {
    report.error = (err as Error).stack ?? String(err);
    process.exitCode = 1;
  } finally {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    if (report.ok) app.quit(); else app.exit(1);
  }
}
