// Only CLI-generated files in a dedicated cache; caller assets are never removed.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REQUEST_LIMITS } from '../core/requests';

export class RequestCrops {
  private owned = new Map<string, { card: string; size: number; until: number }>();
  private usable = true;
  constructor(
    private dir: string,
    private now = Date.now,
    private limits = {
      each: REQUEST_LIMITS.crop,
      total: REQUEST_LIMITS.crops,
      keep: REQUEST_LIMITS.lifetime,
    },
    /** Crops that saved request results still name, with when they may go. */
    kept = new Map<string, number>(),
  ) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      // Crops no saved result names go. Restrict cleanup to our generated names.
      for (const name of fs.readdirSync(dir)) if (/^cli-[0-9a-f-]{36}\.png$/.test(name)) {
        const file = path.join(dir, name);
        this.owned.set(file, { card: '', size: fs.statSync(file).size, until: kept.get(file) ?? 0 });
      }
      this.sweep();
    } catch {
      // Cache failure removes crop capability, never the rest of Dictate.
      this.usable = false;
    }
  }
  save(card: string, png: Buffer): string | null {
    if (!this.usable) return null;
    this.sweep();
    const bytes = [...this.owned.values()].reduce((n, f) => n + f.size, 0);
    if (png.length > this.limits.each || bytes + png.length > this.limits.total) return null;
    const file = path.join(this.dir, `cli-${randomUUID()}.png`);
    try { fs.writeFileSync(file, png); } catch { return null; }
    this.owned.set(file, {
      card,
      size: png.length,
      until: Number.POSITIVE_INFINITY,
    });
    return file;
  }
  completed(card: string): void {
    for (const entry of this.owned.values()) if (entry.card === card) entry.until = this.now() + this.limits.keep;
  }
  retain(file: string, until: number): void {
    const entry = this.owned.get(file);
    if (entry) entry.until = Math.max(entry.until, until);
  }
  sweep(): void {
    for (const [file, entry] of this.owned)
      if (entry.until <= this.now()) {
        try {
          fs.rmSync(file, { force: true });
          this.owned.delete(file);
        } catch { /* still counted against capacity; retry cleanup at the next sweep */ }
      }
  }
}
