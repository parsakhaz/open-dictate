// L6 · Point and say (Windows): hold the point key over anything and talk. While the key is down the helper reads
// the element under the pointer (UI Automation, in its own process), the glow outlines it and the edge of the screen
// glows; holding the left button and dragging switches to a region. On release Dictate crops the screen there (its
// own windows kept out), reads the element's text, masks secrets, and shows the review card: it sends to the Voice
// orchestrator after 3 s on screen (pointing at the card pauses it), Enter sends now, Esc or ✕ cancels. Excluded
// apps make the key do nothing. Captures are deleted after 24 h. On macOS and Linux nothing is registered: the key is
// never bound.
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, desktopCapturer, globalShortcut, screen } from 'electron';
import type { Card } from '../../core/cards';
import {
  around,
  CAPTURE_PREFIX,
  captureName,
  countdown,
  FILE_POINTER_CHARS,
  intersect,
  isExcluded,
  type Point,
  pointMessage,
  prepareText,
  type Rect,
  REVIEW_MS,
  regionFrom,
  reviewCommand,
  staleCaptures,
  type Target,
  targetLabel,
  targetRect,
} from '../../core/pointsay';
import type { Orchestrator, OrchestratorResult } from '../orchestrator';
import type { Feature, FeatureHost } from './host';
import { Glow, type GlowState } from './pointglow';
import { helperScript, type Hit, PointHelper } from './pointhelper';

const TRACK_MS = 120;
const REVIEW_TICK_MS = 100;
/** A capture whose words never came (nothing was heard) is deleted after this. */
const ORPHAN_MS = 20_000;
const SWEEP_MS = 60 * 60 * 1000;
const THUMB_WIDTH = 360;
const TO = 'orchestrator · Voice';
/** QA's presses are numbered from here, apart from the recordings' own ids. */
const QA_IDS = 1_000_000;

/** What was captured on release, ready for the review card. */
interface Capture {
  file: string;
  size: { width: number; height: number };
  /** A small JPEG of the crop, base64, for the card (the pill's page loads no images by URL). */
  thumb: string;
  label: string;
  app: string;
  window: string;
  /** Read there, secrets already masked. */
  text: string;
  secrets: number;
  /** Which Dictate windows were kept out of the capture. */
  protectedWindows: number;
}

type Captured = Capture | { refused: string };

/** One press of the point key, from key down to the words. */
interface Pointing {
  id: number;
  held: () => boolean;
  timer: ReturnType<typeof setInterval>;
  busy: boolean;
  probes: number;
  at: Point;
  last: Hit | null;
  target: Target | null;
  anchor: Point | null;
  region: Rect | null;
  /** The process name, while the pointer is over an excluded app. */
  excluded: string | null;
  released: boolean;
  capture: Promise<Captured> | null;
  orphan?: ReturnType<typeof setTimeout>;
}

interface Review {
  id: string;
  mode: 'countdown' | 'wait';
  remaining: number;
  paused: boolean;
  keys: boolean;
  timer: ReturnType<typeof setInterval>;
  end(choice: 'send' | 'cancel'): void;
}

const BLOCKED: Record<string, string> = {
  'not-set-up': 'talking to agents isn’t set up',
  'not-running': 'the orchestrator isn’t running',
  draft: 'the orchestrator has a draft',
  'pane-missing': 'Pane isn’t installed',
  error: 'couldn’t reach the orchestrator',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class PointAndSay {
  private host!: FeatureHost;
  private dir = '';
  private helper!: PointHelper;
  private glow = new Glow();
  private pointing: Pointing | null = null;
  private review: Review | null = null;
  private sweepTimer?: ReturnType<typeof setInterval>;
  // QA only: the pointer, the left button, the pointer over the card and the orchestrator, never the real ones.
  private qaPointer: Point | null = null;
  private qaLeft: boolean | null = null;
  private qaPointed: boolean | null = null;
  private qaOrchestrator: (Orchestrator & { sent: unknown[] }) | null = null;
  private qaId = QA_IDS;
  private lastResult: unknown = null;

  setup(host: FeatureHost): void {
    if (process.platform !== 'win32') return;
    this.host = host;
    this.dir = path.join(host.userData, 'agents', 'captures');
    this.helper = new PointHelper(helperScript(app.getAppPath(), process.resourcesPath, app.isPackaged), process.pid, host.log);
    this.sweep();
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
    this.sweepTimer.unref?.();
    host.route('point', {
      label: 'Point and say',
      finish: 'Release to review',
      began: (id) => this.began(id, () => host.recording.active()),
      cancelled: (id) => this.cancelled(id),
      deliver: (text, _raw, id) => this.deliver(text, id),
    });
    host.hub.cardKind('point-review', {
      action: async (_card, name) => {
        if (name === 'send' || name === 'cancel') this.review?.end(name);
        return undefined;
      },
      reply: async (_card, text) => {
        const c = reviewCommand(text);
        if (c) this.review?.end(c);
        return c ? { ok: true, message: c === 'send' ? 'Sending' : 'Cancelled' } : { ok: false, message: 'Say “send” or “cancel”' };
      },
    });
    host.qa((line) => void this.qa(line));
    host.state(() => ({ supported: true, helper: this.helper.status }));
    // The helper takes a second to start: ready before the first press when the key is set.
    if (host.settings().point.key) void this.helper.start();
  }

  stop(): void {
    if (this.pointing) this.drop(this.pointing);
    this.review?.end('cancel');
    clearInterval(this.sweepTimer);
    this.helper?.stop();
    this.glow.destroy();
  }

  // ---------- the gesture ----------

  private pointer(): Point {
    return this.qaPointer ?? screen.dipToScreenPoint(screen.getCursorScreenPoint());
  }

  private began(id: number, held: () => boolean): void {
    if (this.pointing) this.drop(this.pointing);
    const p: Pointing = { id, held, timer: setInterval(() => void this.track(p), TRACK_MS), busy: false, probes: 0, at: this.pointer(), last: null, target: null, anchor: null, region: null, excluded: null, released: false, capture: null };
    this.pointing = p;
    void this.track(p);
  }

  private async track(p: Pointing): Promise<void> {
    if (this.pointing !== p || p.released) return;
    if (!p.held()) return this.release(p);
    if (p.busy) return;
    p.busy = true;
    const at = this.pointer();
    const hit = await this.helper.at(at.x, at.y, false);
    p.busy = false;
    if (this.pointing !== p || p.released) return;
    p.probes++;
    p.at = at;
    p.last = hit;
    const excluded = this.excludedAt(hit);
    // Over an excluded app from the start, the key does nothing at all: no glow, no capture, no words.
    if (excluded && p.probes === 1) {
      this.host.log('info', `point: ${excluded} is excluded; nothing captured`);
      this.drop(p);
      if (p.id < QA_IDS) this.host.recording.cancel();
      return;
    }
    p.excluded = excluded;
    const left = this.qaLeft ?? hit?.left ?? false;
    if (left) {
      p.anchor ??= at;
      p.region = regionFrom(p.anchor, at) ?? p.region;
    } else p.anchor = null;
    p.target = p.region ? { kind: 'region', rect: p.region } : hit?.element && !hit.own ? { kind: 'element', el: hit.element } : { kind: 'around', rect: around(at) };
    void this.glow.show(at, this.glowState(p, hit));
  }

  private excludedAt(hit: Hit | null): string | null {
    if (!hit) return null;
    const list = this.host.settings().point.excludedApps;
    for (const proc of [hit.process, hit.element?.process ?? '']) if (isExcluded(proc, list)) return proc;
    return null;
  }

  private glowState(p: Pointing, hit: Hit | null): GlowState {
    if (!hit) return { title: 'Not capturing', detail: 'can’t check the app under the pointer', box: null, off: true };
    if (p.excluded) return { title: 'Not capturing', detail: `${p.excluded} is never captured`, box: null, off: true };
    const t = p.target!;
    const detail = t.kind === 'region' ? 'only this region' : t.kind === 'element' ? 'only this element' : 'around the pointer';
    return { title: 'Capturing', detail, box: { rect: targetRect(t), tag: targetLabel(t), region: t.kind === 'region' }, off: false };
  }

  /** The key came up: the glow goes at once, and the crop is taken (unless nothing may be). */
  private release(p: Pointing): void {
    if (p.released) return;
    p.released = true;
    clearInterval(p.timer);
    this.glow.hide();
    if (this.pointing !== p) return;
    if (!p.last) p.capture = Promise.resolve({ refused: 'Couldn’t check the app under the pointer · nothing captured' });
    else if (p.excluded) p.capture = Promise.resolve({ refused: `Point and say is off over ${p.excluded}` });
    else p.capture = this.capture(p).catch((err) => ({ refused: `Couldn’t capture (${(err as Error).message})` }));
    p.orphan = setTimeout(() => {
      if (this.pointing === p) this.drop(p);
    }, ORPHAN_MS);
  }

  private cancelled(id: number): void {
    if (this.pointing?.id === id) this.drop(this.pointing);
  }

  /** Forgets a press, and deletes anything it captured. */
  private drop(p: Pointing): void {
    clearInterval(p.timer);
    clearTimeout(p.orphan);
    p.released = true;
    if (this.pointing === p) {
      this.pointing = null;
      this.glow.hide();
    }
    void p.capture?.then((c) => 'file' in c && this.remove(c.file));
  }

  // ---------- the capture ----------

  private async capture(p: Pointing): Promise<Captured> {
    const target = p.target ?? { kind: 'around' as const, rect: around(p.at) };
    let text = '';
    let appName = '';
    let window = '';
    if (target.kind === 'element') {
      // The text is read once, for the element the person let go on.
      const full = await this.helper.at(p.at.x, p.at.y, true);
      const el = full?.element && full.element.process === target.el.process ? full.element : target.el;
      text = el.text;
      appName = el.process;
      window = el.window;
    }
    const shot = await this.grab(targetRect(target), p.at);
    if (!shot) return { refused: 'Couldn’t capture the screen there' };
    const prepared = prepareText(text);
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, captureName(Date.now(), p.id));
    fs.writeFileSync(file, shot.png);
    this.host.log('info', `point: captured ${shot.size.width} × ${shot.size.height}${prepared.secrets ? `, ${prepared.secrets} secret${prepared.secrets === 1 ? '' : 's'} masked` : ''}`);
    return { file, size: shot.size, thumb: shot.thumb, label: targetLabel(target), app: appName, window, text: prepared.text, secrets: prepared.secrets, protectedWindows: shot.protectedWindows };
  }

  /** Crops the display at `rect` (physical pixels), with every Dictate window kept out of the capture. */
  private async grab(rect: Rect, at: Point): Promise<{ png: Buffer; thumb: string; size: { width: number; height: number }; protectedWindows: number } | null> {
    const display = screen.getDisplayNearestPoint(screen.screenToDipPoint(at));
    const phys = screen.dipToScreenRect(null, display.bounds);
    const crop = intersect(rect, phys);
    if (!crop) return null;
    const own = this.host.windows().filter((w) => !w.isDestroyed() && !w.isContentProtected());
    for (const w of own) w.setContentProtection(true);
    let sources: Electron.DesktopCapturerSource[];
    try {
      // Protection takes effect with the next desktop composition.
      await sleep(120);
      sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: phys.width, height: phys.height } });
    } finally {
      for (const w of own) if (!w.isDestroyed()) w.setContentProtection(false);
    }
    const src = sources.find((s) => s.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined);
    if (!src || src.thumbnail.isEmpty()) return null;
    const img = src.thumbnail;
    const k = img.getSize().width / phys.width;
    const cut = img.crop({ x: Math.round((crop.x - phys.x) * k), y: Math.round((crop.y - phys.y) * k), width: Math.max(1, Math.round(crop.width * k)), height: Math.max(1, Math.round(crop.height * k)) });
    const size = cut.getSize();
    const small = size.width > THUMB_WIDTH ? cut.resize({ width: THUMB_WIDTH, quality: 'good' }) : cut;
    return { png: cut.toPNG(), thumb: small.toJPEG(82).toString('base64'), size, protectedWindows: own.length + 1 };
  }

  // ---------- the review and the send ----------

  private async deliver(words: string, id: number): Promise<{ ok: boolean; message: string }> {
    const p = this.pointing;
    if (!p || p.id !== id) return { ok: false, message: 'Nothing was pointed at' };
    this.release(p);
    clearTimeout(p.orphan);
    const cap = await p.capture!;
    if (this.pointing === p) this.pointing = null;
    if ('refused' in cap) return { ok: false, message: cap.refused };
    const choice = await this.reviewCard(cap, words);
    if (choice === 'cancel') {
      this.remove(cap.file);
      return this.result({ ok: false, message: 'Cancelled · nothing sent' });
    }
    const text = pointMessage({ words, label: cap.label, app: cap.app, window: cap.window, text: cap.text, file: cap.file, size: cap.size });
    const orch = this.qaOrchestrator ?? this.host.orchestrator();
    let r: OrchestratorResult;
    try {
      r = await orch.send({ text, via: 'point', asFilePointer: text.length > FILE_POINTER_CHARS });
    } catch (err) {
      r = { delivered: false, blocked: 'error', message: (err as Error).message };
    }
    if (r.delivered) return this.result({ ok: true, message: 'Sent to the orchestrator' });
    this.host.log('warn', `point: not sent (${r.blocked}${r.message ? `: ${r.message}` : ''})`);
    return this.result({ ok: false, message: `Not sent · ${BLOCKED[r.blocked] ?? r.blocked}` });
  }

  private result(r: { ok: boolean; message: string }) {
    this.lastResult = r;
    return r;
  }

  /** The card that shows exactly what will go; resolves when it is sent (by the countdown, Send, Enter) or cancelled. */
  private reviewCard(cap: Capture, words: string): Promise<'send' | 'cancel'> {
    this.review?.end('cancel');
    const hub = this.host.hub;
    const id = hub.newId();
    const mode = this.host.settings().point.review;
    return new Promise((resolve) => {
      let last = Date.now();
      const r: Review = {
        id,
        mode,
        remaining: REVIEW_MS,
        paused: false,
        keys: false,
        timer: setInterval(() => tick(), REVIEW_TICK_MS),
        end: (choice) => {
          if (this.review !== r) return;
          this.review = null;
          clearInterval(r.timer);
          this.keys(r, false);
          hub.dismiss(id);
          resolve(choice);
        },
      };
      this.review = r;
      const data = () => ({ thumb: cap.thumb, caption: `${cap.label.split(' · ')[0]} · ${cap.size.width} × ${cap.size.height} crop`, textLabel: cap.label.split(' · ')[0], text: cap.text, secrets: cap.secrets, words, to: TO, mode, remainingMs: r.remaining, paused: r.paused });
      const card: Card = { id, key: `point:${id}`, origin: 'dictate', kind: 'point-review', urgency: 'needs_you', source: 'Dictate · Point and say', title: 'Send this to the orchestrator?', message: '', choices: [], data: data(), target: null, createdAt: Date.now() };
      hub.raise(card);
      this.host.pill.send('dictate:pill', { kind: 'toast', message: mode === 'countdown' ? 'Ready to send · Enter sends now · Esc cancels' : 'Ready to send · Send or ✕ on the card', ms: 4000 });
      const tick = () => {
        const now = Date.now();
        const dt = now - last;
        last = now;
        const c = hub.queue.get(id);
        // ✕ (or anything else) took the card away.
        if (!c) return r.end('cancel');
        if (mode === 'wait') return;
        const onTop = hub.queue.view(now).top?.id === id;
        const pointed = onTop && (this.qaPointed ?? this.host.pill.pointerOverCard());
        // Enter and Esc are taken from other apps only while the countdown is on screen and running.
        this.keys(r, onTop && !pointed);
        r.remaining = countdown(r.remaining, dt, onTop && !pointed);
        if (r.remaining === 0) return r.end('send');
        if (pointed !== r.paused) {
          r.paused = pointed;
          c.data = data();
          this.host.agents.render();
        }
      };
    });
  }

  private keys(r: Review, on: boolean): void {
    if (r.keys === on) return;
    r.keys = on;
    if (on) {
      globalShortcut.register('Escape', () => r.end('cancel'));
      globalShortcut.register('Enter', () => r.end('send'));
    } else {
      globalShortcut.unregister('Escape');
      globalShortcut.unregister('Enter');
    }
  }

  // ---------- captures on disk ----------

  private remove(file: string): void {
    fs.rm(file, { force: true }, () => {});
  }

  /** Deletes point-and-say captures older than a day: at start, then hourly. */
  private sweep(): number {
    let names: string[] = [];
    try {
      const files = fs
        .readdirSync(this.dir)
        .filter((n) => n.startsWith(CAPTURE_PREFIX))
        .map((name) => ({ name, mtimeMs: fs.statSync(path.join(this.dir, name)).mtimeMs }));
      names = staleCaptures(files, Date.now());
      for (const n of names) fs.rmSync(path.join(this.dir, n), { force: true });
    } catch {
      // No captures folder yet.
    }
    if (names.length) this.host.log('info', `point: deleted ${names.length} capture${names.length === 1 ? '' : 's'} older than a day`);
    return names.length;
  }

  // ---------- QA: the control file, never the real pointer or keyboard ----------

  private async qa(line: string): Promise<void> {
    const [cmd, ...rest] = line.split(' ');
    const log = (what: string, v: unknown) => this.host.log('info', `QA point-${what} ${JSON.stringify(v)}`);
    switch (cmd) {
      case 'pointer':
        this.qaPointer = { x: Number(rest[0]), y: Number(rest[1]) };
        return;
      case 'mouse':
        this.qaLeft = rest[0] === 'down' ? true : rest[0] === 'up' ? false : null;
        return;
      case 'pointed':
        this.qaPointed = rest[0] === 'on' ? true : rest[0] === 'off' ? false : null;
        return;
      case 'helper':
        return log('helper', { ok: await this.helper.start(), status: this.helper.status });
      // The point key: down, then up (the words come with `say`, as the recognizer would hand them over).
      case 'down': {
        const id = ++this.qaId;
        let held = true;
        this.began(id, () => held);
        this.qaRelease = () => {
          held = false;
        };
        return log('down', { id });
      }
      case 'up':
        this.qaRelease?.();
        return;
      case 'tap':
        if (this.pointing) this.cancelled(this.pointing.id);
        return;
      case 'say': {
        const id = this.pointing?.id ?? -1;
        return log('said', await this.deliver(rest.join(' '), id));
      }
      case 'key':
        if (this.review && rest[0] === 'enter') this.review.end('send');
        if (this.review && rest[0] === 'escape') this.review.end('cancel');
        return;
      case 'fake-orchestrator': {
        const sent: unknown[] = [];
        this.qaOrchestrator = rest[0] === 'off' ? null : { sent, available: () => true, send: async (m) => {
              sent.push(m);
              return { delivered: true, state: 'taken' };
            },
          };
        return;
      }
      case 'exclude':
        this.host.update({ point: { ...this.host.settings().point, excludedApps: JSON.parse(rest.join(' ')) } });
        return;
      case 'sweep':
        return log('swept', { deleted: this.sweep() });
      case 'glow-shot': {
        const w = this.glow.current.window;
        const dir = process.env.DICTATE_PILL_SHOTS;
        if (w && dir) {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `point-${rest[0]}.png`), (await w.webContents.capturePage()).toPNG());
        }
        return log('glow-shot', { name: rest[0], ok: !!(w && dir) });
      }
      // The real Settings page, in a hidden window of its own, scrolled to this section.
      case 'settings-shot': {
        const dir = process.env.DICTATE_PILL_SHOTS;
        const w = new BrowserWindow({ show: false, width: 900, height: 1300, paintWhenInitiallyHidden: true, webPreferences: { preload: path.join(app.getAppPath(), 'out', 'main', 'preload.js'), contextIsolation: true, sandbox: false } });
        let ok = false;
        try {
          await w.loadFile(path.join(app.getAppPath(), 'out', 'renderer', 'settings.html'));
          await sleep(800);
          await w.webContents.executeJavaScript(`[...document.querySelectorAll('nav button, nav a, .nav button, [data-page]')].find((b) => /Agent/.test(b.textContent))?.click()`);
          await sleep(800);
          ok = await w.webContents.executeJavaScript(`(() => { const h = [...document.querySelectorAll('h2')].find((x) => x.textContent === 'Point and say'); if (!h) return false; h.scrollIntoView(); return true; })()`);
          await sleep(300);
          if (dir) fs.writeFileSync(path.join(dir, `point-${rest[0] || 'settings'}.png`), (await w.webContents.capturePage()).toPNG());
        } finally {
          w.destroy();
        }
        return log('settings-shot', { ok });
      }
      case 'dump': {
        const p = this.pointing;
        const cap = p?.capture ? await Promise.race([p.capture, sleep(3000).then(() => null)]) : null;
        let captures: string[] = [];
        try {
          captures = fs.readdirSync(this.dir).filter((n) => n.startsWith(CAPTURE_PREFIX));
        } catch {}
        const g = this.glow.current;
        return log('state', {
          pointing: p ? { id: p.id, released: p.released, excluded: p.excluded, target: p.target && targetLabel(p.target), region: p.region, hit: p.last && { process: p.last.process, own: p.last.own, element: p.last.element && { name: p.last.element.name, role: p.last.element.role, rect: p.last.element.rect } } } : null,
          capture: cap && ('file' in cap ? { ...cap, thumb: cap.thumb.length } : cap),
          glow: { visible: !!g.window?.isVisible(), state: g.state },
          review: this.review && { mode: this.review.mode, remaining: this.review.remaining, paused: this.review.paused, keys: this.review.keys },
          captures,
          sent: this.qaOrchestrator?.sent ?? null,
          last: this.lastResult,
          helper: this.helper.status,
        });
      }
    }
  }

  private qaRelease?: () => void;
}

const feature = new PointAndSay();

export const point: Feature = {
  name: 'point',
  setup: (host) => feature.setup(host),
  stop: () => feature.stop(),
};
