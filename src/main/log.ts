// A plain append-only log file for diagnosis, rotated at 2 MB (one old file kept).
import fs from 'node:fs';
import path from 'node:path';

export type Level = 'info' | 'warn' | 'error';
export type Logger = (level: Level, msg: string) => void;

const MAX = 2 * 1024 * 1024;

export function fileLogger(file: string): Logger {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  return (level, msg) => {
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${msg}\n`;
    try {
      if (level === 'error') console.error(line.trimEnd());
      else console.log(line.trimEnd());
    } catch {
      // A launcher may close its output pipe while the installed app keeps running.
      // Preserve file logging even when mirroring to that pipe fails.
    }
    try {
      if (size > MAX) {
        fs.renameSync(file, `${file}.1`);
        size = 0;
      }
      fs.appendFileSync(file, line);
      size += Buffer.byteLength(line);
    } catch {
      // logging must never take the app down
    }
  };
}
