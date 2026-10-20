// L6 · The capture indicator: while the point key is down, a thin accent glow runs round the edge of the display
// under the pointer, a "Capturing" capsule sits at its top centre, and the element (or dragged region) is outlined
// with its tag. One click-through window that never takes focus, kept out of every capture, hidden on release.
import { BrowserWindow, type Rectangle, screen } from 'electron';
import type { Rect } from '../../core/pointsay';

export interface GlowState {
  /** The capsule's words: "Capturing", or why nothing will be captured. */
  title: string;
  detail: string;
  /** What is outlined (physical screen pixels), with its tag; none while nothing is under the pointer. */
  box: { rect: Rect; tag: string; region: boolean } | null;
  /** Nothing will be captured here (an excluded app): the glow turns grey. */
  off: boolean;
}

// The outline's colours are the card family's accent (theme.css --accent); the capsule is the card material.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:transparent;font:13px/18px 'Segoe UI Variable Text','Segoe UI',system-ui,sans-serif;color:#fff;-webkit-user-select:none;user-select:none}
.edge{position:fixed;inset:0;box-shadow:inset 0 0 0 2px rgba(96,205,255,.85),inset 0 0 28px 4px rgba(96,205,255,.35)}
.cap{position:fixed;top:12px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:8px;padding:6px 14px;border-radius:999px;background:rgba(32,32,32,.96);border:1px solid rgba(96,205,255,.55);box-shadow:0 8px 24px rgba(0,0,0,.4);white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;background:#60cdff;box-shadow:0 0 0 3px rgba(96,205,255,.25)}
.sub{color:rgba(255,255,255,.62)}
.box{position:fixed;display:none;box-sizing:border-box;border:2px solid #60cdff;border-radius:6px;box-shadow:0 0 0 4px rgba(96,205,255,.22),0 0 18px rgba(96,205,255,.35)}
.box.region{border-style:dashed}
.tag{position:absolute;left:-2px;bottom:100%;margin-bottom:6px;max-width:440px;padding:1px 8px;border-radius:5px;background:#60cdff;color:#00131c;font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.box.below .tag{bottom:auto;top:100%;margin:6px 0 0}
body.off .edge{box-shadow:inset 0 0 0 2px rgba(255,255,255,.35)}
body.off .dot{background:rgba(255,255,255,.5);box-shadow:none}
body.off .cap{border-color:rgba(255,255,255,.25)}
</style></head><body><div class="edge"></div><div class="cap"><span class="dot"></span><span id="t">Capturing</span><span class="sub" id="s"></span></div><div class="box" id="b"><div class="tag" id="g"></div></div>
<script>
window.setGlow = (s) => {
  document.getElementById('t').textContent = s.title;
  document.getElementById('s').textContent = s.detail ? '· ' + s.detail : '';
  document.body.classList.toggle('off', s.off);
  const b = document.getElementById('b');
  if (!s.box) { b.style.display = 'none'; return; }
  Object.assign(b.style, { display: 'block', left: s.box.x + 'px', top: s.box.y + 'px', width: s.box.width + 'px', height: s.box.height + 'px' });
  b.classList.toggle('region', s.box.region);
  b.classList.toggle('below', s.box.y < 60);
  document.getElementById('g').textContent = s.box.tag;
};
</script></body></html>`;

export class Glow {
  private win: BrowserWindow | null = null;
  private loaded: Promise<void> | null = null;
  private displayId: number | null = null;
  private last: GlowState | null = null;
  shown = false;

  private window(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const w = new BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setIgnoreMouseEvents(true);
    // Never in a crop, a screenshot or a screen share.
    w.setContentProtection(true);
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    this.loaded = w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`).catch(() => {});
    this.win = w;
    return w;
  }

  /** Shows (or updates) the glow on the display containing `at` (physical pixels). */
  async show(at: { x: number; y: number }, s: GlowState): Promise<void> {
    const w = this.window();
    const display = screen.getDisplayNearestPoint(screen.screenToDipPoint(at));
    if (this.displayId !== display.id || !this.shown) {
      w.setBounds(display.bounds);
      this.displayId = display.id;
    }
    this.last = s;
    await this.loaded;
    if (w.isDestroyed() || this.last !== s) return;
    const box = s.box ? this.toPage(s.box.rect, display.bounds) : null;
    await w.webContents.executeJavaScript(`setGlow(${JSON.stringify({ ...s, box: box && s.box ? { ...box, tag: s.box.tag, region: s.box.region } : null })})`).catch(() => {});
    // A newer state may already be on its way, but the glow shows now unless the key came up meanwhile (hide()).
    if (!this.shown && this.last !== null && !w.isDestroyed()) {
      w.showInactive();
      this.shown = true;
    }
  }

  hide(): void {
    this.last = null;
    this.shown = false;
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  /** The glow window itself, for QA's screenshot and dump. */
  get current(): { window: BrowserWindow | null; state: GlowState | null } {
    return { window: this.win && !this.win.isDestroyed() ? this.win : null, state: this.last };
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  /** A physical screen rectangle in the page's CSS pixels. */
  private toPage(r: Rect, display: Rectangle): Rect {
    const dip = screen.screenToDipRect(null, r);
    return { x: Math.round(dip.x - display.x), y: Math.round(dip.y - display.y), width: Math.round(dip.width), height: Math.round(dip.height) };
  }
}
