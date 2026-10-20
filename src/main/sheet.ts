// The sheet window, shared by the big surfaces: one surface at a time, right above the pill. A feature opens its
// page with its own data; the page draws it (src/renderer/sheet/<kind>.ts) and talks back on the feature's own IPC.
// Esc on any page, or the feature, closes it; whoever opened it hears why.
import fs from 'node:fs';
import path from 'node:path';
import { type BrowserWindow, ipcMain } from 'electron';
import { SHEET_SIZES, type SheetKind, type SheetOpen } from '../core/sheetkinds';
import type { Logger } from './log';
import { createSheet, placeSheet } from './windows';

export type SheetCloseReason = 'esc' | 'replaced' | 'closed';

export interface SheetOptions {
  /** Take keyboard focus (a round, the wide decision sheet); otherwise it shows without stealing it (peek). */
  focus?: boolean;
  /** CSS pixels; the kind's standard size otherwise. */
  size?: { width: number; height: number };
}

export class Sheet {
  private win: BrowserWindow | undefined;
  private ready = false;
  private current: SheetOpen | null = null;
  private closers: ((kind: SheetKind, why: SheetCloseReason) => void)[] = [];

  constructor(private log: Logger) {
    ipcMain.on('dictate:sheet-ready', (e) => {
      if (e.sender !== this.win?.webContents) return;
      this.ready = true;
      if (this.current) this.send('dictate:sheet-open', this.current);
    });
    ipcMain.on('dictate:sheet-esc', (e) => {
      if (e.sender === this.win?.webContents) this.close('esc');
    });
  }

  get kind(): SheetKind | null {
    return this.current?.kind ?? null;
  }

  get isOpen(): boolean {
    return !!this.current;
  }

  /** The window, for a surface that adds to it (peek's web view) or protects it from capture (point and say). */
  window(): BrowserWindow {
    if (!this.win || this.win.isDestroyed()) {
      this.ready = false;
      this.win = createSheet();
      this.win.webContents.on('render-process-gone', (_e, d) => {
        this.log('error', `sheet renderer gone: ${d.reason}`);
        this.win?.destroy();
        this.win = undefined;
        if (this.current) this.close('closed');
      });
    }
    return this.win;
  }

  /** Shows `kind`'s page with `payload`; another surface's page that was open is closed ('replaced'). */
  open(kind: SheetKind, payload: unknown, o: SheetOptions = {}): void {
    if (this.current && this.current.kind !== kind) this.close('replaced');
    const w = this.window();
    this.current = { kind, payload };
    placeSheet(w, o.size ?? SHEET_SIZES[kind]);
    if (this.ready) this.send('dictate:sheet-open', this.current);
    if (o.focus) {
      w.show();
      w.focus();
    } else w.showInactive();
    w.setAlwaysOnTop(true, 'screen-saver');
    w.moveTop();
    this.log('info', `sheet: ${kind} open${o.focus ? ' (focused)' : ''}`);
  }

  /** New data for the page on screen. */
  update(payload: unknown): void {
    if (!this.current) return;
    this.current = { ...this.current, payload };
    if (this.ready) this.send('dictate:sheet-open', this.current);
  }

  close(why: SheetCloseReason = 'closed'): void {
    const was = this.current;
    if (!was) return;
    this.current = null;
    if (this.win && !this.win.isDestroyed()) {
      this.send('dictate:sheet-close');
      this.win.hide();
    }
    this.log('info', `sheet: ${was.kind} closed (${why})`);
    for (const cb of this.closers) cb(was.kind, why);
  }

  /** Told whenever a page closes, with its kind and why. */
  onClosed(cb: (kind: SheetKind, why: SheetCloseReason) => void): void {
    this.closers.push(cb);
  }

  send(channel: string, ...args: unknown[]): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, ...args);
  }

  /** QA: a PNG of the sheet as it is. */
  async shot(file: string): Promise<void> {
    if (!this.win || this.win.isDestroyed()) return;
    const img = await this.win.webContents.capturePage();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, img.toPNG());
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = undefined;
  }
}
