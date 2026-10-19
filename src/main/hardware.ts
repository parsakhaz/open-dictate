// Runs the hardware check: RAM, threads, llama-server's devices, then times the bundled sample through the
// caller's cleanup (main passes its own Cleanup, so there is one server lifecycle). No Electron imports.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chooseChain, type GpuDevice, type HardwareChoice, median, parseListDevices } from '../core/hardware';
import { EMBERON_GGUF, GEMMA_GGUF } from '../core/settings';
import type { CleanupChain, StepResult } from '../core/types';

export interface HardwareCheckOptions {
  llamaServer: string;
  modelsDir: string;
  /** defaults/hardware-sample.txt: ~5 s of raw dictation. */
  sample: string;
  /** Cleans `text` with `chain`, with that chain's servers started (runChain's result). */
  clean: (text: string, chain: CleanupChain) => Promise<{ text: string; steps: StepResult[] }>;
  /** Also time Gemma → Emberon, if the Gemma file is there. */
  measureGemma?: boolean;
  /** Warm runs after the one cold run; 3. */
  warmRuns?: number;
  exec?: (file: string, args: string[], timeoutMs: number) => Promise<string>;
  exists?: (p: string) => boolean;
  now?: () => number;
  date?: () => Date;
  totalRamBytes?: number;
  cpuThreads?: number;
}

/** JSON-serialisable; main saves it in settings. */
export interface HardwareReport {
  devices: GpuDevice[];
  totalRamBytes: number;
  cpuThreads: number;
  emberonMs: number | null;
  gemmaChainMs: number | null;
  /** Why the Emberon measurement failed. */
  failure?: string;
  choice: HardwareChoice;
  /** ISO time. */
  measuredAt: string;
}

function execText(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => (err ? reject(err) : resolve(`${stdout}\n${stderr}`)));
  });
}

/** Warm median of `chain` on the sample, after one cold run; a timeout counts as slow, any other failure throws. */
async function measure(opts: HardwareCheckOptions, chain: CleanupChain): Promise<number> {
  const now = opts.now ?? (() => performance.now());
  const times: number[] = [];
  for (let i = 0; i <= (opts.warmRuns ?? 3); i++) {
    const t0 = now();
    const r = await opts.clean(opts.sample, chain);
    const ms = now() - t0;
    const bad = r.steps.find((s) => s.status !== 'ok' && s.status !== 'timeout');
    if (bad) throw new Error(`${bad.model} ${bad.status}${bad.reason ? `: ${bad.reason}` : ''}`);
    if (i > 0) times.push(ms);
  }
  return median(times) ?? 0;
}

export async function runHardwareCheck(opts: HardwareCheckOptions): Promise<HardwareReport> {
  const exists = opts.exists ?? fs.existsSync;
  const totalRamBytes = opts.totalRamBytes ?? os.totalmem();
  const cpuThreads = opts.cpuThreads ?? os.availableParallelism?.() ?? os.cpus().length;
  const devices = await (opts.exec ?? execText)(opts.llamaServer, ['--list-devices'], 10_000).then(parseListDevices, () => []);
  let emberonMs: number | null = null;
  let gemmaChainMs: number | null = null;
  let failure: string | undefined;
  if (!exists(opts.llamaServer)) failure = 'llama-server is missing';
  else if (!exists(path.join(opts.modelsDir, EMBERON_GGUF))) failure = 'Emberon is not downloaded';
  else {
    try {
      emberonMs = await measure(opts, 'emberon');
    } catch (err) {
      failure = (err as Error).message;
    }
  }
  if (emberonMs != null && opts.measureGemma && exists(path.join(opts.modelsDir, GEMMA_GGUF))) {
    gemmaChainMs = await measure(opts, 'gemma-emberon').catch(() => null);
  }
  const input = { totalRamBytes, cpuThreads, devices, emberonMs, gemmaChainMs, ...(failure ? { failure } : {}) };
  return { ...input, choice: chooseChain(input), measuredAt: (opts.date ?? (() => new Date()))().toISOString() };
}
