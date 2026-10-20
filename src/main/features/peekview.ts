// Peek's hardened web view: the one place Dictate shows pages it didn't write. Its own persistent session (so a
// Grain sign-in lasts, and the default session never sees these pages) with every permission denied, downloads
// cancelled and forms that never submit; a protocol that serves only files inside an agent's working folder; a
// guard that keeps the page on its own origin unless the person allows one move; and the windows that show it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, protocol, type Session, session, type WebContents } from 'electron';
import { inside, navigation, originOf } from '../../core/tools/peek';
import type { Logger } from '../log';

export const PEEK_SCHEME = 'dictate-peek';
export const PEEK_PARTITION = 'persist:peek';

/** Before the app is ready: a standard, secure scheme, so relative links and the page's own origin work. */
export function registerPeekScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: PEEK_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** The working folders local pages are served from, each under its own random host so pages can't reach another. */
export class PeekFolders {
  private roots = new Map<string, string>();

  /** The dictate-peek:// URL for a file inside `root`. */
  url(root: string, file: string): string {
    let host = [...this.roots].find(([, r]) => r === root)?.[0];
    if (!host) {
      host = `f${crypto.randomBytes(6).toString('hex')}`;
      this.roots.set(host, root);
    }
    const rel = path.relative(root, file).split(path.sep).map(encodeURIComponent).join('/');
    return `${PEEK_SCHEME}://${host}/${rel}`;
  }

  /** The file a dictate-peek:// URL names, when it really is inside its folder (links followed); null otherwise. */
  resolve(url: string): string | null {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    const root = this.roots.get(u.hostname);
    if (!root) return null;
    let rel: string;
    try {
      rel = decodeURIComponent(u.pathname);
    } catch {
      return null;
    }
    const file = path.resolve(root, `.${rel}`);
    if (!inside(root, file)) return null;
    try {
      const real = fs.realpathSync(file);
      if (!inside(fs.realpathSync(root), real) || !fs.statSync(real).isFile()) return null;
      return real;
    } catch {
      return null;
    }
  }

  async respond(req: Request): Promise<Response> {
    const file = this.resolve(req.url);
    if (!file || req.method !== 'GET') return new Response('Not found', { status: 404 });
    try {
      const body = await fs.promises.readFile(file);
      return new Response(body, { headers: { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  }
}

/** Peek's own session, set up once: nothing it loads may ask for a permission, download, or submit a form. */
export function peekSession(folders: PeekFolders, log: Logger): Session {
  const ses = session.fromPartition(PEEK_PARTITION);
  ses.setPermissionRequestHandler((wc, permission, cb) => {
    log('info', `peek: denied a permission request (${permission}) from ${safeOrigin(wc.getURL())}`);
    cb(false);
  });
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', (e, item) => {
    e.preventDefault();
    item.cancel();
    log('info', 'peek: cancelled a download');
  });
  // Read-only: a form posting (or any non-GET page load) never leaves.
  ses.webRequest.onBeforeRequest((d, cb) => {
    const page = d.resourceType === 'mainFrame' || d.resourceType === 'subFrame';
    if (page && d.method !== 'GET') log('info', `peek: stopped a ${d.method} page load`);
    cb({ cancel: page && d.method !== 'GET' });
  });
  ses.protocol.handle(PEEK_SCHEME, (req) => folders.respond(req));
  return ses;
}

export const safeOrigin = (url: string) => originOf(url) ?? 'a page';

/** The Electron security checklist for a third-party page. */
export function hardenedPrefs(ses: Session, extra: Electron.WebPreferences = {}): Electron.WebPreferences {
  return {
    session: ses,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webviewTag: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    navigateOnDragDrop: false,
    spellcheck: false,
    safeDialogs: true,
    devTools: false,
    backgroundThrottling: false,
    ...extra,
  };
}

/** Chromium's net error for a request the session cancelled. */
const ERR_BLOCKED_BY_CLIENT = -20;

export type Blocked = { kind: 'navigate'; url: string; host: string } | { kind: 'popup'; url: string; host: string };

/**
 * Keeps a page where it is: links, redirects and scripts may move it within its own origin (or back home); a move
 * anywhere else is held until the person allows it once, and anything but http(s) never loads. Pop-ups are denied.
 */
export class NavGuard {
  private once: string | null = null;

  constructor(
    private wc: WebContents,
    readonly home: string,
    private blocked: (b: Blocked) => void,
    private log: Logger,
  ) {
    wc.setWindowOpenHandler(({ url }) => {
      log('info', `peek: denied a new window (${safeOrigin(url)})`);
      blocked({ kind: 'popup', url, host: hostOf(url) });
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e) => this.check(e, e.url));
    wc.on('will-redirect', (e) => this.check(e, e.url));
    wc.on('will-frame-navigate', (e) => {
      // Frames inside the page may load web pages; never another scheme.
      if (!e.isMainFrame && !/^https?:|^about:blank$/i.test(e.url)) e.preventDefault();
    });
    wc.on('will-attach-webview', (e) => e.preventDefault());
    // A page load the session stopped (a form post) leaves Chromium's error page: back to where the page was.
    wc.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
      if (!isMainFrame || code !== ERR_BLOCKED_BY_CLIENT) return;
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      else void wc.loadURL(home).catch(() => undefined);
    });
  }

  private check(e: Electron.Event, url: string): void {
    if (this.once && url === this.once) return;
    const here = this.wc.getURL() || this.home;
    const go = navigation(here, url) === 'go' || navigation(this.home, url) === 'go';
    if (go) return;
    e.preventDefault();
    const verdict = navigation(here, url);
    this.log('info', `peek: held a move to ${safeOrigin(url)} (${verdict})`);
    if (verdict === 'ask') this.blocked({ kind: 'navigate', url, host: hostOf(url) });
  }

  /** The person's "Allow once": this one address loads in the peek. */
  allowOnce(url: string): void {
    if (!/^https?:/i.test(url)) return;
    this.once = url;
    void this.wc.loadURL(url).catch(() => undefined);
  }

  /** Back to the page the agent showed. */
  goHome(): void {
    this.once = null;
    void this.wc.loadURL(this.home).catch(() => undefined);
  }

  get away(): boolean {
    return safeOrigin(this.wc.getURL()) !== safeOrigin(this.home);
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 60);
  }
};

/** The offscreen copy that paints the card's live thumbnail: never on screen, never focusable. */
export function thumbWindow(ses: Session, size: { width: number; height: number }): BrowserWindow {
  const w = new BrowserWindow({ show: false, width: size.width, height: size.height, frame: false, skipTaskbar: true, focusable: false, webPreferences: hardenedPrefs(ses, { offscreen: true }) });
  w.webContents.setFrameRate(2);
  w.webContents.setAudioMuted(true);
  return w;
}

/**
 * The docked view: a frameless window owned by the sheet and laid exactly over its page area, shown without taking
 * focus. (A view inside the sheet can't be captured on Windows, and crops need that; its own window can.)
 */
export function dockWindow(ses: Session, parent: BrowserWindow): BrowserWindow {
  const w = new BrowserWindow({
    show: false,
    parent,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#ffffff',
    title: 'dictate peek',
    webPreferences: hardenedPrefs(ses),
  });
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setMenu(null);
  return w;
}

/** The isolated world the pointing helper runs in: the page's own scripts can't see or call it. */
export const HELPER_WORLD = 1047;

/** What the helper reports about an element: never HTML, only its selector, role, text and box. */
export interface Pointed {
  selector: string;
  role: string;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
}

export interface Pick {
  pointed: Pointed | null;
  region: { rect: Pointed['rect']; under: Pointed | null } | null;
  url: string;
  viewport: { width: number; height: number };
}

/**
 * The pointing helper, run in its own world. It follows the pointer; armed (the key held over the page), it
 * outlines the element under it with its selector and, on a drag, draws a marquee with its size instead. Its
 * overlay sits in a closed shadow root and takes no pointer events. Clicks on the page are swallowed while armed.
 */
export const HELPER = `(() => {
  if (window.__dictatePeek) return true;
  let x = -1, y = -1, armed = false, drag = null, region = null;
  const host = document.createElement('dictate-peek-overlay');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = '<style>' +
    ':host{all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none}' +
    '.box{position:fixed;display:none;outline:2px solid #60cdff;outline-offset:1px;border-radius:3px;background:rgba(96,205,255,.10)}' +
    '.tag{position:fixed;display:none;font:600 11px/18px Consolas,ui-monospace,monospace;color:#00131c;background:#60cdff;padding:0 6px;border-radius:4px;white-space:nowrap;max-width:420px;overflow:hidden;text-overflow:ellipsis}' +
    '.marq{position:fixed;display:none;border:1.5px dashed #60cdff;background:rgba(96,205,255,.10);box-shadow:0 0 0 9999px rgba(0,0,0,.18)}' +
    '</style><div class="box"></div><div class="tag"></div><div class="marq"></div>';
  const [box, tag, marq] = root.querySelectorAll('div');
  const attach = () => { if (!host.isConnected) document.documentElement.append(host); };
  const ROLES = { A: 'link', BUTTON: 'button', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading', IMG: 'img', SELECT: 'combobox', TEXTAREA: 'textbox', NAV: 'navigation', LI: 'listitem', UL: 'list', OL: 'list', TABLE: 'table', FORM: 'form', HEADER: 'banner', FOOTER: 'contentinfo', MAIN: 'main', ASIDE: 'complementary', P: 'paragraph', LABEL: 'label', FIGURE: 'figure' };
  const INPUTS = { checkbox: 'checkbox', radio: 'radio', range: 'slider', button: 'button', submit: 'button', reset: 'button' };
  function role(el) {
    const r = el.getAttribute('role');
    if (r) return r.split(' ')[0];
    if (el.tagName === 'A') return el.hasAttribute('href') ? 'link' : 'generic';
    if (el.tagName === 'INPUT') return INPUTS[el.type] || 'textbox';
    return ROLES[el.tagName] || 'generic';
  }
  const ident = (s) => /^[A-Za-z_][\\w-]*$/.test(s);
  function selector(el) {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 6; e = e.parentElement) {
      if (e.id && ident(e.id)) { parts.unshift('#' + e.id); break; }
      let s = e.tagName.toLowerCase();
      const cls = [...e.classList].filter(ident).slice(0, 2);
      if (cls.length) s += '.' + cls.join('.');
      const p = e.parentElement;
      if (p) {
        const same = [...p.children].filter((c) => c.tagName === e.tagName);
        if (same.filter((c) => cls.every((k) => c.classList.contains(k))).length > 1) s += ':nth-of-type(' + (same.indexOf(e) + 1) + ')';
      }
      parts.unshift(s);
      try { if (document.querySelectorAll(parts.join(' > ')).length === 1) break; } catch {}
      if (e.tagName === 'BODY') break;
    }
    return parts.join(' > ');
  }
  const words = (s) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
  function info(el) {
    if (!el || el === host || el === document.documentElement) return null;
    const r = el.getBoundingClientRect();
    return { selector: selector(el), role: role(el), text: words(el.innerText || el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || el.value), rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } };
  }
  const under = (px, py) => { const el = document.elementFromPoint(px, py); return el === host ? null : el; };
  const place = (el, r) => Object.assign(el.style, { left: r.x + 'px', top: r.y + 'px', width: r.width + 'px', height: r.height + 'px', display: 'block' });
  function draw() {
    if (!armed) { box.style.display = tag.style.display = marq.style.display = 'none'; return; }
    attach();
    if (drag) {
      box.style.display = 'none';
      const r = rectOf(drag.x, drag.y, x, y);
      place(marq, r);
      tag.textContent = r.width + ' \\u00d7 ' + r.height;
      Object.assign(tag.style, { left: r.x + 'px', top: r.y + r.height + 4 + 'px', display: 'block', width: 'auto', height: 'auto' });
      return;
    }
    marq.style.display = 'none';
    const i = info(under(x, y));
    if (!i) { box.style.display = tag.style.display = 'none'; return; }
    place(box, i.rect);
    tag.textContent = i.selector.split(' > ').pop();
    Object.assign(tag.style, { left: i.rect.x + 'px', top: Math.max(0, i.rect.y - 22) + 'px', display: 'block', width: 'auto', height: 'auto' });
  }
  const rectOf = (x0, y0, x1, y1) => ({ x: Math.round(Math.min(x0, x1)), y: Math.round(Math.min(y0, y1)), width: Math.round(Math.abs(x1 - x0)), height: Math.round(Math.abs(y1 - y0)) });
  const swallow = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
  addEventListener('mousemove', (e) => { x = e.clientX; y = e.clientY; if (armed) draw(); }, true);
  addEventListener('mousedown', (e) => { if (!armed || e.button !== 0) return; swallow(e); drag = { x: e.clientX, y: e.clientY }; region = null; }, true);
  addEventListener('mouseup', (e) => {
    if (!drag) return;
    swallow(e);
    const r = rectOf(drag.x, drag.y, e.clientX, e.clientY);
    drag = null;
    region = r.width >= 12 && r.height >= 12 ? r : null;
    draw();
  }, true);
  addEventListener('click', (e) => { if (armed) swallow(e); }, true);
  window.__dictatePeek = {
    arm() { armed = true; region = null; drag = null; draw(); return true; },
    disarm() { armed = false; drag = null; draw(); return true; },
    hovered() { const i = info(under(x, y)); return i && { text: i.text, selector: i.selector }; },
    /** QA and tests: where an element's centre is, to move the pointer there. */
    centre(sel) { const el = document.querySelector(sel); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; },
    take() {
      const wasArmed = armed;
      armed = false; drag = null; draw();
      const r = region; region = null;
      return {
        armed: wasArmed,
        pointed: x >= 0 ? info(under(x, y)) : null,
        region: r ? { rect: r, under: info(under(r.x + r.width / 2, r.y + r.height / 2)) } : null,
        url: location.href,
        viewport: { width: innerWidth, height: innerHeight },
      };
    },
  };
  return true;
})()`;
