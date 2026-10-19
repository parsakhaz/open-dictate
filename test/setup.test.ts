import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { archiveTar, downloadVerified, type DownloadAsset, installCleanupRuntime, llamaAssetFor } from '../src/main/setup';

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
