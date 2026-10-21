import { app, BrowserWindow, ipcMain, screen } from 'electron';
import path from 'node:path';
import type { Logger } from './log';

/** Real controls in an opaque, bounded, normally interactive native window. */
export class CardsWindow {
  private win: BrowserWindow;
  private ready = false;
  private pending = new Map<string, unknown[]>();
  private suppressed = false;

  constructor(private log: Logger, private dismiss: () => void) {
    this.win = new BrowserWindow({
      width: 420, height: 240, show: false, frame: false,
      transparent: false, backgroundColor: '#202020',
      focusable: true, resizable: false, minimizable: false, maximizable: false,
      skipTaskbar: true, alwaysOnTop: true, title: 'Dictate cards',
      webPreferences: { preload: path.join(app.getAppPath(), 'out/main/preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false },
    });
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.on('close', (e) => { e.preventDefault(); this.close(); });
    this.win.webContents.on('render-process-gone', (_e, details) => {
      this.log('error', `cards renderer gone: ${details.reason}`);
      this.ready = false;
      this.win.hide();
      this.win.reload();
    });
    ipcMain.on('dictate:cards-ready', (e) => {
      if (e.sender !== this.win.webContents) return;
      this.ready = true;
      for (const [channel, args] of this.pending) this.win.webContents.send(channel, ...args);
    });
    ipcMain.on('dictate:cards-close', (e) => {
      if (e.sender === this.win.webContents) this.close();
    });
    ipcMain.on('dictate:cards-size', (e, height: unknown, visible: unknown) => {
      if (e.sender !== this.win.webContents || typeof height !== 'number' || !Number.isFinite(height)) return;
      if (!visible || this.suppressed) return this.hide();
      const bounds = this.win.getBounds();
      const anchor = this.win.isVisible() ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 } : screen.getCursorScreenPoint();
      const area = screen.getDisplayNearestPoint(anchor).workArea;
      const width = Math.min(420, area.width);
      const h = Math.max(80, Math.min(Math.ceil(height), area.height - 100));
      const away = process.env.DICTATE_PILL_SHOTS ? -10_000 : 0;
      this.win.setBounds({ x: Math.round(area.x + (area.width - width) / 2) + away, y: Math.round(area.y + area.height - h - 76), width, height: h });
      if (!this.win.isVisible()) this.win.showInactive();
    });
    void this.win.loadFile(path.join(app.getAppPath(), 'out/renderer/cards.html'));
  }

  send(channel: string, ...args: unknown[]): void {
    if (channel.startsWith('dictate:capture') || channel === 'dictate:level' || channel === 'dictate:enumerate' || channel === 'dictate:sound') return;
    const previous = this.pending.get(channel);
    const status = args[0] as { kind?: string; undo?: boolean } | undefined;
    const freshUndo = channel === 'dictate:pill' && status?.kind === 'toast' && status.undo;
    const freshInbox = channel === 'dictate:inbox:toast' && !!args[0] && JSON.stringify(previous) !== JSON.stringify(args);
    this.pending.set(channel, args);
    if (channel === 'dictate:cards' && (args[0] as { top?: unknown })?.top) this.suppressed = false;
    if (this.ready && !this.win.isDestroyed()) this.win.webContents.send(channel, ...args);
    if (freshUndo || freshInbox) this.reopen();
  }

  reopen(): void {
    this.suppressed = false;
    if (this.ready && !this.win.isDestroyed()) this.win.webContents.send('dictate:cards-reopen');
  }
  hide(): void { if (!this.win.isDestroyed()) this.win.hide(); }
  private close(): void { this.suppressed = true; this.hide(); this.dismiss(); }
  bounds(): Electron.Rectangle { return this.win.getBounds(); }
  window(): BrowserWindow { return this.win; }
  destroy(): void { this.win.destroy(); }
}
