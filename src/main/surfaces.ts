// Main's side of the surfaces' seams: builds each feature's FeatureHost, and keeps what the features register (routes,
// shortcuts, key-down listeners, QA commands, Settings state, the orchestrator) for main.ts to consult. A route key
// or shortcut is bound only once a feature has registered it, so an unbuilt feature's default key does nothing.
import { type BrowserWindow, ipcMain } from 'electron';
import type { Bindings, RouteKey, ShortcutName } from '../core/hotkeys';
import type { Binding, Settings } from '../core/types';
import type { Agents } from './agents';
import { FEATURES } from './features';
import type { Feature, FeatureHost, FeatureName, ReplyTarget, Route, Shortcut } from './features/host';
import type { Logger } from './log';
import { NO_ORCHESTRATOR, type Orchestrator } from './orchestrator';
import type { Sheet } from './sheet';

export interface SurfacesDeps {
  log: Logger;
  userData: string;
  settings(): Settings;
  update(patch: Partial<Settings>): void;
  agents: Agents;
  sheet: Sheet;
  pill: FeatureHost['pill'];
  windows(): BrowserWindow[];
  preview(to: string, text: string): Promise<boolean>;
  recording: FeatureHost['recording'];
  bindingsChanged(): void;
  stateChanged(): void;
}

/** Which setting holds each route key and shortcut. */
const ROUTE_KEYS: Record<RouteKey, (s: Settings) => Binding | null> = { agent: (s) => s.voice.key, point: (s) => s.point.key };
const SHORTCUT_KEYS: Record<ShortcutName, (s: Settings) => Binding | null> = { snooze: (s) => s.snooze.key, round: (s) => s.inbox.roundKey, pause: (s) => s.inbox.pauseKey };

export class Surfaces {
  private routes = new Map<string, Route>();
  private shortcuts = new Map<ShortcutName, Shortcut>();
  private keyDowns: ((t: number) => void)[] = [];
  private qas = new Map<string, (line: string) => void>();
  private states = new Map<FeatureName, () => unknown>();
  private replyTargets: (() => ReplyTarget | null)[] = [];
  private orch: Orchestrator = NO_ORCHESTRATOR;

  constructor(
    private deps: SurfacesDeps,
    private features: Feature[] = FEATURES,
  ) {}

  start(): void {
    for (const f of this.features) {
      try {
        f.setup(this.hostFor(f.name));
      } catch (err) {
        this.deps.log('error', `surfaces: ${f.name} did not start (${(err as Error).message})`);
      }
    }
  }

  stop(): void {
    for (const f of this.features) {
      try {
        f.stop?.();
      } catch (err) {
        this.deps.log('warn', `surfaces: ${f.name} did not stop cleanly (${(err as Error).message})`);
      }
    }
  }

  /** The card a feature says this dictation answers, if any (asked at key down). */
  replyTarget(): ReplyTarget | null {
    for (const fn of this.replyTargets) {
      const t = fn();
      if (t) return t;
    }
    return null;
  }

  /** The route the dictation key records for right now, if a feature takes it. */
  dictationRoute(): string | undefined {
    for (const [name, r] of this.routes) if (r.takesDictation?.()) return name;
    return undefined;
  }

  route(name: string | undefined): Route | undefined {
    return name ? this.routes.get(name) : undefined;
  }

  /** The route keys and shortcuts to bind now: only those a feature registered, shortcuts only while claimed. */
  bindings(s: Settings): Pick<Bindings, 'routes' | 'shortcuts'> {
    const routes: Partial<Record<RouteKey, Binding | null>> = {};
    for (const k of Object.keys(ROUTE_KEYS) as RouteKey[]) if (this.routes.has(k)) routes[k] = ROUTE_KEYS[k](s);
    const shortcuts: Partial<Record<ShortcutName, Binding | null>> = {};
    for (const [name, sc] of this.shortcuts) if (sc.claimed()) shortcuts[name] = SHORTCUT_KEYS[name](s);
    return { routes, shortcuts };
  }

  shortcutPressed(name: ShortcutName): void {
    this.shortcuts.get(name)?.pressed();
  }

  keyDown(t: number): void {
    for (const cb of this.keyDowns) cb(t);
  }

  /** A QA control line for a feature (`<feature> <rest>`); false when no feature takes it. */
  qa(line: string): boolean {
    const [name, ...rest] = line.split(' ');
    const fn = this.qas.get(name);
    if (!fn) return false;
    fn(rest.join(' '));
    return true;
  }

  state(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, fn] of this.states) {
      try {
        out[name] = fn();
      } catch (err) {
        this.deps.log('warn', `surfaces: ${name} state failed (${(err as Error).message})`);
      }
    }
    return out;
  }

  orchestrator(): Orchestrator {
    return this.orch;
  }

  private hostFor(name: FeatureName): FeatureHost {
    const d = this.deps;
    const channel = (n: string) => `dictate:${name}:${n}`;
    return {
      log: d.log,
      userData: d.userData,
      settings: d.settings,
      update: d.update,
      hub: d.agents.hub,
      agents: d.agents,
      sheet: d.sheet,
      pill: d.pill,
      windows: d.windows,
      preview: d.preview,
      replyTarget: (fn) => this.replyTargets.push(fn),
      route: (r, route) => {
        this.routes.set(r, route);
        d.bindingsChanged();
      },
      recording: d.recording,
      shortcut: (n, s) => {
        this.shortcuts.set(n, s);
        d.bindingsChanged();
      },
      bindingsChanged: d.bindingsChanged,
      onKeyDown: (cb) => this.keyDowns.push(cb),
      orchestrator: () => this.orch,
      provideOrchestrator: (o) => {
        this.orch = o;
      },
      ipc: {
        handle: (n, fn) => ipcMain.handle(channel(n), (_e, ...args: unknown[]) => fn(...args)),
        on: (n, fn) => ipcMain.on(channel(n), (_e, ...args: unknown[]) => fn(...args)),
      },
      qa: (fn) => this.qas.set(name, fn),
      state: (fn) => this.states.set(name, fn),
      stateChanged: d.stateChanged,
    };
  }
}
