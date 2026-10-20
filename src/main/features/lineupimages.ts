// Lineup's images, read by main and handed to its pages as image data: only files inside the calling session's
// working folder or the temp folder (after following links), only PNG, JPEG, WebP, GIF or SVG by their bytes, at
// most 10 MB each. An SVG is only ever shown as an <img>, so its scripts never run. No Electron, for the tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolInputError } from '../../core/agenttools';
import { LINEUP } from '../../core/tools/lineup';

export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/svg+xml';

export interface LoadedImage {
  type: ImageType;
  bytes: Buffer;
}

/** The type the file's first bytes say it is, or null. */
export function sniff(b: Buffer): ImageType | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  // SVG is text: an <svg element near the start, after any XML declaration, doctype or comments.
  const head = b.subarray(0, 4096).toString('utf8').replace(/^﻿/, '');
  if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

/** `file` is `root` or inside it (both already real paths). */
export function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function real(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/** The folders a session's images may come from: its working folder and the temp folder. */
export function imageRoots(cwd: string): string[] {
  return [cwd, os.tmpdir()].filter((p) => p && path.isAbsolute(p)).map(real).filter((p): p is string => !!p);
}

/** Reads one candidate's image, or throws a ToolInputError that says why it was refused. `n` is its place, from 1. */
export function loadImage(image: string, cwd: string, n: number, roots = imageRoots(cwd)): LoadedImage {
  const name = path.basename(image);
  const asked = path.isAbsolute(image) ? image : cwd ? path.resolve(cwd, image) : null;
  const file = asked && real(asked);
  if (!file) throw new ToolInputError(`candidate ${n}: can't find ${name}`);
  if (!roots.some((r) => inside(r, file))) throw new ToolInputError(`candidate ${n}: ${name} is outside your working folder and the temp folder`);
  const st = fs.statSync(file);
  if (!st.isFile()) throw new ToolInputError(`candidate ${n}: ${name} isn't a file`);
  if (st.size > LINEUP.imageBytes) throw new ToolInputError(`candidate ${n}: ${name} is over 10 MB`);
  const bytes = fs.readFileSync(file);
  if (bytes.length > LINEUP.imageBytes) throw new ToolInputError(`candidate ${n}: ${name} is over 10 MB`);
  const type = sniff(bytes);
  if (!type) throw new ToolInputError(`candidate ${n}: ${name} isn't a PNG, JPEG, WebP, GIF or SVG`);
  return { type, bytes };
}

export const dataUrl = (img: LoadedImage) => `data:${img.type};base64,${img.bytes.toString('base64')}`;
