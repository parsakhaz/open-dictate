// Real packaged startup check: native bindings load inside Electron and its recognizer utility process,
// every actual renderer runs its preload/IPC, and the report is written before the isolated app quits.
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, utilityProcess } from 'electron';
import { platformCapabilities } from '../native/platform';

async function probeRecognizer(): Promise<boolean> {
  const child = utilityProcess.fork(path.join(app.getAppPath(), 'out', 'engine', 'stt-worker.js'), [], { stdio: 'pipe' });
  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Recognizer probe timed out')); }, 20_000);
    const finish = (error?: string, okay = false) => {
      clearTimeout(timer);
      child.kill();
      if (error) reject(new Error(error)); else resolve(okay);
    };
    child.on('message', (m: { type: string; sherpa?: boolean; message?: string }) => {
      if (m.type === 'probed') finish(undefined, m.sherpa === true);
      else if (m.type === 'error') finish(m.message || 'Recognizer native binding failed');
    });
    child.on('exit', (code) => { if (code !== 0) finish(`Recognizer probe exited: ${code}`); });
    child.postMessage({ type: 'probe' });
  });
}

export async function runSmoke(reportPath: string): Promise<void> {
  const report: Record<string, unknown> = { ok: false, platform: process.platform, arch: process.arch, packaged: app.isPackaged, version: app.getVersion(), singleInstanceLockSkipped: process.env.DICTATE_SMOKE_SKIP_INSTANCE_LOCK === '1' };
  try {
    const koffi = require('koffi') as { load: unknown };
    const uiohook = require('uiohook-napi') as { uIOhook: unknown };
    const sherpa = await probeRecognizer();
    report.native = { sherpa, koffi: typeof koffi.load === 'function', uiohook: !!uiohook.uIOhook };
    if (!sherpa) throw new Error('Recognizer constructor is absent');
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
