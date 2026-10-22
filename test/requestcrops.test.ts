import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { RequestCrops } from '../src/main/requestcrops';

it('bounds owned crops, retains only its own files, and extends retention when an answer completes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dictate-crops-'));
  let now = 1000;
  try {
    const store = new RequestCrops(dir, () => now, {
      each: 4,
      total: 6,
      keep: 100,
    });
    fs.writeFileSync(path.join(dir, 'caller.png'), 'keep');
    const first = store.save('k1', Buffer.from('1234'))!;
    expect(fs.readFileSync(first, 'utf8')).toBe('1234');
    expect(store.save('k2', Buffer.from('1234'))).toBeNull();
    expect(store.save('k2', Buffer.from('12345'))).toBeNull();
    now = 1050;
    store.completed('k1');
    now = 1110;
    store.sweep();
    expect(fs.existsSync(first)).toBe(true);
    now = 1151;
    store.sweep();
    expect(fs.existsSync(first)).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'caller.png'), 'utf8')).toBe('keep');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('reports an unavailable cache without breaking application startup or changing the caller file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dictate-crop-unavailable-'));
  const file = path.join(dir, 'not-a-directory');
  try {
    fs.writeFileSync(file, 'caller');
    const store = new RequestCrops(file);
    expect(store.save('card', Buffer.from('png'))).toBeNull();
    expect(fs.readFileSync(file, 'utf8')).toBe('caller');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
