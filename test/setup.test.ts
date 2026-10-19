import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { downloadVerified, type DownloadAsset, llamaAssetFor } from '../src/main/setup';

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
