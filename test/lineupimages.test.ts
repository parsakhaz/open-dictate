import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { imageRoots, inside, loadImage, sniff } from '../src/main/features/lineupimages';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lineup-'));
const work = path.join(base, 'work');
const elsewhere = path.join(base, 'elsewhere');
fs.mkdirSync(path.join(work, 'mockups'), { recursive: true });
fs.mkdirSync(elsewhere);
const put = (p: string, b: Buffer | string) => {
  fs.writeFileSync(p, b);
  return p;
};
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

describe('lineup images', () => {
  const roots = [fs.realpathSync.native(work)];

  it('tells image types by their bytes', () => {
    expect(sniff(PNG)).toBe('image/png');
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniff(Buffer.from('GIF89a....'))).toBe('image/gif');
    expect(sniff(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniff(Buffer.from('<?xml version="1.0"?>\n<!-- x -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('image/svg+xml');
    expect(sniff(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(sniff(Buffer.from('MZ\x90\0'))).toBeNull();
  });

  it('reads an image inside the working folder, by absolute or relative path', () => {
    put(path.join(work, 'mockups', 'a.png'), PNG);
    expect(loadImage(path.join(work, 'mockups', 'a.png'), work, 1, roots).type).toBe('image/png');
    expect(loadImage('mockups/a.png', work, 1, roots).bytes.equals(PNG)).toBe(true);
  });

  it('refuses a file outside the folders, also through ..', () => {
    const out = put(path.join(elsewhere, 'b.png'), PNG);
    expect(() => loadImage(out, work, 2, roots)).toThrow(/candidate 2: b\.png is outside/);
    expect(() => loadImage('../elsewhere/b.png', work, 2, roots)).toThrow(/outside/);
  });

  it('refuses a link inside the folder that points outside it', () => {
    const out = put(path.join(elsewhere, 'c.png'), PNG);
    const link = path.join(work, 'c-link.png');
    try {
      fs.symlinkSync(out, link);
    } catch {
      return; // Windows without the right to make links: nothing to test.
    }
    expect(() => loadImage(link, work, 3, roots)).toThrow(/outside/);
  });

  it('refuses a missing file, a folder, a file over 10 MB and a file that is not an image', () => {
    expect(() => loadImage(path.join(work, 'nope.png'), work, 1, roots)).toThrow(/can't find nope\.png/);
    expect(() => loadImage(path.join(work, 'mockups'), work, 1, roots)).toThrow(/isn't a file/);
    const big = path.join(work, 'big.png');
    fs.writeFileSync(big, PNG);
    fs.truncateSync(big, 10 * 1024 * 1024 + 1);
    expect(() => loadImage(big, work, 1, roots)).toThrow(/over 10 MB/);
    put(path.join(work, 'page.png'), '<html><script>alert(1)</script></html>');
    expect(() => loadImage(path.join(work, 'page.png'), work, 1, roots)).toThrow(/isn't a PNG, JPEG, WebP, GIF or SVG/);
  });

  it('a file exactly at 10 MB is fine', () => {
    const edge = path.join(work, 'edge.png');
    fs.writeFileSync(edge, PNG);
    fs.truncateSync(edge, 10 * 1024 * 1024);
    expect(loadImage(edge, work, 1, roots).type).toBe('image/png');
  });

  it('the roots are the working folder and the temp folder; a relative or empty working folder adds nothing', () => {
    expect(imageRoots(work)).toEqual([fs.realpathSync.native(work), fs.realpathSync.native(os.tmpdir())]);
    expect(imageRoots('')).toEqual([fs.realpathSync.native(os.tmpdir())]);
    expect(imageRoots('relative')).toEqual([fs.realpathSync.native(os.tmpdir())]);
  });

  it('inside: the folder itself and its siblings with a shared prefix are not inside', () => {
    expect(inside(work, work)).toBe(false);
    expect(inside(work, `${work}2${path.sep}a.png`)).toBe(false);
    expect(inside(work, path.join(work, 'a', 'b.png'))).toBe(true);
  });
});
