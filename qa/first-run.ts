// The first-run download and speed check against the real servers, with no UI and no desktop: the essentials
// download is cancelled part-way and resumed, a full disk is refused, then the speed check times real cleanups.
// Run through qa/first-run.mjs, which bundles this file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runChain, stepsFor, type ChainDeps, type CleanupModel } from '../src/core/chain';
import { EMBERON_GGUF, GEMMA_GGUF } from '../src/core/settings';
import { chatRequest } from '../src/core/templating';
import { LlamaServer } from '../src/engine/llama';
import { runHardwareCheck } from '../src/main/hardware';
import { type SetupState, essentialsInstalled, SetupManager } from '../src/main/setup';

const root = path.resolve(process.env.DICTATE_QA_ROOT ?? '.');
const dir = process.env.DICTATE_QA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dictate-first-run-'));
const modelsDir = path.join(dir, 'models');
const binDir = path.join(dir, 'bin');
const options = { modelsDir, binDir, platform: process.platform, arch: process.arch };
const report: Record<string, unknown> = { ok: false, platform: process.platform, arch: process.arch, dir };
const exe = path.join(binDir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');

async function interruptedThenResumed(): Promise<void> {
  const setup = new SetupManager();
  const cutAt = 0.3;
  let cutBytes = 0;
  setup.onChange = () => {
    const s = setup.state;
    if (!cutBytes && s.phase === 'downloading' && s.total && (s.received ?? 0) > s.total * cutAt) {
      cutBytes = s.received ?? 0;
      setup.cancel();
    }
  };
  const t0 = Date.now();
  const first = await setup.install('essentials', options).then(() => 'finished', (e: Error) => e.message);
  report.interrupted = { file: setup.state.file, atBytes: cutBytes, result: first, message: setup.state.message, seconds: (Date.now() - t0) / 1000 };
  if (!cutBytes) throw new Error(`the download was never cut: ${first}`);

  const resumed = new SetupManager();
  const seen: SetupState[] = [];
  resumed.onChange = () => seen.push({ ...resumed.state });
  const t1 = Date.now();
  await resumed.install('essentials', options);
  const firstProgress = seen.find((s) => s.phase === 'downloading');
  const speeds = seen.map((s) => s.bytesPerSecond).filter((x): x is number => !!x);
  report.resumed = {
    firstFile: firstProgress?.file,
    firstReceived: firstProgress?.received,
    resumedFromCut: (firstProgress?.received ?? 0) >= cutBytes,
    overallTotal: firstProgress?.overallTotal,
    medianMBps: speeds.length ? +(speeds.sort((a, b) => a - b)[Math.floor(speeds.length / 2)] / 1e6).toFixed(1) : null,
    sawEta: seen.some((s) => typeof s.etaSeconds === 'number'),
    seconds: (Date.now() - t1) / 1000,
  };
  if ((firstProgress?.received ?? 0) < cutBytes) throw new Error(`resume restarted: first progress ${firstProgress?.received} < cut ${cutBytes}`);
  if (!essentialsInstalled(modelsDir, binDir, process.platform)) throw new Error('essentials are not installed after the resumed download');
  report.essentialsInstalled = true;
}

async function fullDiskRefused(): Promise<void> {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dictate-full-disk-'));
  const setup = new SetupManager();
  let fetched = false;
  setup.onChange = () => { if (setup.state.phase === 'downloading' && (setup.state.received ?? 0) > 0) fetched = true; };
  const message = await setup.install('essentials', { ...options, modelsDir: path.join(empty, 'models'), binDir: path.join(empty, 'bin'), freeBytes: async () => 300e6 }).then(() => 'finished', (e: Error) => e.message);
  report.fullDisk = { message, fetchedAnything: fetched };
  fs.rmSync(empty, { recursive: true, force: true });
  if (!/^Not enough disk space/.test(message) || fetched) throw new Error(`a full disk was not refused before downloading: ${message}`);
}

async function speedCheck(): Promise<void> {
  const v3 = fs.readFileSync(path.join(root, 'defaults/prompt-v3.txt'), 'utf8');
  const all = stepsFor('gemma-emberon', v3, []);
  const log = (level: string, msg: string) => level === 'error' && console.error(msg);
  const servers: Record<CleanupModel, LlamaServer> = {
    gemma: new LlamaServer('gemma', { exe, gguf: path.join(modelsDir, GEMMA_GGUF), log, warmup: () => chatRequest(all[0].system, 'warm up') }),
    emberon: new LlamaServer('emberon', { exe, gguf: path.join(modelsDir, EMBERON_GGUF), log, warmup: () => chatRequest(all[1].system, 'warm up') }),
  };
  const gemma = fs.existsSync(path.join(modelsDir, GEMMA_GGUF));
  const deps: ChainDeps = { ready: (m) => servers[m].whenReady(90_000), complete: (m, body, signal) => servers[m].complete(body, signal) };
  try {
    await Promise.all([servers.emberon.start(), gemma ? servers.gemma.start() : undefined]);
    const r = await runHardwareCheck({
      llamaServer: exe,
      modelsDir,
      sample: fs.readFileSync(path.join(root, 'defaults/hardware-sample.txt'), 'utf8'),
      clean: (text, chain) => runChain(text, stepsFor(chain, v3, []), deps, { timeoutMs: 3000 }),
      measureGemma: gemma,
    });
    report.speedCheck = { devices: r.devices, emberonMs: r.emberonMs, gemmaChainMs: r.gemmaChainMs, failure: r.failure, chain: r.choice.chain, offerGemma: r.choice.offerGemma, summary: r.choice.summary };
    if (r.failure) throw new Error(`speed check failed: ${r.failure}`);
  } finally {
    servers.gemma.stop();
    servers.emberon.stop();
  }
}

void (async () => {
  try {
    if (!process.env.DICTATE_QA_SKIP_DOWNLOAD) await interruptedThenResumed();
    await fullDiskRefused();
    if (process.env.DICTATE_QA_GEMMA) {
      const t0 = Date.now();
      await new SetupManager().install('cleanup', { ...options, cleanupModels: ['gemma'] });
      report.gemmaDownloadSeconds = (Date.now() - t0) / 1000;
    }
    await speedCheck();
    report.ok = true;
  } catch (err) {
    report.error = (err as Error).stack ?? String(err);
  } finally {
    const out = process.env.DICTATE_QA_REPORT;
    if (out) fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  }
})();
