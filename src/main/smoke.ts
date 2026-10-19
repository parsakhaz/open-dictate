// Real packaged startup check: native bindings load inside Electron and its recognizer utility process,
// every actual renderer runs its preload/IPC, and the report is written before the isolated app quits.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, MessageChannelMain, utilityProcess } from 'electron';
import { STT_MODEL } from '../core/settings';
import { readWav } from '../engine/wav';
import { platformCapabilities } from '../native/platform';

interface RecognizerProbe { sherpa: boolean; inference?: { text: string; partials: number; audioMs: number } }
interface ProbeDiagnostics {
  phase: string;
  elapsedMs: number;
  loadMs?: number;
  inferenceMs?: number;
  partials: number;
  lastMessage?: string;
  stderr?: string;
  budgets: { loadMs: number; inferenceMs: number; overallMs: number };
}
async function probeRecognizer(diagnostics: ProbeDiagnostics): Promise<RecognizerProbe> {
  const child = utilityProcess.fork(path.join(app.getAppPath(), 'out', 'engine', 'stt-worker.js'), [], { stdio: 'pipe' });
  return new Promise<RecognizerProbe>((resolve, reject) => {
    const started = performance.now();
    let inferenceStarted = 0;
    let settled = false;
    let partials = 0;
    let audioPort: Electron.MessagePortMain | undefined;
    let phaseTimer: ReturnType<typeof setTimeout>;
    const overallTimer = setTimeout(() => finish(`Recognizer overall budget exceeded during ${diagnostics.phase}`), diagnostics.budgets.overallMs);
    const finish = (error?: string, result: RecognizerProbe = { sherpa: false }) => {
      if (settled) return;
      settled = true;
      clearTimeout(phaseTimer);
      clearTimeout(overallTimer);
      diagnostics.elapsedMs = Math.round(performance.now() - started);
      audioPort?.close();
      child.kill();
      if (error) reject(new Error(`${error}; elapsed ${diagnostics.elapsedMs} ms, partials ${partials}, last message ${diagnostics.lastMessage ?? 'none'}`));
      else { diagnostics.phase = 'complete'; resolve(result); }
    };
    const phase = (name: string, budget: number) => {
      diagnostics.phase = name;
      console.log(`Packaged recognizer: ${name} (bounded ${budget} ms)`);
      clearTimeout(phaseTimer);
      phaseTimer = setTimeout(() => finish(`Recognizer ${name} timed out after ${budget} ms`), budget);
    };
    child.stderr?.on('data', data => { diagnostics.stderr = `${diagnostics.stderr ?? ''}${String(data)}`.slice(-8000); });
    child.on('message', (m: { type: string; sherpa?: boolean; message?: string; text?: string; audioMs?: number }) => {
      if (settled) return;
      diagnostics.lastMessage = m.type;
      if (m.type === 'probed') finish(undefined, { sherpa: m.sherpa === true });
      else if (m.type === 'error') finish(m.message || 'Recognizer native binding failed');
      else if (m.type === 'ready') {
        diagnostics.loadMs = Math.round(performance.now() - started);
        inferenceStarted = performance.now();
        phase('inference', diagnostics.budgets.inferenceMs);
        try {
          const { samples, sampleRate } = readWav(process.env.DICTATE_SMOKE_WAV!);
          if (sampleRate !== 16000) throw new Error('Smoke fixture must be 16 kHz');
          audioPort!.postMessage({ type: 'begin', id: 1 });
          for (let i = 0; i < samples.length; i += 1600) audioPort!.postMessage({ type: 'frame', id: 1, samples: samples.slice(i, i + 1600) });
          audioPort!.postMessage({ type: 'end', id: 1 });
        } catch (err) { finish((err as Error).message); }
      } else if (m.type === 'partial') { partials++; diagnostics.partials = partials; }
      else if (m.type === 'final') {
        diagnostics.inferenceMs = Math.round(performance.now() - inferenceStarted);
        const text = m.text ?? '';
        if (!partials || !text.toLowerCase().includes('deploy the kubernetes cluster with terraform') || !text.toLowerCase().includes('nemotron streaming models')) finish(`Packaged recognizer returned an unexpected transcript: ${text}`);
        else finish(undefined, { sherpa: true, inference: { text, partials, audioMs: m.audioMs ?? 0 } });
      }
    });
    child.on('exit', (code) => { if (!settled) finish(`Recognizer process exited ${code} during ${diagnostics.phase}`); });
    if (process.env.DICTATE_SMOKE_MODEL_DIR && process.env.DICTATE_SMOKE_WAV) {
      phase('model load', diagnostics.budgets.loadMs);
      const { port1, port2 } = new MessageChannelMain();
      child.postMessage({ type: 'attach' }, [port1]);
      audioPort = port2;
      port2.start();
      child.postMessage({ type: 'init', modelDir: path.join(process.env.DICTATE_SMOKE_MODEL_DIR, STT_MODEL), threads: 4 });
    } else { phase('native binding probe', diagnostics.budgets.loadMs); child.postMessage({ type: 'probe' }); }
  });
}

/**
 * The agents' bridge as an agent runs it: copied out of the bundle into the data folder, started with the app's own
 * executable as Node, answering MCP over stdio and reaching the running app over its channel.
 */
async function probeAgents(): Promise<{ bridgeCopied: boolean; tools: string[]; status: boolean }> {
  const dir = path.join(app.getPath('userData'), 'agents');
  const bridge = path.join(dir, 'dictate-mcp.js');
  for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, 'channel.json')); i++) await new Promise((r) => setTimeout(r, 100));
  if (!fs.existsSync(bridge)) throw new Error(`The agents' bridge was not copied to ${bridge}`);
  const child = spawn(process.execPath, [bridge], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const replies = new Map<number, Record<string, unknown>>();
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        replies.set(m.id, m.result);
      }
    });
    const ask = async (id: number, method: string, params: unknown) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      for (let i = 0; i < 100 && !replies.has(id); i++) await new Promise((r) => setTimeout(r, 100));
      const r = replies.get(id);
      if (!r) throw new Error(`The agents' bridge did not answer ${method}`);
      return r;
    };
    await ask(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dictate-smoke' } });
    const tools = ((await ask(2, 'tools/list', {})).tools as { name: string }[]).map((t) => t.name);
    const status = (await ask(3, 'tools/call', { name: 'status', arguments: {} })).structuredContent as { running?: boolean } | undefined;
    return { bridgeCopied: true, tools, status: status?.running === true };
  } finally {
    child.kill();
  }
}

export async function runSmoke(reportPath: string): Promise<void> {
  const report: Record<string, unknown> = { ok: false, platform: process.platform, arch: process.arch, packaged: app.isPackaged, version: app.getVersion(), hardwareAccelerationDisabled: true, loginItemsUnchanged: true, singleInstanceLockSkipped: process.env.DICTATE_SMOKE_SKIP_INSTANCE_LOCK === '1' };
  try {
    const koffi = require('koffi') as { load: unknown };
    const uiohook = require('uiohook-napi') as { uIOhook: unknown };
    const diagnostics: ProbeDiagnostics = { phase: 'launch', elapsedMs: 0, partials: 0, budgets: { loadMs: 60_000, inferenceMs: 60_000, overallMs: 120_000 } };
    report.recognizerProbe = diagnostics;
    const recognizer = await probeRecognizer(diagnostics);
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
        // The page's first request crosses the real preload and main IPC handlers.
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
    report.agents = await probeAgents();
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
