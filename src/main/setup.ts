// First-run setup downloads only after an explicit button press. Nothing executes before a pinned digest passes.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { CleanupModel } from '../core/chain';
import { EMBERON_GGUF, GEMMA_GGUF, STT_MODEL } from '../core/settings';
import { CLEANUP_ASSETS, type DownloadAsset, LLAMA_ASSETS, SPEECH_ASSET, SPEECH_FILES } from './downloads';

export type { DownloadAsset } from './downloads';
const exec = promisify(execFile);
/** `essentials` = speech + Emberon + llama.cpp runtime: stage 1, enough to dictate with cleanup. */
export type SetupKind = 'essentials' | 'speech' | 'cleanup';
export interface SetupOptions {
  modelsDir: string;
  binDir: string;
  platform: NodeJS.Platform;
  arch: string;
  /** Omit to install the full cleanup chain; callers needing one model can avoid the other download. */
  cleanupModels?: readonly CleanupModel[];
  /** Download llama.cpp again even when binDir already has llama-server, e.g. to repair it. */
  reinstallRuntime?: boolean;
  freeBytes?: (dir: string) => Promise<number>;
  retryDelayMs?: number;
}

export function cleanupAssetsFor(models: readonly CleanupModel[] = ['emberon', 'gemma']): DownloadAsset[] {
  if (!models.length) throw new Error('Select at least one cleanup model');
  const filenames = { emberon: EMBERON_GGUF, gemma: GEMMA_GGUF };
  const names = new Set(models.map((model) => {
    if (!Object.hasOwn(filenames, model)) throw new Error(`Unknown cleanup model: ${model}`);
    return filenames[model];
  }));
  return CLEANUP_ASSETS.filter((asset) => names.has(asset.name));
}

export interface SetupState {
  phase: 'idle' | 'downloading' | 'extracting' | 'ready' | 'error';
  kind?: SetupKind;
  file?: string;
  received?: number;
  total?: number;
  step?: number;
  steps?: number;
  overallReceived?: number;
  overallTotal?: number;
  bytesPerSecond?: number;
  etaSeconds?: number;
  message?: string;
}

export function llamaAssetFor(platform: NodeJS.Platform, arch: string): DownloadAsset {
  // Vulkan on Windows and Linux: AMD, Intel and NVIDIA, integrated GPUs too. Its CPU backends ship in the same archive
  // and llama.cpp falls back to them when Vulkan finds no device. Metal on Mac.
  const os = { win32: 'win-vulkan', darwin: 'macos', linux: 'ubuntu-vulkan' }[platform as 'win32' | 'darwin' | 'linux'];
  const asset = LLAMA_ASSETS.find((a) => a.name === `llama-b11700-bin-${os}-${arch}.${platform === 'win32' ? 'zip' : 'tar.gz'}`);
  if (!asset) throw new Error(`Unsupported cleanup runtime: ${platform}/${arch}`);
  return asset;
}

/** Network failures worth one more attempt; the message is the reason shown to the user. */
class Retryable extends Error {}
const lost = (error: unknown) => (error as Error).name === 'TimeoutError' ? 'the download timed out' : 'connection lost';
const partPath = (asset: DownloadAsset, directory: string) => path.join(directory, `.${asset.name}.part`);
const sizeOf = (file: string) => fs.promises.stat(file).then((s) => s.size, () => 0);

function rangeMatches(header: string | null, start: number, total: number): boolean {
  const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(header ?? '');
  return !!m && Number(m[1]) === start && Number(m[2]) === total - 1 && (m[3] === '*' || Number(m[3]) === total);
}

async function attempt(asset: DownloadAsset, directory: string, progress: (bytes: number) => void, signal?: AbortSignal): Promise<string> {
  const part = partPath(asset, directory);
  let existing = 0;
  const stat = await fs.promises.lstat(part).catch(() => undefined);
  if (stat && (!stat.isFile() || stat.size > asset.bytes)) await fs.promises.rm(part, { recursive: true, force: true });
  else if (stat) existing = stat.size;
  let response: Response | undefined;
  if (existing < asset.bytes) {
    const timeout = AbortSignal.timeout(30 * 60_000);
    response = await fetch(asset.url, { headers: existing ? { range: `bytes=${existing}-` } : undefined, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
      .catch((error) => { throw signal?.aborted ? error : new Retryable(lost(error), { cause: error }); });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      if (response.status === 416) await fs.promises.rm(part, { force: true });
      throw new Retryable(`the server answered HTTP ${response.status}`);
    }
    // A 200 means the server ignored Range: start over. A 206 must continue exactly where the .part ends.
    if (response.status !== 206) existing = 0;
    else if (!existing || !rangeMatches(response.headers.get('content-range'), existing, asset.bytes)) {
      await response.body.cancel();
      await fs.promises.rm(part, { force: true });
      throw new Retryable('the server sent an unexpected range');
    }
  }
  // SHA-256 covers the whole file, so resumed bytes are hashed again before new ones are appended.
  const hash = createHash('sha256');
  if (existing) for await (const chunk of fs.createReadStream(part, { end: existing - 1 })) hash.update(chunk);
  const handle = await fs.promises.open(part, existing ? 'a' : 'w', 0o600);
  let received = existing;
  let oversize = false;
  try {
    progress(received);
    const chunks = response?.body?.[Symbol.asyncIterator]();
    try {
      while (chunks) {
        const next = await chunks.next().catch((error) => { throw signal?.aborted ? error : new Retryable(lost(error), { cause: error }); });
        if (next.done) break;
        signal?.throwIfAborted();
        received += next.value.byteLength;
        if (received > asset.bytes) { oversize = true; break; }
        hash.update(next.value);
        await handle.write(next.value);
        progress(received);
      }
    } finally { await chunks?.return?.(); }
  } finally { await handle.close(); }
  if (oversize) {
    await fs.promises.rm(part, { force: true });
    throw new Error(`Download size exceeds expected ${asset.bytes} bytes for ${asset.name}; the partial download was deleted`);
  }
  if (received !== asset.bytes) throw new Retryable('connection lost');
  if (hash.digest('hex') !== asset.sha256) {
    await fs.promises.rm(part, { force: true });
    throw new Error(`SHA-256 checksum mismatch for ${asset.name}; the partial download was deleted`);
  }
  const target = path.join(directory, asset.name);
  await fs.promises.rename(part, target);
  return target;
}

export interface DownloadOptions { /** Wait before the single automatic retry; defaults to 2 s. */ retryDelayMs?: number }

/**
 * Downloads into a stable `.<name>.part` sibling and swaps it in only after size and SHA-256 agree.
 * An existing .part is resumed with Range. Cancellation and network errors keep it for the next attempt;
 * only a checksum or size mismatch deletes it. Network errors and non-2xx answers are retried once.
 */
export async function downloadVerified(asset: DownloadAsset, directory: string, progress: (bytes: number) => void, signal?: AbortSignal, options: DownloadOptions = {}): Promise<string> {
  fs.mkdirSync(directory, { recursive: true });
  for (let retried = false; ; retried = true) {
    try { return await attempt(asset, directory, progress, signal); }
    catch (error) {
      if (signal?.aborted || !(error instanceof Retryable)) throw error;
      if (retried) {
        const percent = Math.floor((await sizeOf(partPath(asset, directory))) * 100 / asset.bytes);
        throw new Error(`Couldn't download ${asset.name}: ${error.message} at ${percent}%. Retry to resume.`, { cause: error });
      }
      await sleep(options.retryDelayMs ?? 2000, undefined, { signal });
    }
  }
}

export class DiskSpaceError extends Error {
  readonly code = 'ENOSPC_PRECHECK';
  constructor(readonly needed: number, readonly free: number, readonly directory: string) {
    const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`;
    super(`Not enough disk space: ${gb(needed)} needed, ${gb(free)} free on ${directory}.`);
    this.name = 'DiskSpaceError';
  }
}

const SPEECH_UNPACKED = Object.values(SPEECH_FILES).reduce((sum, n) => sum + n, 0);
/** Room an archive needs while it is unpacked beside itself; GGUFs are used as downloaded. */
export function unpackedBytes(asset: DownloadAsset): number {
  if (asset.name === SPEECH_ASSET.name) return SPEECH_UNPACKED;
  return /\.(zip|tar\.gz)$/.test(asset.name) ? asset.bytes * 3 : 0;
}

export interface PlannedDownload { asset: DownloadAsset; dir: string }
export interface DownloadProgress {
  file: string;
  /** 1-based index of the file within the install. */
  step: number;
  steps: number;
  received: number;
  total: number;
  overallReceived: number;
  overallTotal: number;
  /** Smoothed over fetched bytes only; bytes resumed from disk count as received but not as speed. */
  bytesPerSecond?: number;
  etaSeconds?: number;
}
export interface DownloadAssetsOptions extends DownloadOptions {
  signal?: AbortSignal;
  /** Free bytes on the volume holding `dir`; injectable so tests can simulate a full disk. */
  freeBytes?: (dir: string) => Promise<number>;
}

const fileIs = (file: string, bytes: number) => { try { return fs.statSync(file).size === bytes; } catch { return false; } };
function remaining({ asset, dir }: PlannedDownload): number {
  if (fileIs(path.join(dir, asset.name), asset.bytes)) return 0;
  try { return Math.max(0, asset.bytes - fs.statSync(partPath(asset, dir)).size); } catch { return asset.bytes; }
}
async function statfsFree(dir: string): Promise<number> {
  const s = await fs.promises.statfs(dir);
  return s.bavail * s.bsize;
}

/** Exponential moving average over ~0.5 s windows of fetched bytes, about 2-3 s of memory. */
function rateMeter(now: () => number = Date.now) {
  let start: number | undefined;
  let base = 0;
  let rate: number | undefined;
  return (fetched: number) => {
    const t = now();
    if (start === undefined) { start = t; base = fetched; return rate; }
    const seconds = (t - start) / 1000;
    if (seconds >= 0.5) {
      const sample = (fetched - base) / seconds;
      rate = rate === undefined ? sample : rate + 0.3 * (sample - rate);
      start = t;
      base = fetched;
    }
    return rate;
  };
}

/**
 * Checks free space for every remaining byte (+10%, plus room to unpack archives) before fetching any,
 * then downloads in order. A final file with the exact byte count is trusted and skipped.
 */
export async function downloadAssets(items: readonly PlannedDownload[], report: (progress: DownloadProgress) => void, options: DownloadAssetsOptions = {}): Promise<string[]> {
  if (!items.length) return [];
  for (const dir of new Set(items.map((i) => i.dir))) await fs.promises.mkdir(dir, { recursive: true });
  const needed = Math.ceil(items.reduce((sum, i) => sum + remaining(i) * 1.1 + unpackedBytes(i.asset), 0));
  const free = await (options.freeBytes ?? statfsFree)(items[0].dir);
  // Archives stage in a hidden .downloads folder; people know the models folder above it.
  if (needed > free) throw new DiskSpaceError(needed, free, path.basename(items[0].dir) === '.downloads' ? path.dirname(items[0].dir) : items[0].dir);
  const overallTotal = items.reduce((sum, i) => sum + i.asset.bytes, 0);
  const meter = rateMeter();
  let done = 0;
  let fetched = 0;
  const files: string[] = [];
  for (const [index, { asset, dir }] of items.entries()) {
    let last = Number.NEGATIVE_INFINITY;
    let previous: number | undefined;
    const progress = (received: number) => {
      if (previous !== undefined && received > previous) fetched += received - previous;
      previous = received;
      const bytesPerSecond = meter(fetched);
      if (Date.now() - last < 250 && received !== asset.bytes) return;
      last = Date.now();
      const overallReceived = done + received;
      report({
        file: asset.name, step: index + 1, steps: items.length, received, total: asset.bytes, overallReceived, overallTotal, bytesPerSecond,
        etaSeconds: bytesPerSecond ? (overallTotal - overallReceived) / bytesPerSecond : undefined,
      });
    };
    const target = path.join(dir, asset.name);
    if (fileIs(target, asset.bytes)) { files.push(target); progress(asset.bytes); }
    else files.push(await downloadVerified(asset, dir, progress, options.signal, options));
    done += asset.bytes;
  }
  return files;
}

export function speechInstalled(modelsDir: string): boolean {
  try {
    return Object.entries(SPEECH_FILES).every(([file, bytes]) => fs.statSync(path.join(modelsDir, STT_MODEL, file)).size === bytes);
  } catch { return false; }
}

const serverName = (platform: NodeJS.Platform) => platform === 'win32' ? 'llama-server.exe' : 'llama-server';
/** The GPU backend the pinned build loads beside llama-server; an earlier CPU-only download lacks it and is replaced. */
const GPU_BACKEND: Partial<Record<NodeJS.Platform, string>> = { win32: 'ggml-vulkan.dll', linux: 'libggml-vulkan.so' };

export function runtimeInstalled(binDir: string, platform: NodeJS.Platform): boolean {
  const isFile = (name: string) => { try { return fs.statSync(path.join(binDir, name)).isFile(); } catch { return false; } };
  const backend = GPU_BACKEND[platform];
  return isFile(serverName(platform)) && (!backend || isFile(backend));
}

/** Stage 1: enough to dictate with cleanup. */
export function essentialsInstalled(modelsDir: string, binDir: string, platform: NodeJS.Platform): boolean {
  return speechInstalled(modelsDir) && fileIs(path.join(modelsDir, EMBERON_GGUF), CLEANUP_ASSETS.find((a) => a.name === EMBERON_GGUF)!.bytes) && runtimeInstalled(binDir, platform);
}

export interface AssetOptions {
  platform: NodeJS.Platform;
  arch: string;
  cleanupModels?: readonly CleanupModel[];
  /** When given, models already installed here are left out. */
  modelsDir?: string;
  /** When given, an installed llama-server here is kept instead of downloaded again. */
  binDir?: string;
  reinstallRuntime?: boolean;
}

/** What an install of `kind` downloads, with sizes, so the UI can show the total before starting. */
export function assetsFor(kind: SetupKind, options: AssetOptions): DownloadAsset[] {
  const { modelsDir, binDir } = options;
  const speech = kind !== 'cleanup' && !(modelsDir && speechInstalled(modelsDir)) ? [SPEECH_ASSET] : [];
  if (kind === 'speech') return speech;
  const models = cleanupAssetsFor(kind === 'essentials' ? ['emberon'] : options.cleanupModels)
    .filter((asset) => !(modelsDir && fileIs(path.join(modelsDir, asset.name), asset.bytes)));
  const runtime = options.reinstallRuntime || !(binDir && runtimeInstalled(binDir, options.platform)) ? [llamaAssetFor(options.platform, options.arch)] : [];
  return [...speech, ...models, ...runtime];
}

// Archives wait in a stable folder so an interrupted download resumes; GGUFs download beside their final name.
function planFor(kind: SetupKind, options: AssetOptions & { modelsDir: string }): PlannedDownload[] {
  return assetsFor(kind, options).map((asset) => ({ asset, dir: asset.name.endsWith('.gguf') ? options.modelsDir : path.join(options.modelsDir, '.downloads') }));
}

/** Bytes still to fetch for `kind`, net of complete files and resumable .part files. */
export function remainingBytes(kind: SetupKind, options: AssetOptions & { modelsDir: string }): number {
  return planFor(kind, options).reduce((sum, item) => sum + remaining(item), 0);
}

export function archiveTar(platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env): string {
  if (platform !== 'win32') return 'tar';
  // Git Bash can put GNU tar first in PATH, where D:\\file is parsed as a remote host. Native bsdtar also
  // handles the llama.cpp ZIP archives, and is installed with supported Windows versions.
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || env.windir || env.WINDIR;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new Error('SystemRoot must identify the native Windows directory to extract model archives');
  return path.win32.join(systemRoot, 'System32', 'tar.exe');
}

async function extract(archive: string, directory: string, signal?: AbortSignal): Promise<void> {
  fs.mkdirSync(directory, { recursive: true });
  // Windows 10+, macOS and supported Linux distributions ship tar; argv never goes through a shell.
  await exec(archiveTar(), ['--no-same-owner', '-xf', archive, '-C', directory], { timeout: 5 * 60_000, signal, windowsHide: true });
}

function findExecutable(directory: string, name: string): string | undefined {
  for (const f of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, f.name);
    if (f.isFile() && f.name === name) return full;
    if (f.isDirectory()) { const found = findExecutable(full, name); if (found) return found; }
  }
  return undefined;
}

export async function installCleanupRuntime(source: string, binDir: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const target = path.resolve(binDir);
  const parent = path.dirname(target);
  await fs.promises.mkdir(parent, { recursive: true });
  const staged = await fs.promises.mkdtemp(path.join(parent, '.dictate-runtime-'));
  const backup = path.join(parent, `.dictate-runtime-previous-${randomUUID()}`);
  let previousMoved = false;
  let installed = false;
  try {
    // Materialize upstream library links before touching the installed runtime. Copying directly
    // over an old dangling link follows that destination and fails after the temporary source is gone.
    await fs.promises.cp(source, staged, { recursive: true, force: true, dereference: true });
    const executable = path.join(staged, platform === 'win32' ? 'llama-server.exe' : 'llama-server');
    if (!(await fs.promises.stat(executable)).isFile()) throw new Error('The replacement cleanup runtime has no server executable');
    if (platform !== 'win32') await fs.promises.chmod(executable, 0o755);
    const previous = await fs.promises.lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (previous && (!previous.isDirectory() || previous.isSymbolicLink())) throw new Error('The cleanup runtime destination must be a real directory');
    if (previous) { await fs.promises.rename(target, backup); previousMoved = true; }
    try {
      await fs.promises.rename(staged, target);
      installed = true;
    } catch (error) {
      if (previousMoved) {
        try { await fs.promises.rename(backup, target); previousMoved = false; }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], `Cleanup runtime replacement failed; the previous runtime remains at ${backup}`); }
      }
      throw error;
    }
  } finally {
    await fs.promises.rm(staged, { recursive: true, force: true });
    // Removing the renamed directory unlinks stale destination links without traversing their targets.
    if (installed && previousMoved) await fs.promises.rm(backup, { recursive: true, force: true });
  }
}

export class SetupManager {
  state: SetupState = { phase: 'idle' };
  private abort?: AbortController;
  onChange: () => void = () => undefined;

  private change(state: SetupState): void { this.state = state; this.onChange(); }
  cancel(): void { this.abort?.abort(); }

  async install(kind: SetupKind, options: SetupOptions): Promise<void> {
    if (this.abort) throw new Error('A model download is already running');
    const abort = new AbortController();
    this.abort = abort;
    const temp = path.join(options.modelsDir, `.setup-${randomUUID()}`);
    try {
      const items = planFor(kind, options);
      const files = await downloadAssets(items, (progress) => this.change({ phase: 'downloading', kind, ...progress }), {
        signal: abort.signal, freeBytes: options.freeBytes, retryDelayMs: options.retryDelayMs,
      });
      for (const [index, { asset }] of items.entries()) {
        if (asset.name.endsWith('.gguf')) continue;
        this.change({ phase: 'extracting', kind, file: asset.name });
        const unpacked = path.join(temp, String(index));
        await extract(files[index], unpacked, abort.signal);
        if (asset === SPEECH_ASSET) {
          if (!speechInstalled(unpacked)) throw new Error('The speech archive did not contain the expected model files');
          const target = path.join(options.modelsDir, STT_MODEL);
          if (fs.existsSync(target)) await fs.promises.rm(target, { recursive: true });
          await fs.promises.rename(path.join(unpacked, STT_MODEL), target);
        } else {
          const exe = findExecutable(unpacked, serverName(options.platform));
          if (!exe) throw new Error('The llama.cpp archive did not contain llama-server');
          await installCleanupRuntime(path.dirname(exe), options.binDir, options.platform);
        }
        // Kept until installed so a failed extraction does not cost the download again.
        await fs.promises.rm(files[index], { force: true });
      }
      this.change({ phase: 'ready', kind });
    } catch (err) {
      this.change({ phase: 'error', kind, message: abort.signal.aborted ? 'Download cancelled. You can retry.' : (err as Error).message });
      throw err;
    } finally {
      this.abort = undefined;
      await fs.promises.rm(temp, { recursive: true, force: true });
    }
  }
}
