// The hardware check (D10): which GPUs llama-server sees, how fast Emberon cleans a sample here, and the
// default cleanup chain that follows from the measurement. Pure; the I/O lives in src/main/hardware.ts.
import type { CleanupChain } from './types';

export interface GpuDevice {
  /** llama.cpp's device name: Vulkan0, Metal, CUDA0 ... */
  id: string;
  name: string;
  backend: 'vulkan' | 'metal' | 'cuda' | 'other';
  memoryMiB: number;
  freeMiB: number;
  /** Shares system RAM (an iGPU or Apple silicon); a guess from the name. */
  integrated: boolean;
}

/** A chain is the default only if it cleans the ~5 s sample faster than this (warm median). */
export const EMBERON_BUDGET_MS = 1000;
export const GEMMA_CHAIN_BUDGET_MS = 1000;

const GB = 2 ** 30;

function backendOf(id: string): GpuDevice['backend'] {
  if (/^vulkan/i.test(id)) return 'vulkan';
  if (/^(metal|mtl)/i.test(id)) return 'metal';
  if (/^cuda/i.test(id)) return 'cuda';
  return 'other';
}

/** "Intel(R) Arc(TM) A770 Graphics" is a card; "Intel(R) Arc(TM) Graphics", UHD, Iris and Radeon ... Graphics are iGPUs. */
function integratedName(name: string): boolean {
  return /Apple|UHD|Iris|\bHD Graphics|Radeon.*Graphics|Arc\(TM\) Graphics/i.test(name);
}

/** Parses `llama-server --list-devices` (b11700): the indented lines after "Available devices:". */
export function parseListDevices(stdout: string): GpuDevice[] {
  const at = stdout.indexOf('Available devices:');
  if (at < 0) return [];
  const out: GpuDevice[] = [];
  for (const line of stdout.slice(at).split(/\r?\n/).slice(1)) {
    const m = /^\s+([^\s:]+):\s+(.+?)\s+\((\d+) MiB, (\d+) MiB free\)\s*$/.exec(line);
    // BLAS (Accelerate on a Mac) and similar CPU helpers list 0 MiB: they are not GPUs.
    if (!m || Number(m[3]) === 0) continue;
    out.push({ id: m[1], name: m[2], backend: backendOf(m[1]), memoryMiB: Number(m[3]), freeMiB: Number(m[4]), integrated: integratedName(m[2]) });
  }
  return out;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface HardwareInput {
  totalRamBytes: number;
  cpuThreads: number;
  devices: GpuDevice[];
  /** Warm median of Emberon on the sample; null = the measurement failed. */
  emberonMs: number | null;
  /** Warm median of Gemma → Emberon, when it was measured. */
  gemmaChainMs?: number | null;
  /** Why the Emberon measurement failed, for the summary. */
  failure?: string;
}

export interface HardwareChoice {
  chain: CleanupChain;
  /** Gemma is worth offering in Settings here. */
  offerGemma: boolean;
  /** llama-server -ngl. */
  gpuLayers: number;
  /** llama-server -t. */
  threads: number;
  /** One plain sentence for people. */
  summary: string;
}

export function chooseChain(input: HardwareInput): HardwareChoice {
  const { totalRamBytes: ram, devices, emberonMs, gemmaChainMs } = input;
  const chain: CleanupChain =
    gemmaChainMs != null && gemmaChainMs < GEMMA_CHAIN_BUDGET_MS ? 'gemma-emberon' : emberonMs != null && emberonMs < EMBERON_BUDGET_MS ? 'emberon' : 'off';
  const bigGpu = devices.some((d) => d.memoryMiB >= 4096);
  return {
    chain,
    offerGemma: ram >= 8 * GB && (bigGpu || ram >= 16 * GB),
    gpuLayers: devices.length ? 99 : 0,
    threads: Math.min(8, Math.max(1, Math.floor(input.cpuThreads / 2))),
    summary: summarize({ ...input, chain }),
  };
}

/** "AMD Radeon(TM) 8060S Graphics" → "AMD Radeon 8060S". */
function shortName(name: string): string {
  return name.replace(/\((TM|R)\)/gi, '').replace(/\s+Graphics$/i, '').replace(/\s+/g, ' ').trim();
}

const BACKEND = { vulkan: 'Vulkan', metal: 'Metal', cuda: 'CUDA', other: '' } as const;

export function summarize(input: Pick<HardwareInput, 'devices' | 'totalRamBytes' | 'emberonMs' | 'gemmaChainMs' | 'failure'> & { chain: CleanupChain }): string {
  const { chain, emberonMs, gemmaChainMs } = input;
  if (emberonMs == null) return `Couldn't measure cleanup (${input.failure ?? 'unknown error'}), so cleanup is off. You can turn it on in Settings → Cleanup.`;
  if (chain === 'off') return `Cleanup was too slow here (${(emberonMs / 1000).toFixed(1)} s), so dictate types the raw transcript.`;
  const ram = `${Math.round(input.totalRamBytes / GB)} GB RAM`;
  // A discrete card is the one that matters; among equals, the largest.
  const gpu = [...input.devices].sort((a, b) => Number(a.integrated) - Number(b.integrated) || b.memoryMiB - a.memoryMiB)[0];
  const pc = gpu ? `This computer: ${shortName(gpu.name)}${BACKEND[gpu.backend] ? ` (${BACKEND[gpu.backend]})` : ''}, ${ram}.` : `No GPU found, ${ram}.`;
  const [who, ms] = chain === 'gemma-emberon' && gemmaChainMs != null ? ['Gemma and Emberon', gemmaChainMs] : ['Emberon', emberonMs];
  return `${pc} ${who} cleaned the sample in ${(ms / 1000).toFixed(2)} s.`;
}
