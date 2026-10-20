// L5 · Peek and talk. An agent's page (localhost, a local HTML report, an allowed https host) arrives as a card with
// a live thumbnail; Peek grows it into the docked view above the pill, shown without taking focus. Holding the
// dictation key over the page outlines what is under the pointer: on release the agent gets the words, the element
// (selector, role, text), the URL and a crop. A dragged region waits in a confirm strip for Enter. The page can't
// leave its origin unless the person allows it once (peekview.ts).
import fs from 'node:fs';
import path from 'node:path';
import { type BrowserWindow, type Session, screen, session, shell } from 'electron';
import type { HubSession } from '../../core/agenthub';
import type { Card } from '../../core/cards';
import type { PeekCardData, PeekConfirm, PeekSheetAction, PeekSheetPayload } from '../../core/peekdata';
import { SHEET_SIZES } from '../../core/sheetkinds';
import { checkTarget, type PeekTarget, parsePeekArgs, shortUrl, urlAllowed } from '../../core/tools/peek';
import type { Feature, FeatureHost } from './host';
import { type Blocked, dockWindow, HELPER, HELPER_WORLD, NavGuard, PeekFolders, type Pick, type Pointed, peekSession, registerPeekScheme, thumbWindow } from './peekview';

/** The docked page's area inside the sheet until the page reports it: under the two-line header. */
const HEAD_H = 62;
const VIEW = { width: SHEET_SIZES.peek.width, height: SHEET_SIZES.peek.height - HEAD_H };
const THUMB_W = 224;
const THUMB_EVERY_MS = 1500;
/** Crops are kept a day (the captures folder is shared with point and say). */
const CROP_KEEP_MS = 24 * 3600_000;
/** "peek", "open it", "show me": said over the card, it opens the docked view instead of answering. */
const OPEN_WORDS = /^\W*(peek|peek it|open it|open|show me|show me it|show it)\W*$/i;

interface Item {
  cardId: string;
  session: string;
  source: string;
  to: string;
  title: string;
  ask: string;
  target: PeekTarget;
  /** What the views load: the web URL, or the dictate-peek:// URL of the file. */
  url: string;
  wait: boolean;
  keepOpen: boolean;
  thumb: BrowserWindow | null;
  thumbAt: number;
}

interface Dock {
  item: Item;
  win: BrowserWindow;
  guard: NavGuard;
  hole: { x: number; y: number; width: number; height: number };
  blocked: Blocked | null;
  confirm: (PeekConfirm & { result: Record<string, unknown> }) | null;
  /** This dictation began with the key held over the page. */
  armed: boolean;
  talking: string | null;
  talkTimer: ReturnType<typeof setInterval> | undefined;
  snapshot?: string;
}

class PeekFeature {
  private items = new Map<string, Item>();
  private dock: Dock | null = null;
  private folders = new PeekFolders();
  private ses: Session | undefined;
  /** QA: the pointer counts as over the docked page without moving the OS pointer. */
  private qaPointer = false;

  constructor(private host: FeatureHost) {}

  start(): void {
    const { hub, sheet } = this.host;
    this.ses = peekSession(this.folders, this.host.log);
    this.sweepCrops();
    hub.handle('peek', (session, args, signal) => this.call(session, args, signal));
    hub.cardKind('peek', {
      reply: (card, text, raw) => this.reply(card, text, raw),
      action: (card, name) => this.cardAction(card, name),
    });
    hub.onEnded((cardId) => this.ended(cardId));
    this.host.replyTarget(() => this.replyTarget());
    sheet.onClosed((kind) => {
      if (kind === 'peek') this.undock();
    });
    this.host.ipc.on('action', (name) => void this.sheetAction(name as PeekSheetAction));
    this.host.ipc.on('hole', (r) => this.setHole(r));
    this.host.ipc.handle('forget', async () => {
      await this.ses?.clearStorageData();
      this.host.log('info', 'peek: sign-ins and site data forgotten');
      return true;
    });
    this.host.qa((line) => void this.qa(line).catch((err) => this.host.log('warn', `QA peek ${line}: ${(err as Error).message}`)));
  }

  stop(): void {
    for (const it of this.items.values()) it.thumb?.destroy();
    if (this.dock && !this.dock.win.isDestroyed()) this.dock.win.destroy();
    this.dock = null;
  }

  // ---------- the tool ----------

  private async call(session: HubSession, args: unknown, signal: AbortSignal): Promise<unknown> {
    const a = parsePeekArgs(args);
    const target = checkTarget(a.target, { cwd: session.cwd, hosts: this.host.settings().peek.hosts });
    if (target.kind === 'file' && !fs.existsSync(target.file)) throw new Error('peek: that file does not exist');
    const { hub } = this.host;
    if (hub.queue.paused) return { answered: false, reason: 'dnd' };
    const src = await hub.source(session);
    const id = hub.newId();
    const item: Item = {
      cardId: id,
      session: session.id,
      source: src.line,
      to: src.line.split(' · ').pop() || 'the agent',
      title: a.title,
      ask: a.ask,
      target,
      url: target.kind === 'web' ? target.url : this.folders.url(target.root, target.file),
      wait: a.wait,
      keepOpen: a.keepOpen,
      thumb: null,
      thumbAt: 0,
    };
    this.items.set(id, item);
    const data: PeekCardData = {
      url: shortUrl(target.kind === 'web' ? target.url : item.url),
      local: target.kind === 'file' || target.local,
      file: target.kind === 'file',
      ask: a.ask,
      thumb: null,
      live: false,
      loading: true,
      canPane: !!src.target,
      docked: false,
    };
    const card: Card = {
      id,
      key: `peek:${id}`,
      origin: 'agent',
      kind: 'peek',
      urgency: 'needs_you',
      source: src.line,
      sourceDetail: src.detail,
      title: a.title,
      message: a.message,
      action: 'reply',
      choices: [],
      target: src.target,
      data,
      createdAt: Date.now(),
    };
    const end = (reason: string) => ({ answered: false, reason, card_id: id });
    const answer = a.wait ? hub.wait(id, { session: session.id, kind: 'peek', timeoutMs: a.timeoutS * 1000, signal, ends: { timeout: end('timeout'), cancelled: end('cancelled'), dismissed: end('dismissed') } }) : null;
    // The page the person kept open (keep_open) shows this one in place, if it is the same page.
    const kept = this.dock && !this.items.has(this.dock.item.cardId) && this.dock.item.url === item.url ? this.dock : null;
    const raised = hub.raise(card);
    if (kept) {
      kept.item = item;
      data.docked = true;
      this.pushSheet();
    } else this.startThumb(item);
    this.host.log('info', `peek: card ${id} for ${target.kind === 'web' ? new URL(target.url).origin : 'a local file'}${a.wait ? '' : ' (not waiting)'}`);
    if (!answer) return { status: raised.status, card_id: raised.card_id, ...(a.truncated ? { truncated: true } : {}) };
    const r = (await answer) as Record<string, unknown>;
    return { ...r, ...(a.truncated ? { truncated: true } : {}) };
  }

  // ---------- the card and its live thumbnail ----------

  private cardData(id: string): PeekCardData | null {
    const c = this.host.hub.queue.get(id);
    return c ? (c.data as PeekCardData) : null;
  }

  private changed(): void {
    this.host.agents.render();
  }

  private startThumb(item: Item): void {
    if (!this.ses) return;
    const w = thumbWindow(this.ses, VIEW);
    item.thumb = w;
    new NavGuard(w.webContents, item.url, () => undefined, this.host.log);
    w.webContents.on('paint', (_e, _dirty, img) => {
      const now = Date.now();
      if (now - item.thumbAt < THUMB_EVERY_MS || img.isEmpty()) return;
      item.thumbAt = now;
      const d = this.cardData(item.cardId);
      if (!d) return;
      d.thumb = thumbOf(img);
      d.live = true;
      d.loading = false;
      this.changed();
    });
    w.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      const d = this.cardData(item.cardId);
      if (d) {
        d.loading = false;
        d.failed = `Couldn’t load ${shortUrl(url)} (${desc})`;
        this.changed();
      }
    });
    void w.loadURL(item.url).catch(() => undefined);
  }

  private stopThumb(item: Item): void {
    if (item.thumb && !item.thumb.isDestroyed()) item.thumb.destroy();
    item.thumb = null;
    const d = this.cardData(item.cardId);
    if (d) d.live = false;
  }

  private async cardAction(card: Card, name: string): Promise<{ ok: boolean; message: string } | undefined> {
    const item = this.items.get(card.id);
    if (!item) return { ok: false, message: 'That card is gone' };
    if (name === 'peek') {
      this.dockItem(item);
      return undefined;
    }
    if (name === 'browser') return this.openBrowser(item);
    if (name === 'pane' && card.target) {
      const pageUrl = item.target.kind === 'web' ? item.target.url : `file:///${item.target.file.replace(/\\/g, '/').replace(/^\//, '')}`;
      try {
        await this.host.agents.pane.run(['panels', 'open', '--pane', card.target.paneId, '--url', pageUrl, '--yes']);
        return { ok: true, message: 'Opened in Pane' };
      } catch (err) {
        this.host.log('warn', `peek: could not open the page in Pane (${(err as Error).message})`);
        return { ok: false, message: 'Couldn’t open it in Pane' };
      }
    }
    return undefined;
  }

  private openBrowser(item: Item): { ok: boolean; message: string } | undefined {
    if (item.target.kind === 'web') {
      const here = this.dock?.item === item && !this.dock.win.isDestroyed() ? this.dock.win.webContents.getURL() : item.target.url;
      void shell.openExternal(/^https?:/i.test(here) ? here : item.target.url);
    } else void shell.openPath(item.target.file);
    return undefined;
  }

  // ---------- the docked view ----------

  private dockItem(item: Item): void {
    if (!this.ses) return;
    const { sheet } = this.host;
    let d = this.dock;
    if (d && d.item !== item) {
      this.dropDock();
      d = null;
    }
    if (!d || d.win.isDestroyed()) {
      const win = dockWindow(this.ses, sheet.window());
      const fresh: Dock = {
        item,
        win,
        guard: undefined as unknown as NavGuard,
        hole: { x: 12, y: 12 + HEAD_H, ...VIEW },
        blocked: null,
        confirm: null,
        armed: false,
        talking: null,
        talkTimer: undefined,
      };
      fresh.guard = new NavGuard(win.webContents, item.url, (b) => {
        fresh.blocked = b;
        this.pushSheet();
      }, this.host.log);
      win.webContents.on('dom-ready', () => void this.inject(win));
      win.webContents.on('did-navigate', () => this.pushSheet());
      win.webContents.on('did-navigate-in-page', () => this.pushSheet());
      win.webContents.on('before-input-event', (e, input) => {
        if (input.type !== 'keyDown') return;
        if (input.key === 'Escape') {
          e.preventDefault();
          if (this.dock?.confirm) this.dropConfirm();
          else sheet.close('esc');
        } else if (input.key === 'Enter' && this.dock?.confirm) {
          e.preventDefault();
          void this.sendConfirm();
        }
      });
      win.on('closed', () => {
        if (this.dock?.win === win) this.dock = null;
      });
      // The thumbnail's page has been running: the docked one starts where it is.
      const at = item.thumb && !item.thumb.isDestroyed() ? item.thumb.webContents.getURL() : '';
      void win.loadURL(at && (at.startsWith('dictate-peek:') || urlAllowed(at, this.host.settings().peek.hosts)) ? at : item.url).catch(() => undefined);
      this.dock = fresh;
      d = fresh;
    }
    this.stopThumb(item);
    const data = this.cardData(item.cardId);
    if (data) {
      data.docked = true;
      this.changed();
    }
    sheet.open('peek', this.payload(d), { focus: false });
    this.placeDock();
    d.win.showInactive();
    this.host.log('info', `peek: docked ${item.cardId}`);
  }

  private payload(d: Dock): PeekSheetPayload {
    const url = d.win.isDestroyed() ? d.item.url : d.win.webContents.getURL() || d.item.url;
    return {
      cardId: d.item.cardId,
      source: d.item.source,
      title: d.item.title,
      ask: d.item.ask,
      url: shortUrl(url, 64),
      local: d.item.target.kind === 'file' || (d.item.target.kind === 'web' && d.item.target.local),
      blocked: d.blocked,
      away: !d.win.isDestroyed() && d.guard.away,
      confirm: d.confirm ? { image: d.confirm.image, size: d.confirm.size, words: d.confirm.words, under: d.confirm.under, to: d.confirm.to } : null,
      talking: d.talking,
      ...(d.snapshot ? { snapshot: d.snapshot } : {}),
    };
  }

  private pushSheet(): void {
    if (this.dock && this.host.sheet.kind === 'peek') this.host.sheet.update(this.payload(this.dock));
  }

  private setHole(r: unknown): void {
    const h = r as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
    if (!this.dock || ![h.x, h.y, h.width, h.height].every((v) => typeof v === 'number' && Number.isFinite(v))) return;
    this.dock.hole = { x: h.x as number, y: h.y as number, width: Math.max(1, h.width as number), height: Math.max(1, h.height as number) };
    this.placeDock();
  }

  private placeDock(): void {
    const d = this.dock;
    if (!d || d.win.isDestroyed()) return;
    const b = this.host.sheet.window().getBounds();
    d.win.setBounds({ x: Math.round(b.x + d.hole.x), y: Math.round(b.y + d.hole.y), width: Math.round(d.hole.width), height: Math.round(d.hole.height) });
  }

  /** The sheet closed (shrink, Esc, another surface): the page hides but keeps its state for the next Peek. */
  private undock(): void {
    const d = this.dock;
    if (!d) return;
    this.stopTalk(d);
    d.confirm = null;
    d.blocked = null;
    if (!d.win.isDestroyed()) d.win.hide();
    const data = this.cardData(d.item.cardId);
    if (data) {
      data.docked = false;
      this.changed();
    }
  }

  private dropDock(): void {
    const d = this.dock;
    if (!d) return;
    this.stopTalk(d);
    this.dock = null;
    if (!d.win.isDestroyed()) d.win.destroy();
  }

  private async inject(win: BrowserWindow): Promise<void> {
    if (win.isDestroyed()) return;
    await win.webContents.executeJavaScriptInIsolatedWorld(HELPER_WORLD, [{ code: HELPER }]).catch((err) => this.host.log('warn', `peek: pointing helper did not load (${(err as Error).message})`));
  }

  /** Calls the pointing helper, loading it first if the page is newer than its dom-ready. */
  private async helper<T>(call: string): Promise<T | null> {
    const d = this.dock;
    if (!d || d.win.isDestroyed()) return null;
    const run = () =>
      d.win.webContents
        .executeJavaScriptInIsolatedWorld(HELPER_WORLD, [{ code: `window.__dictatePeek ? { v: window.__dictatePeek.${call} } : null` }])
        .then((r) => r as { v: T | null } | null)
        .catch(() => null);
    let r = await run();
    if (!r && !d.win.isDestroyed() && !d.win.webContents.isLoading()) {
      await this.inject(d.win);
      r = await run();
    }
    return r ? r.v : null;
  }

  private async sheetAction(name: PeekSheetAction): Promise<void> {
    const d = this.dock;
    if (!d) return;
    switch (name) {
      case 'shrink':
        this.host.sheet.close('closed');
        return;
      case 'close':
        this.host.hub.dismiss(d.item.cardId);
        this.host.sheet.close('closed');
        return;
      case 'browser':
        this.openBrowser(d.item);
        return;
      case 'allow':
        if (d.blocked) d.guard.allowOnce(d.blocked.url);
        d.blocked = null;
        this.pushSheet();
        return;
      case 'stay':
        d.blocked = null;
        this.pushSheet();
        return;
      case 'home':
        d.guard.goHome();
        return;
      case 'send':
        await this.sendConfirm();
        return;
      case 'drop':
        this.dropConfirm();
        return;
    }
  }

  // ---------- pointing and talking ----------

  private pointerOverDock(): boolean {
    const d = this.dock;
    if (!d || d.win.isDestroyed() || !d.win.isVisible()) return false;
    if (this.qaPointer) return true;
    const p = screen.getCursorScreenPoint();
    const b = d.win.getBounds();
    return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
  }

  /** At each dictation key-down: the page under the pointer, the peek card under it, or a peek card's Reply. */
  private replyTarget(): { cardId: string; to: string } | null {
    const d = this.dock;
    if (d && this.host.sheet.kind === 'peek' && this.pointerOverDock()) {
      this.arm(d);
      return { cardId: d.item.cardId, to: d.item.to };
    }
    const agents = this.host.agents;
    const armed = agents.armed ? this.items.get(agents.armed) : undefined;
    if (armed) {
      agents.armed = null;
      return { cardId: armed.cardId, to: armed.to };
    }
    const top = this.host.hub.queue.view(Date.now()).top;
    const item = top ? this.items.get(top.id) : undefined;
    if (item && this.host.pill.pointerOverCard()) return { cardId: item.cardId, to: item.to };
    return null;
  }

  private arm(d: Dock): void {
    d.armed = true;
    d.confirm = null;
    void this.helper('arm()').then((ok) => {
      // Still loading: the outline starts once the page (and the helper with it) is there.
      if (ok === null && !d.win.isDestroyed()) d.win.webContents.once('dom-ready', () => setTimeout(() => d.armed && void this.helper('arm()'), 50));
    });
    this.stopTalk(d);
    // "Talking about Pay now…" while the key is down; the outline itself is drawn in the page.
    d.talkTimer = setInterval(() => {
      if (this.host.hub.queue.replyingTo !== d.item.cardId && !this.qaPointer) {
        // The dictation ended without words for the page (cancelled, nothing heard).
        this.stopTalk(d);
        if (d.armed) {
          d.armed = false;
          void this.helper('disarm()');
        }
        return;
      }
      void this.helper<{ text: string; selector: string }>('hovered()').then((h) => {
        const next = h ? h.text || h.selector.split(' > ').pop() || null : null;
        if (next !== d.talking) {
          d.talking = next;
          this.pushSheet();
        }
      });
    }, 200);
    this.pushSheet();
  }

  private stopTalk(d: Dock): void {
    clearInterval(d.talkTimer);
    d.talkTimer = undefined;
    if (d.talking) {
      d.talking = null;
      this.pushSheet();
    }
  }

  /** The person's words for a peek card: about the page under the pointer, or (on the card) about the page as a whole. */
  private async reply(card: Card, text: string, raw: string): Promise<{ ok: boolean; message: string }> {
    const item = this.items.get(card.id);
    if (!item) return { ok: false, message: 'That card is gone' };
    const d = this.dock?.item === item && this.dock.armed ? this.dock : null;
    if (!d && OPEN_WORDS.test(text)) {
      this.dockItem(item);
      return { ok: true, message: 'Peek' };
    }
    if (!d) return this.answer(item, { text, raw, url: item.target.kind === 'web' ? item.target.url : item.url });
    d.armed = false;
    this.stopTalk(d);
    const pick = await this.helper<Pick>('take()');
    const url = pick?.url ?? item.url;
    if (pick?.region) {
      const crop = await this.crop(d, pick.region.rect, pick.viewport);
      if (!crop) return this.answer(item, { text, raw, url, region: pick.region });
      d.confirm = {
        image: crop.dataUrl,
        size: { width: pick.region.rect.width, height: pick.region.rect.height },
        words: text,
        under: pick.region.under ? { selector: pick.region.under.selector, text: pick.region.under.text } : null,
        to: item.to,
        result: { text, raw, url, region: pick.region, crop: crop.file },
      };
      this.pushSheet();
      // Enter and Esc go to the sheet's confirm strip.
      const w = this.host.sheet.window();
      w.focus();
      return { ok: true, message: `Check what goes to ${item.to}` };
    }
    const pointed = pick?.pointed ?? null;
    const crop = pointed ? await this.crop(d, pointed.rect, pick?.viewport) : null;
    return this.answer(item, { text, raw, url, ...(pointed ? { pointed } : {}), ...(crop ? { crop: crop.file } : {}) });
  }

  private async sendConfirm(): Promise<void> {
    const d = this.dock;
    if (!d?.confirm) return;
    const result = d.confirm.result;
    d.confirm = null;
    this.pushSheet();
    const r = await this.answer(d.item, result as { text: string; raw: string; url: string });
    this.host.pill.send('dictate:pill', { kind: r.ok ? 'info' : 'error', message: r.message });
    this.host.pill.show();
  }

  private dropConfirm(): void {
    const d = this.dock;
    if (!d?.confirm) return;
    d.confirm = null;
    this.pushSheet();
    this.host.log('info', 'peek: region dropped, nothing sent');
  }

  /** Gives the agent its answer: the waiting call returns, or (wait: false) the words go to its Pane tab. */
  private async answer(item: Item, r: { text: string; raw: string; url: string; pointed?: Pointed; region?: Pick['region']; crop?: string }): Promise<{ ok: boolean; message: string }> {
    const { hub } = this.host;
    const result = { answered: true, ...r, card_id: item.cardId };
    if (item.wait) {
      if (!hub.settle(item.cardId, result)) return { ok: false, message: 'That card is gone' };
      this.host.log('info', `peek: answered ${item.cardId}${r.pointed ? ' (pointed)' : r.region ? ' (region)' : ''}`);
      return { ok: true, message: `Sent to ${item.to}` };
    }
    const card = hub.queue.get(item.cardId);
    if (!card?.target) return { ok: false, message: 'Nowhere to send it' };
    const lines = [r.text, '', `[Dictate · peek] ${r.url}`];
    if (r.pointed) lines.push(`Pointed at: ${r.pointed.selector}${r.pointed.text ? ` "${r.pointed.text}"` : ''}`);
    if (r.region) lines.push(`Region: ${r.region.rect.width} × ${r.region.rect.height}${r.region.under ? ` over ${r.region.under.selector}` : ''}`);
    if (r.crop) lines.push(`Crop: ${r.crop}`);
    return hub.replyToTab(card, lines.join('\n'));
  }

  /** A PNG of part of the page (CSS pixels in its viewport), saved under the captures folder. */
  private async crop(d: Dock, rect: Pointed['rect'], viewport?: { width: number; height: number }): Promise<{ file: string; dataUrl: string } | null> {
    if (d.win.isDestroyed()) return null;
    const pad = 6;
    const vw = viewport?.width ?? d.hole.width;
    const vh = viewport?.height ?? d.hole.height;
    const x = Math.max(0, Math.floor(rect.x - pad));
    const y = Math.max(0, Math.floor(rect.y - pad));
    const width = Math.min(vw, Math.ceil(rect.x + rect.width + pad)) - x;
    const height = Math.min(vh, Math.ceil(rect.y + rect.height + pad)) - y;
    if (width < 2 || height < 2) return null;
    try {
      const img = await d.win.webContents.capturePage({ x, y, width, height });
      if (img.isEmpty()) return null;
      const dir = capturesDir(this.host.userData);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `peek-${d.item.cardId}-${Date.now()}.png`);
      const png = img.toPNG();
      fs.writeFileSync(file, png);
      return { file, dataUrl: `data:image/png;base64,${png.toString('base64')}` };
    } catch (err) {
      this.host.log('warn', `peek: crop failed (${(err as Error).message})`);
      return null;
    }
  }

  private sweepCrops(): void {
    const dir = capturesDir(this.host.userData);
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((f) => /^peek-.*\.png$/.test(f));
    } catch {
      return;
    }
    const old = Date.now() - CROP_KEEP_MS;
    for (const f of names) {
      try {
        const p = path.join(dir, f);
        if (fs.statSync(p).mtimeMs < old) fs.rmSync(p, { force: true });
      } catch {
        // gone already
      }
    }
  }

  /** The card is gone (answered, dismissed, expired, the agent went): its windows go, unless it asked to keep the page up. */
  private ended(cardId: string): void {
    const item = this.items.get(cardId);
    if (!item) return;
    this.items.delete(cardId);
    this.stopThumb(item);
    const d = this.dock;
    if (d?.item !== item) return;
    if (item.keepOpen && this.host.sheet.kind === 'peek') {
      d.confirm = null;
      this.pushSheet();
      return;
    }
    if (this.host.sheet.kind === 'peek') this.host.sheet.close('closed');
    this.dropDock();
  }

  // ---------- QA ----------

  private async qa(line: string): Promise<void> {
    const [cmd, ...rest] = line.split(' ');
    const arg = rest.join(' ');
    const d = this.dock;
    const log = (what: string, v: unknown) => this.host.log('info', `QA peek-${what} ${JSON.stringify(v)}`);
    const centre = (sel: string) => this.helper<{ x: number; y: number }>(`centre(${JSON.stringify(sel)})`);
    const input = (e: Electron.MouseInputEvent | Electron.KeyboardInputEvent) => d && !d.win.isDestroyed() && d.win.webContents.sendInputEvent(e);
    switch (cmd) {
      case 'dump': {
        const top = this.host.hub.queue.view(Date.now()).top;
        const data = top?.kind === 'peek' ? (top.data as PeekCardData) : null;
        return log('dump', {
          cards: [...this.items.keys()],
          top: top ? { id: top.id, kind: top.kind, title: top.title, data: data && { ...data, thumb: data.thumb ? { width: data.thumb.width, height: data.thumb.height } : null } } : null,
          docked: !!d && !d.win.isDestroyed() && d.win.isVisible(),
          dock: d && !d.win.isDestroyed() ? { url: d.win.webContents.getURL(), loading: d.win.webContents.isLoading(), bounds: d.win.getBounds(), focused: d.win.isFocused(), blocked: d.blocked, confirm: !!d.confirm, armed: d.armed, away: d.guard.away } : null,
          sheet: { kind: this.host.sheet.kind, bounds: this.host.sheet.window().getBounds(), focused: this.host.sheet.window().isFocused() },
        });
      }
      case 'open': {
        const top = this.host.hub.queue.view(Date.now()).top;
        const item = top ? this.items.get(top.id) : undefined;
        if (item) this.dockItem(item);
        return log('open', !!item);
      }
      case 'pointer':
        this.qaPointer = arg === 'on';
        return log('pointer', this.qaPointer);
      // The dictation key's key-down over the page, as replyTarget sees it (without the speech model).
      case 'press':
        return log('press', this.replyTarget());
      // What the dictation delivers on release: the words, through the agents' reply path.
      case 'say': {
        const target = this.dock?.item.cardId ?? this.host.hub.queue.view(Date.now()).top?.id;
        const r = target ? await this.host.agents.reply(target, arg, arg) : null;
        return log('say', r);
      }
      case 'hover': {
        const c = await centre(arg);
        if (c) input({ type: 'mouseMove', x: c.x, y: c.y });
        return log('hover', c);
      }
      case 'move': {
        const [x, y] = rest.map(Number);
        input({ type: 'mouseMove', x, y });
        return log('move', { x, y });
      }
      case 'drag': {
        const [x0, y0, x1, y1] = rest.map(Number);
        input({ type: 'mouseMove', x: x0, y: y0 });
        input({ type: 'mouseDown', x: x0, y: y0, button: 'left', clickCount: 1 });
        for (let i = 1; i <= 4; i++) input({ type: 'mouseMove', x: Math.round(x0 + ((x1 - x0) * i) / 4), y: Math.round(y0 + ((y1 - y0) * i) / 4), button: 'left' });
        input({ type: 'mouseUp', x: x1, y: y1, button: 'left', clickCount: 1 });
        return log('drag', { x0, y0, x1, y1 });
      }
      case 'click': {
        const c = await centre(arg);
        if (c) {
          input({ type: 'mouseMove', x: c.x, y: c.y });
          input({ type: 'mouseDown', x: c.x, y: c.y, button: 'left', clickCount: 1 });
          input({ type: 'mouseUp', x: c.x, y: c.y, button: 'left', clickCount: 1 });
        }
        return log('click', c);
      }
      // The sheet's keys (the confirm strip's Enter and Esc), as the focused sheet gets them.
      case 'key': {
        const w = this.host.sheet.window();
        w.webContents.sendInputEvent({ type: 'keyDown', keyCode: arg });
        w.webContents.sendInputEvent({ type: 'keyUp', keyCode: arg });
        return log('key', arg);
      }
      case 'action':
        await this.sheetAction(arg as PeekSheetAction);
        return log('action', arg);
      // The page's own script tries what it may not: a pop-up, permissions, a form post.
      case 'page': {
        if (!d || d.win.isDestroyed()) return log('page', null);
        const code: Record<string, string> = {
          popup: `(() => { const w = window.open(${JSON.stringify('https://example.com/')}); return { opened: !!w }; })()`,
          permissions: `Promise.all([Notification.requestPermission(), new Promise((r) => navigator.geolocation.getCurrentPosition(() => r('granted'), (e) => r('denied:' + e.code), { timeout: 3000 })), navigator.mediaDevices ? navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'granted', (e) => 'denied:' + e.name) : 'none']).then(([notify, geo, mic]) => ({ notify, geo, mic }))`,
          post: `(() => { const f = document.createElement('form'); f.method = 'POST'; f.action = location.origin + '/posted'; document.body.append(f); f.submit(); return { submitted: true }; })()`,
          cookie: `(() => { document.cookie = 'dictate_qa=1; max-age=86400; path=/'; return { cookie: document.cookie }; })()`,
        };
        const r = code[arg] ? await d.win.webContents.executeJavaScript(code[arg], true).catch((err: Error) => ({ error: err.message })) : null;
        return log('page', { what: arg, r, url: d.win.webContents.getURL() });
      }
      // Cookies: the peek session's (persisted to disk) and the default session's (never touched by a peek).
      case 'cookies': {
        if (!this.ses) return;
        const before = Date.now() - 1000;
        if (arg) await this.ses.cookies.set({ url: arg, name: 'dictate_qa', value: '1', expirationDate: Date.now() / 1000 + 86400 });
        await this.ses.cookies.flushStore();
        const peek = await this.ses.cookies.get({ name: 'dictate_qa' });
        const def = await session.defaultSession.cookies.get({ name: 'dictate_qa' });
        const dir = this.ses.getStoragePath();
        const file = dir ? [path.join(dir, 'Network', 'Cookies'), path.join(dir, 'Cookies')].find((f) => fs.existsSync(f)) : undefined;
        // Chromium holds the cookie database open (on Windows, locked): written since the set is what can be seen.
        const onDisk = !!file && fs.statSync(file).mtimeMs >= before;
        return log('cookies', { persistent: this.ses.isPersistent(), peek: peek.map((c) => c.domain), default: def.length, onDisk });
      }
      // The docked page as a screenshot inside the sheet (the docked window is separate from it).
      case 'shot': {
        const dir = process.env.DICTATE_PILL_SHOTS;
        if (!d || d.win.isDestroyed() || !dir) return;
        const img = await d.win.webContents.capturePage().catch(() => null);
        d.snapshot = img ? img.toDataURL() : undefined;
        this.pushSheet();
        await new Promise((r) => setTimeout(r, 400));
        await this.host.sheet.shot(path.join(dir, `sheet-${arg}.png`));
        d.snapshot = undefined;
        this.pushSheet();
        return log('shot', arg);
      }
    }
  }
}

const capturesDir = (userData: string) => path.join(userData, 'agents', 'captures');

/** A small thumbnail as RGBA (toBitmap gives BGRA), for a canvas on the pill. */
function thumbOf(img: Electron.NativeImage): PeekCardData['thumb'] {
  const small = img.resize({ width: THUMB_W, quality: 'good' });
  const { width, height } = small.getSize();
  const px = small.toBitmap();
  for (let i = 0; i < px.length; i += 4) {
    const b = px[i];
    px[i] = px[i + 2];
    px[i + 2] = b;
  }
  return { width, height, rgba: px.toString('base64') };
}

let feature: PeekFeature | undefined;

export const peek: Feature = {
  name: 'peek',
  beforeReady: registerPeekScheme,
  setup(host) {
    feature = new PeekFeature(host);
    feature.start();
  },
  stop() {
    feature?.stop();
  },
};
