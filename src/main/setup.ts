// First-run setup downloads only after an explicit button press. Nothing executes before a pinned digest passes.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { STT_MODEL } from '../core/settings';
import { CLEANUP_ASSETS, type DownloadAsset, LLAMA_ASSETS, SPEECH_ASSET, SPEECH_FILES } from './downloads';

export type { DownloadAsset } from './downloads';
const exec = promisify(execFile);
export type SetupKind = 'speech' | 'cleanup';
export interface SetupState {
  phase: 'idle' | 'downloading' | 'extracting' | 'ready' | 'error';
  kind?: SetupKind;
  file?: string;
  received?: number;
  total?: number;
  message?: string;
}

export function llamaAssetFor(platform: NodeJS.Platform, arch: string): DownloadAsset {
  const os = { win32: 'win-cpu', darwin: 'macos', linux: 'ubuntu' }[platform as 'win32' | 'darwin' | 'linux'];
  const asset = LLAMA_ASSETS.find((a) => a.name === `llama-b11700-bin-${os}-${arch}.${platform === 'win32' ? 'zip' : 'tar.gz'}`);
  if (!asset) throw new Error(`Unsupported cleanup runtime: ${platform}/${arch}`);
  return asset;
}

/** Downloads to a unique temporary sibling and swaps it in only after size and SHA-256 agree. */
export async function downloadVerified(asset: DownloadAsset, directory: string, progress: (bytes: number) => void, signal?: AbortSignal): Promise<string> {
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, asset.name);
  const part = path.join(directory, `.${asset.name}.${randomUUID()}.part`);
  const hash = createHash('sha256');
  let handle: fs.promises.FileHandle | undefined;
  try {
    const response = await fetch(asset.url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]) : AbortSignal.timeout(30 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status}) for ${asset.name}`);
    handle = await fs.promises.open(part, 'wx', 0o600);
    let received = 0;
    for await (const chunk of response.body) {
      signal?.throwIfAborted();
      received += chunk.byteLength;
      if (received > asset.bytes) throw new Error(`Download size exceeds expected ${asset.bytes} bytes for ${asset.name}`);
      hash.update(chunk);
      await handle.writeFile(chunk);
      progress(received);
    }
    if (received !== asset.bytes) throw new Error(`Incomplete download for ${asset.name}: ${received} of ${asset.bytes} bytes`);
    if (hash.digest('hex') !== asset.sha256) throw new Error(`SHA-256 checksum mismatch for ${asset.name}`);
    await handle.close();
    handle = undefined;
    await fs.promises.rename(part, target);
    return target;
  } finally {
    await handle?.close();
    await fs.promises.rm(part, { force: true });
  }
}

export function speechInstalled(modelsDir: string): boolean {
  try {
    return Object.entries(SPEECH_FILES).every(([file, bytes]) => fs.statSync(path.join(modelsDir, STT_MODEL, file)).size === bytes);
  } catch { return false; }
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

export class SetupManager {
  state: SetupState = { phase: 'idle' };
  private abort?: AbortController;
  onChange: () => void = () => undefined;

  private change(state: SetupState): void { this.state = state; this.onChange(); }
  cancel(): void { this.abort?.abort(); }

  async install(kind: SetupKind, options: { modelsDir: string; binDir: string; platform: NodeJS.Platform; arch: string }): Promise<void> {
    if (this.abort) throw new Error('A model download is already running');
    const abort = new AbortController();
    this.abort = abort;
    const temp = path.join(options.modelsDir, `.setup-${randomUUID()}`);
    try {
      fs.mkdirSync(temp, { recursive: true });
      const get = (asset: DownloadAsset, destination: string) => {
        let last = 0;
        this.change({ phase: 'downloading', kind, file: asset.name, received: 0, total: asset.bytes });
        return downloadVerified(asset, destination, (received) => {
          if (Date.now() - last > 300 || received === asset.bytes) {
            last = Date.now();
            this.change({ phase: 'downloading', kind, file: asset.name, received, total: asset.bytes });
          }
        }, abort.signal);
      };
      if (kind === 'speech') {
        if (!speechInstalled(options.modelsDir)) {
          const archive = await get(SPEECH_ASSET, temp);
          this.change({ phase: 'extracting', kind, file: SPEECH_ASSET.name });
          await extract(archive, temp, abort.signal);
          if (!speechInstalled(temp)) throw new Error('The speech archive did not contain the expected model files');
          const target = path.join(options.modelsDir, STT_MODEL);
          if (fs.existsSync(target)) await fs.promises.rm(target, { recursive: true });
          await fs.promises.rename(path.join(temp, STT_MODEL), target);
        }
      } else {
        for (const asset of CLEANUP_ASSETS) await get(asset, options.modelsDir);
        const asset = llamaAssetFor(options.platform, options.arch);
        const archive = await get(asset, temp);
        this.change({ phase: 'extracting', kind, file: asset.name });
        const unpacked = path.join(temp, 'llama');
        await extract(archive, unpacked, abort.signal);
        const exe = findExecutable(unpacked, options.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
        if (!exe) throw new Error('The llama.cpp archive did not contain llama-server');
        // Keep shared libraries adjacent to the executable (required by the upstream CPU/Metal builds).
        fs.mkdirSync(options.binDir, { recursive: true });
        await fs.promises.cp(path.dirname(exe), options.binDir, { recursive: true, force: true });
        if (options.platform !== 'win32') await fs.promises.chmod(path.join(options.binDir, 'llama-server'), 0o755);
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
