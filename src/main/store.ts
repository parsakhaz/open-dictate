// JSON files in the user-data folder, written atomically (temp file, then rename).
import fs from 'node:fs';
import path from 'node:path';

/** File text without the UTF-8 BOM that Notepad and PowerShell write, which JSON.parse rejects. */
function readText(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
}

export function readJson(file: string): unknown {
  try {
    return JSON.parse(readText(file));
  } catch {
    return undefined;
  }
}

/**
 * Like readJson, for files the person may edit (settings, history). One that exists but cannot be parsed is
 * logged and copied to `<file>.bad` (never over an older copy), since the next save replaces it.
 */
export function loadJson(file: string, log: (level: 'warn', msg: string) => void): unknown {
  let text: string;
  try {
    text = readText(file);
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    let bad = `${file}.bad`;
    if (fs.existsSync(bad)) bad = `${file}.bad-${Date.now()}`;
    try {
      fs.copyFileSync(file, bad);
    } catch {
      bad = '(could not copy it)';
    }
    log('warn', `${file} is not valid JSON (${(err as Error).message}); using defaults, the file is kept as ${bad}`);
    return undefined;
  }
}

export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Coalesces bursts of saves (history edits, slider drags) into one write. */
export function debouncedWriter(file: string, get: () => unknown, ms = 300): { save: () => void; flush: () => void; now: () => void } {
  let t: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(t);
    t = undefined;
    writeJson(file, get());
  };
  return {
    save: () => {
      clearTimeout(t);
      t = setTimeout(flush, ms);
    },
    flush: () => {
      if (t) flush();
    },
    /** Writes at once, cancelling any pending write; throws if the write fails. */
    now: flush,
  };
}
