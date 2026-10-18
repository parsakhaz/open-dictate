// JSON files in the user-data folder, written atomically (temp file, then rename).
import fs from 'node:fs';
import path from 'node:path';

export function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
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
