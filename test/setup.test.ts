import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EMBERON_GGUF, GEMMA_GGUF, STT_MODEL } from '../src/core/settings';
import { SPEECH_FILES } from '../src/main/downloads';
import {
  archiveTar, assetsFor, downloadAssets, type DownloadProgress, downloadVerified, type DownloadAsset, essentialsInstalled,
  installCleanupRuntime, llamaAssetFor, remainingBytes, SetupManager,
} from '../src/main/setup';
import { serve } from './download-server';

const temporary: string[] = [];
afterEach(() => { for (const p of temporary.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });

async function downloadCase(bytes: string, mutate: Partial<DownloadAsset> = {}) {
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-length': Buffer.byteLength(bytes) }); res.end(bytes); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dictate-setup-'));
  temporary.push(dir);
  const asset = { name: 'test.bin', url: `http://127.0.0.1:${port}/model`, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: Buffer.byteLength(bytes), ...mutate };
  return { server, dir, asset, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('verified model setup', () => {
  // The Unix llama archives contain shared-library symlinks; the Windows ZIP contains real DLLs.
  it.runIf(process.platform !== 'win32')('repairs dangling destination library links without following them outside the owned runtime', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dictate-runtime-repair-'));
    temporary.push(root);
    const source = path.join(root, 'source');
    const bin = path.join(root, 'bin');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(source); fs.mkdirSync(bin); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(source, 'llama-server'), 'new server');
    fs.writeFileSync(path.join(source, 'libllama.so.0'), 'new library');
    fs.symlinkSync('libllama.so.0', path.join(source, 'libllama.so'));
    fs.symlinkSync(path.join(root, '.setup-deleted', 'libllama.so'), path.join(bin, 'libllama.so'));
    fs.writeFileSync(path.join(outside, 'sentinel'), 'keep outside');
    fs.symlinkSync(outside, path.join(bin, 'old-libraries'));
    await installCleanupRuntime(source, bin);
    fs.rmSync(source, { recursive: true });
    expect(fs.lstatSync(path.join(bin, 'libllama.so')).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(bin, 'libllama.so'), 'utf8')).toBe('new library');
    expect(fs.readFileSync(path.join(bin, 'llama-server'), 'utf8')).toBe('new server');
    expect(fs.readdirSync(outside)).toEqual(['sentinel']);
    expect(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8')).toBe('keep outside');
  });

  it('preserves the prior usable runtime when preparing a replacement fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dictate-runtime-failure-'));
    temporary.push(root);
    const bin = path.join(root, 'bin');
    const source = path.join(root, 'source');
    const executable = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    fs.mkdirSync(bin); fs.mkdirSync(source);
    fs.writeFileSync(path.join(bin, executable), 'prior server');
    fs.writeFileSync(path.join(bin, 'library'), 'prior library');
    // Copying this incomplete replacement succeeds; executable validation must fail before promotion.
    fs.writeFileSync(path.join(source, 'library'), 'replacement library');
    await expect(installCleanupRuntime(source, bin)).rejects.toThrow();
    expect(fs.readFileSync(path.join(bin, executable), 'utf8')).toBe('prior server');
    expect(fs.readFileSync(path.join(bin, 'library'), 'utf8')).toBe('prior library');
    expect(fs.readdirSync(root).sort()).toEqual(['bin', 'source']);
  });

  it('rejects a destination directory symlink without changing its target', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dictate-runtime-link-'));
    temporary.push(root);
    const source = path.join(root, 'source');
    const outside = path.join(root, 'outside');
    const bin = path.join(root, 'bin');
    const executable = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    fs.mkdirSync(source); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(source, executable), 'new server');
    fs.writeFileSync(path.join(outside, executable), 'outside server');
    fs.symlinkSync(outside, bin, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(installCleanupRuntime(source, bin)).rejects.toThrow(/real directory/i);
    expect(fs.readFileSync(path.join(outside, executable), 'utf8')).toBe('outside server');
    expect(fs.lstatSync(bin).isSymbolicLink()).toBe(true);
  });

  it('uses native Windows bsdtar even when a GNU tar appears earlier in Git Bash PATH', () => {
    expect(archiveTar('win32', { SystemRoot: 'C:\\Windows', PATH: 'C:\\Program Files\\Git\\usr\\bin' })).toBe('C:\\Windows\\System32\\tar.exe');
    expect(archiveTar('linux', { SystemRoot: 'C:\\Windows' })).toBe('tar');
    expect(() => archiveTar('win32', {})).toThrow(/SystemRoot/);
  });
  it('installs exactly the pinned bytes with progress and no partial file left over', async () => {
    const c = await downloadCase('known model bytes');
    const seen: number[] = [];
    try {
      const file = await downloadVerified(c.asset, c.dir, (bytes) => seen.push(bytes));
      expect(fs.readFileSync(file, 'utf8')).toBe('known model bytes');
      expect(seen.at(-1)).toBe(17);
      expect(fs.readdirSync(c.dir)).toEqual(['test.bin']);
    } finally { await c.close(); }
  });

  it('rejects corrupt downloads and preserves an existing file', async () => {
    const c = await downloadCase('corrupted bytes', { sha256: '0'.repeat(64) });
    fs.writeFileSync(path.join(c.dir, 'test.bin'), 'prior verified model');
    try {
      await expect(downloadVerified(c.asset, c.dir, () => undefined)).rejects.toThrow(/checksum/i);
      expect(fs.readFileSync(path.join(c.dir, 'test.bin'), 'utf8')).toBe('prior verified model');
      expect(fs.readdirSync(c.dir)).toEqual(['test.bin']);
    } finally { await c.close(); }
  });

  it('selects portable CPU binaries on Windows/Linux and Metal builds on Mac', () => {
    expect(llamaAssetFor('win32', 'x64').name).toBe('llama-b11700-bin-win-cpu-x64.zip');
    expect(llamaAssetFor('darwin', 'arm64').name).toBe('llama-b11700-bin-macos-arm64.tar.gz');
    expect(llamaAssetFor('linux', 'x64').name).toBe('llama-b11700-bin-ubuntu-x64.tar.gz');
    expect(() => llamaAssetFor('freebsd', 'x64')).toThrow(/unsupported/i);
  });
});

function tempDir(prefix = 'dictate-dl-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const bytesOf = (n: number, seed = 1) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed) % 251));
const assetOf = (url: string, name: string, body: Buffer): DownloadAsset => ({ name, url: `${url}/${name}`, bytes: body.length, sha256: sha(body) });
const sized = (file: string, bytes: number) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ''); fs.truncateSync(file, bytes); };

describe('resumable downloads', () => {
  it('resumes from the stable .part file with a Range request and verifies the whole file', async () => {
    const body = bytesOf(1000);
    const s = await serve({ 'test.bin': body });
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, '.test.bin.part'), body.subarray(0, 400));
    const seen: number[] = [];
    try {
      const file = await downloadVerified(assetOf(s.url, 'test.bin', body), dir, (n) => seen.push(n));
      expect(s.requests.map((r) => r.range)).toEqual(['bytes=400-']);
      expect(seen[0]).toBe(400);
      expect(seen.at(-1)).toBe(1000);
      expect(fs.readFileSync(file).equals(body)).toBe(true);
      expect(fs.readdirSync(dir)).toEqual(['test.bin']);
    } finally { await s.close(); }
  });

  it('starts over when the server ignores Range', async () => {
    const body = bytesOf(1000);
    const s = await serve({ 'test.bin': body }, ['ignore-range']);
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, '.test.bin.part'), body.subarray(0, 400));
    try {
      const file = await downloadVerified(assetOf(s.url, 'test.bin', body), dir, () => undefined);
      expect(s.requests[0].range).toBe('bytes=400-');
      expect(fs.readFileSync(file).equals(body)).toBe(true);
    } finally { await s.close(); }
  });

  it('deletes a resumed .part whose bytes fail the SHA-256 check', async () => {
    const body = bytesOf(1000);
    const s = await serve({ 'test.bin': body });
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, '.test.bin.part'), bytesOf(400, 7));
    try {
      await expect(downloadVerified(assetOf(s.url, 'test.bin', body), dir, () => undefined)).rejects.toThrow(/checksum mismatch for test\.bin/i);
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally { await s.close(); }
  });

  it('keeps the .part when cancelled so the next attempt resumes', async () => {
    const body = bytesOf(1000);
    const s = await serve({ 'test.bin': body }, [{ hang: 300 }, 'range']);
    const dir = tempDir();
    const abort = new AbortController();
    try {
      await expect(downloadVerified(assetOf(s.url, 'test.bin', body), dir, (n) => { if (n >= 300) abort.abort(); }, abort.signal)).rejects.toThrow();
      expect(fs.statSync(path.join(dir, '.test.bin.part')).size).toBe(300);
      await downloadVerified(assetOf(s.url, 'test.bin', body), dir, () => undefined);
      expect(s.requests[1].range).toBe('bytes=300-');
      expect(fs.readFileSync(path.join(dir, 'test.bin')).equals(body)).toBe(true);
    } finally { await s.close(); }
  });

  it('retries once after a dropped connection, resuming where it stopped', async () => {
    const body = bytesOf(1000);
    const s = await serve({ 'test.bin': body }, [{ cut: 400 }, 'range']);
    const dir = tempDir();
    try {
      const file = await downloadVerified(assetOf(s.url, 'test.bin', body), dir, () => undefined, undefined, { retryDelayMs: 10 });
      expect(s.requests.map((r) => r.range)).toEqual([undefined, 'bytes=400-']);
      expect(fs.readFileSync(file).equals(body)).toBe(true);
    } finally { await s.close(); }
  });

  it('retries once after a server error', async () => {
    const body = bytesOf(1000);
    const s = await serve({ 'test.bin': body }, [{ status: 503 }, 'range']);
    const dir = tempDir();
    try {
      await downloadVerified(assetOf(s.url, 'test.bin', body), dir, () => undefined, undefined, { retryDelayMs: 10 });
      expect(s.requests).toHaveLength(2);
    } finally { await s.close(); }
  });

  it('names the file and how far it got after the retry also fails, and keeps the .part', async () => {
    const body = bytesOf(1000);
    const s = await serve({ 'test.bin': body }, [{ cut: 410 }, { cut: 0 }]);
    const dir = tempDir();
    try {
      await expect(downloadVerified(assetOf(s.url, 'test.bin', body), dir, () => undefined, undefined, { retryDelayMs: 10 }))
        .rejects.toThrow("Couldn't download test.bin: connection lost at 41%. Retry to resume.");
      expect(s.requests).toHaveLength(2);
      expect(fs.statSync(path.join(dir, '.test.bin.part')).size).toBe(410);
    } finally { await s.close(); }
  });
});

describe('install downloads', () => {
  it('checks free disk space before fetching any byte', async () => {
    const a = bytesOf(1000);
    const s = await serve({ 'a.bin': a });
    const dir = tempDir();
    try {
      const run = downloadAssets([{ asset: assetOf(s.url, 'a.bin', a), dir }], () => undefined, { freeBytes: async () => 500 });
      await expect(run).rejects.toMatchObject({ code: 'ENOSPC_PRECHECK' });
      await expect(run).rejects.toThrow(/^Not enough disk space: 0\.0 GB needed, 0\.0 GB free on .+\.$/);
      expect(s.requests).toHaveLength(0);
    } finally { await s.close(); }
  });

  it('reports overall progress across files and skips files already complete', async () => {
    const a = bytesOf(1000, 1);
    const b = bytesOf(2000, 2);
    const c = bytesOf(3000, 3);
    const s = await serve({ 'a.bin': a, 'b.bin': b, 'c.bin': c });
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'b.bin'), b);
    const seen: DownloadProgress[] = [];
    try {
      const items = [a, b, c].map((body, i) => ({ asset: assetOf(s.url, `${'abc'[i]}.bin`, body), dir }));
      await downloadAssets(items, (p) => seen.push(p), { freeBytes: async () => 1e12 });
      expect(s.requests.map((r) => r.path)).toEqual(['a.bin', 'c.bin']);
      expect(seen.every((p) => p.overallTotal === 6000 && p.steps === 3)).toBe(true);
      expect(seen.at(-1)).toMatchObject({ file: 'c.bin', step: 3, received: 3000, total: 3000, overallReceived: 6000 });
      expect(seen.find((p) => p.file === 'c.bin')?.overallReceived).toBeGreaterThanOrEqual(3000);
    } finally { await s.close(); }
  });

  it('measures speed from fetched bytes only, not bytes resumed from disk', async () => {
    const body = bytesOf(2_000_000);
    const s = await serve({ 'a.bin': body }, [{ chunks: 8, delayMs: 120 }]);
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, '.a.bin.part'), body.subarray(0, 1_992_000));
    const seen: DownloadProgress[] = [];
    try {
      await downloadAssets([{ asset: assetOf(s.url, 'a.bin', body), dir }], (p) => seen.push(p), { freeBytes: async () => 1e12 });
      const rates = seen.map((p) => p.bytesPerSecond).filter((r): r is number => r !== undefined);
      expect(rates.length).toBeGreaterThan(0);
      expect(Math.max(...rates)).toBeLessThan(200_000);
      expect(seen.some((p) => p.etaSeconds !== undefined && Number.isFinite(p.etaSeconds))).toBe(true);
    } finally { await s.close(); }
  });
});

describe('install stages', () => {
  it('sizes the essentials stage at about 0.7 GB: speech, Emberon and the llama.cpp runtime', () => {
    const assets = assetsFor('essentials', { platform: 'win32', arch: 'x64' });
    expect(assets.map((a) => a.name)).toEqual([`${STT_MODEL}.tar.bz2`, EMBERON_GGUF, 'llama-b11700-bin-win-cpu-x64.zip']);
    const total = assets.reduce((sum, a) => sum + a.bytes, 0);
    expect(total).toBeGreaterThan(0.6e9);
    expect(total).toBeLessThan(0.75e9);
  });

  it('downloads only the requested cleanup model when the runtime is installed', () => {
    const bin = tempDir();
    expect(assetsFor('cleanup', { platform: 'linux', arch: 'x64', cleanupModels: ['gemma'], binDir: bin }).map((a) => a.name))
      .toEqual([GEMMA_GGUF, 'llama-b11700-bin-ubuntu-x64.tar.gz']);
    fs.writeFileSync(path.join(bin, 'llama-server'), '');
    expect(assetsFor('cleanup', { platform: 'linux', arch: 'x64', cleanupModels: ['gemma'], binDir: bin }).map((a) => a.name)).toEqual([GEMMA_GGUF]);
    expect(assetsFor('cleanup', { platform: 'linux', arch: 'x64', cleanupModels: ['gemma'], binDir: bin, reinstallRuntime: true })).toHaveLength(2);
  });

  it('detects installed essentials and leaves complete files and partial bytes out of the remaining size', () => {
    const models = tempDir();
    const bin = tempDir();
    const options = { modelsDir: models, binDir: bin, platform: 'win32' as const, arch: 'x64' };
    const all = assetsFor('essentials', { platform: 'win32', arch: 'x64' }).reduce((sum, a) => sum + a.bytes, 0);
    expect(remainingBytes('essentials', options)).toBe(all);
    fs.writeFileSync(path.join(models, `.${EMBERON_GGUF}.part`), Buffer.alloc(1000));
    expect(remainingBytes('essentials', options)).toBe(all - 1000);
    sized(path.join(models, EMBERON_GGUF), 199996928);
    expect(assetsFor('essentials', options).map((a) => a.name)).not.toContain(EMBERON_GGUF);
    expect(essentialsInstalled(models, bin, 'win32')).toBe(false);
    for (const [file, bytes] of Object.entries(SPEECH_FILES)) sized(path.join(models, STT_MODEL, file), bytes);
    fs.writeFileSync(path.join(bin, 'llama-server.exe'), '');
    expect(essentialsInstalled(models, bin, 'win32')).toBe(true);
    expect(assetsFor('essentials', options)).toEqual([]);
    expect(remainingBytes('essentials', options)).toBe(0);
  });

  it('refuses to start an install without enough disk space', async () => {
    const setup = new SetupManager();
    const models = tempDir();
    await expect(setup.install('essentials', { modelsDir: models, binDir: path.join(models, 'bin'), platform: 'win32', arch: 'x64', freeBytes: async () => 400e6 }))
      .rejects.toThrow(/^Not enough disk space: \d+\.\d GB needed, 0\.4 GB free on /);
    expect(setup.state).toMatchObject({ phase: 'error', kind: 'essentials' });
    expect(fs.readdirSync(models).filter((f) => f.endsWith('.part'))).toEqual([]);
  });
});
