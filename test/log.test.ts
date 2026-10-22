import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { fileLogger } from '../src/main/log';

it('keeps logging to disk when a launcher output pipe is closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dictate-log-'));
  const file = path.join(dir, 'dictate.log');
  const broken = () => { throw Object.assign(new Error('broken pipe'), { code: 'EPIPE' }); };
  const stdout = vi.spyOn(console, 'log').mockImplementation(broken);
  const stderr = vi.spyOn(console, 'error').mockImplementation(broken);
  try {
    const log = fileLogger(file);
    expect(() => { log('info', 'startup'); log('error', 'diagnostic'); }).not.toThrow();
    expect(fs.readFileSync(file, 'utf8')).toContain('startup');
    expect(fs.readFileSync(file, 'utf8')).toContain('diagnostic');
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
