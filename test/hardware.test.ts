import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chooseChain, type GpuDevice, median, parseListDevices, summarize } from '../src/core/hardware';
import { EMBERON_GGUF, GEMMA_GGUF } from '../src/core/settings';
import type { StepResult } from '../src/core/types';
import { type HardwareCheckOptions, runHardwareCheck } from '../src/main/hardware';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'hardware', `${name}.txt`), 'utf8');
const GB = 2 ** 30;
const IGPU: GpuDevice = { id: 'Vulkan0', name: 'AMD Radeon(TM) 8060S Graphics', backend: 'vulkan', memoryMiB: 65536, freeMiB: 64000, integrated: true };

describe('parseListDevices', () => {
  it('reads a discrete Vulkan GPU', () => {
    expect(parseListDevices(fixture('vulkan-discrete'))).toEqual([
      { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 4070', backend: 'vulkan', memoryMiB: 12282, freeMiB: 11520, integrated: false },
    ]);
  });

  it('reads an integrated Vulkan GPU', () => {
    expect(parseListDevices(fixture('vulkan-integrated'))).toEqual([IGPU]);
  });

  it('reads Apple silicon as Metal and unified', () => {
    expect(parseListDevices(fixture('metal'))).toEqual([{ id: 'Metal', name: 'Apple M2', backend: 'metal', memoryMiB: 10922, freeMiB: 10922, integrated: true }]);
  });

  it('finds nothing in a CPU-only build or empty output', () => {
    expect(parseListDevices(fixture('none'))).toEqual([]);
    expect(parseListDevices('')).toEqual([]);
  });

  it('names CUDA and other backends, and tells integrated Intel from Arc cards', () => {
    const out = 'Available devices:\n  CUDA0: NVIDIA RTX A2000 (6144 MiB, 6000 MiB free)\n  SYCL0: Intel(R) Arc(TM) A770 Graphics (16032 MiB, 16032 MiB free)\n  Vulkan1: Intel(R) UHD Graphics 770 (8000 MiB, 8000 MiB free)\n';
    expect(parseListDevices(out).map((d) => [d.backend, d.integrated])).toEqual([
      ['cuda', false],
      ['other', false],
      ['vulkan', true],
    ]);
  });
});

describe('median', () => {
  it('takes the middle, or the mean of the two middles', () => {
    expect(median([300, 100, 200])).toBe(200);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('chooseChain', () => {
  const base = { totalRamBytes: 32 * GB, cpuThreads: 16, devices: [IGPU], emberonMs: 400 };

  it('picks Emberon when it cleans the sample within a second', () => {
    expect(chooseChain(base).chain).toBe('emberon');
  });

  it('picks Gemma then Emberon when that chain was measured within a second', () => {
    expect(chooseChain({ ...base, gemmaChainMs: 900 }).chain).toBe('gemma-emberon');
    expect(chooseChain({ ...base, gemmaChainMs: 1200 }).chain).toBe('emberon');
  });

  it('turns cleanup off when Emberon is too slow or could not be measured', () => {
    expect(chooseChain({ ...base, emberonMs: 1000 }).chain).toBe('off');
    expect(chooseChain({ ...base, emberonMs: null }).chain).toBe('off');
  });

  it('offers Gemma with a 4 GB GPU or 16 GB of RAM, never under 8 GB of RAM', () => {
    const small: GpuDevice = { ...IGPU, memoryMiB: 2048 };
    expect(chooseChain(base).offerGemma).toBe(true);
    expect(chooseChain({ ...base, totalRamBytes: 8 * GB, devices: [{ ...IGPU, memoryMiB: 4096 }] }).offerGemma).toBe(true);
    expect(chooseChain({ ...base, totalRamBytes: 8 * GB, devices: [small] }).offerGemma).toBe(false);
    expect(chooseChain({ ...base, totalRamBytes: 16 * GB, devices: [] }).offerGemma).toBe(true);
    expect(chooseChain({ ...base, totalRamBytes: 6 * GB }).offerGemma).toBe(false);
  });

  it('puts every layer on a GPU when there is one, and uses half the threads up to 8', () => {
    expect(chooseChain(base)).toMatchObject({ gpuLayers: 99, threads: 8 });
    expect(chooseChain({ ...base, devices: [], cpuThreads: 6 })).toMatchObject({ gpuLayers: 0, threads: 3 });
    expect(chooseChain({ ...base, cpuThreads: 1 }).threads).toBe(1);
  });
});

describe('summarize', () => {
  it('names the GPU, the RAM and the time', () => {
    expect(summarize({ chain: 'emberon', devices: [IGPU], totalRamBytes: 127.6 * GB, emberonMs: 400 })).toBe(
      'Your PC: AMD Radeon 8060S (Vulkan), 128 GB RAM. Emberon cleaned the sample in 0.40 s.',
    );
  });

  it('says when there is no GPU', () => {
    expect(summarize({ chain: 'emberon', devices: [], totalRamBytes: 16 * GB, emberonMs: 620 })).toBe('No GPU found, 16 GB RAM. Emberon cleaned the sample in 0.62 s.');
  });

  it('prefers a discrete GPU and reports the Gemma chain time when that was chosen', () => {
    const rtx: GpuDevice = { id: 'Vulkan1', name: 'NVIDIA GeForce RTX 4070', backend: 'vulkan', memoryMiB: 12282, freeMiB: 11520, integrated: false };
    expect(summarize({ chain: 'gemma-emberon', devices: [IGPU, rtx], totalRamBytes: 32 * GB, emberonMs: 300, gemmaChainMs: 850 })).toBe(
      'Your PC: NVIDIA GeForce RTX 4070 (Vulkan), 32 GB RAM. Gemma and Emberon cleaned the sample in 0.85 s.',
    );
  });

  it('says cleanup was too slow', () => {
    expect(summarize({ chain: 'off', devices: [], totalRamBytes: 8 * GB, emberonMs: 2400 })).toBe('Cleanup was too slow here (2.4 s), so dictate types the raw transcript.');
  });

  it('says why the measurement failed', () => {
    expect(summarize({ chain: 'off', devices: [], totalRamBytes: 8 * GB, emberonMs: null, failure: 'Emberon is not downloaded' })).toBe(
      "Couldn't measure cleanup (Emberon is not downloaded), so cleanup is off. You can turn it on in Settings → Cleanup.",
    );
  });

  it('is what chooseChain returns', () => {
    expect(chooseChain({ totalRamBytes: 16 * GB, cpuThreads: 8, devices: [], emberonMs: 620 }).summary).toBe('No GPU found, 16 GB RAM. Emberon cleaned the sample in 0.62 s.');
  });
});

describe('runHardwareCheck', () => {
  const ok = (model: string, ms = 0): StepResult => ({ model, status: 'ok', ms });
  /** A fake clock that each clean() advances by the next duration. */
  function rig(durations: Record<string, number[]>, files = ['llama-server', path.join('models', EMBERON_GGUF), path.join('models', GEMMA_GGUF)]) {
    let t = 0;
    const calls: string[] = [];
    const execs: string[][] = [];
    const opts: HardwareCheckOptions = {
      llamaServer: 'llama-server',
      modelsDir: 'models',
      sample: 'so um the sample',
      totalRamBytes: 32 * GB,
      cpuThreads: 16,
      exists: (p) => files.includes(p),
      exec: async (file, args) => {
        execs.push([file, ...args]);
        return fixture('vulkan-integrated');
      },
      now: () => t,
      date: () => new Date('2026-10-18T12:00:00Z'),
      clean: async (text, chain) => {
        calls.push(`${chain}:${text}`);
        t += durations[chain].shift() ?? 0;
        return { text, steps: chain === 'emberon' ? [ok('emberon')] : [ok('gemma'), ok('emberon')] };
      },
    };
    return { opts, calls, execs };
  }

  it('lists devices, times one cold and three warm Emberon cleanups, and chooses from the warm median', async () => {
    const { opts, calls, execs } = rig({ emberon: [5000, 450, 380, 400] });
    const r = await runHardwareCheck(opts);
    expect(execs).toEqual([['llama-server', '--list-devices']]);
    expect(calls).toEqual(Array(4).fill('emberon:so um the sample'));
    expect(r).toEqual({
      devices: [IGPU],
      totalRamBytes: 32 * GB,
      cpuThreads: 16,
      emberonMs: 400,
      gemmaChainMs: null,
      choice: chooseChain({ totalRamBytes: 32 * GB, cpuThreads: 16, devices: [IGPU], emberonMs: 400 }),
      measuredAt: '2026-10-18T12:00:00.000Z',
    });
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  it('measures Gemma → Emberon only when asked and the Gemma file exists', async () => {
    const asked = rig({ emberon: [5000, 400, 400, 400], 'gemma-emberon': [9000, 800, 900, 700] });
    const r = await runHardwareCheck({ ...asked.opts, measureGemma: true });
    expect(r.gemmaChainMs).toBe(800);
    expect(r.choice.chain).toBe('gemma-emberon');
    const missing = rig({ emberon: [5000, 400, 400, 400] }, ['llama-server', path.join('models', EMBERON_GGUF)]);
    expect((await runHardwareCheck({ ...missing.opts, measureGemma: true })).gemmaChainMs).toBeNull();
    expect(missing.calls.every((c) => c.startsWith('emberon:'))).toBe(true);
  });

  it('carries on without devices when --list-devices fails', async () => {
    const { opts } = rig({ emberon: [1, 1, 1, 1] });
    const r = await runHardwareCheck({ ...opts, exec: () => Promise.reject(new Error('ENOENT')) });
    expect(r.devices).toEqual([]);
    expect(r.choice.gpuLayers).toBe(0);
  });

  it('turns cleanup off with a reason when Emberon is missing or a cleanup fails', async () => {
    const missing = rig({}, ['llama-server']);
    const r = await runHardwareCheck(missing.opts);
    expect(missing.calls).toEqual([]);
    expect(r.emberonMs).toBeNull();
    expect(r.choice.chain).toBe('off');
    expect(r.choice.summary).toContain("Couldn't measure cleanup (Emberon is not downloaded)");

    const { opts } = rig({});
    const skipped = await runHardwareCheck({ ...opts, clean: async (text) => ({ text, steps: [{ model: 'emberon', status: 'skipped', ms: 0, reason: 'not running' }] }) });
    expect(skipped.choice.summary).toContain("Couldn't measure cleanup (emberon skipped: not running)");
    const thrown = await runHardwareCheck({ ...opts, clean: () => Promise.reject(new Error('boom')) });
    expect(thrown.choice.summary).toContain("Couldn't measure cleanup (boom)");
  });

  it('counts a timed-out cleanup as slow, not as a failed measurement', async () => {
    const { opts } = rig({ emberon: [3000, 3000, 3000, 3000] });
    const clean: HardwareCheckOptions['clean'] = async (text, chain) => {
      await opts.clean(text, chain);
      return { text, steps: [{ model: 'emberon', status: 'timeout', ms: 3000 }] };
    };
    const r = await runHardwareCheck({ ...opts, clean });
    expect(r.emberonMs).toBe(3000);
    expect(r.choice.summary).toBe('Cleanup was too slow here (3.0 s), so dictate types the raw transcript.');
  });
});
