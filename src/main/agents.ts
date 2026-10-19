// Coding agents reach the person through the pill. This wires the pieces together in the main process: the MCP
// bridge copied out of the bundle into the data folder (so agent configs survive updates), the local channel it
// talks to, the hub's rules, Pane through runpane, registration with Claude Code, Codex and Cursor, and the
// history access log. Electron stays with the host.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentHub, type ConsentAnswer } from '../core/agenthub';
import { BRIDGE_FILE, channelPath } from '../core/agentwire';
import type { Card } from '../core/cards';
import type { HistoryStore } from '../core/history';
import { type AccessRecord, addRecord, logLine, parseAccessLog } from '../core/historyaccess';
import { actionFor } from '../core/panewatch';
import { serverEntry, setupSnippets, type Snippet } from '../core/registration';
import type { Settings } from '../core/types';
import { approveTerm, rejectTerm } from '../core/vocabproposals';
import { type AgentHandlers, AgentServer } from './agentserver';
import type { Logger } from './log';
import { PaneLink } from './panelink';
import { type AgentState, agentStatus, registerAgents, unregisterAgents } from './registration';
import { debouncedWriter, loadJson } from './store';

export const agentsDir = (userData: string) => path.join(userData, 'agents');

/** Copies the bridge next to the channel file when it differs; returns where it is. */
export function installBridge(appRoot: string, userData: string, log: Logger): string {
  const from = path.join(appRoot, 'out', 'bridge', BRIDGE_FILE);
  const to = path.join(agentsDir(userData), BRIDGE_FILE);
  try {
    const src = fs.readFileSync(from);
    let same = false;
    try {
      same = fs.readFileSync(to).equals(src);
    } catch {
      // not there yet
    }
    if (!same) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      const tmp = `${to}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, src);
      fs.renameSync(tmp, to);
      log('info', `agents: bridge installed at ${to}`);
    }
  } catch (err) {
    log('warn', `agents: could not install the bridge (${(err as Error).message})`);
  }
  return to;
}

export async function startAgentChannel(userData: string, handlers: AgentHandlers, log: Logger): Promise<AgentServer | undefined> {
  const runtime = process.platform === 'win32' ? '' : process.env.XDG_RUNTIME_DIR || os.tmpdir();
  const server = new AgentServer(agentsDir(userData), channelPath(userData, process.platform, runtime), handlers);
  try {
    await server.start();
    log('info', 'agents: channel open');
    return server;
  } catch (err) {
    // Another copy of Dictate on this profile, or a pipe we can't create: agents are told Dictate isn't running.
    log('warn', `agents: channel did not open (${(err as Error).message})`);
    return undefined;
  }
}

export interface AgentsHost {
  userData: string;
  appRoot: string;
  log: Logger;
  settings(): Settings;
  update(patch: Partial<Settings>): void;
  history(): HistoryStore;
  status(): { modelsReady: boolean; dictating: boolean };
  /** Cards for the pill: the top one, how many more, and the list behind "+N". */
  showCards(view: CardsView): void;
  chime(): void;
  openSettings(page: string): void;
  openExternal(url: string): void;
  copy(text: string): Promise<void>;
  /** The program in front is Pane (its executable path, when the OS says). */
  paneInFront(): boolean;
  /** Windows: let Pane take the foreground after the person's click. */
  allowForeground(): void;
  /** Registration writes real agent configs: packaged builds only, unless a test home is given. */
  registration: { allowed: boolean; executable: string; env: Record<string, string | undefined> };
  /** The tray's "Pause agent alerts" label changed. */
  trayChanged(): void;
}

export interface CardDto {
  id: string;
  kind: Card['kind'];
  urgency: Card['urgency'];
  source: string;
  sourceDetail?: string;
  title: string;
  message: string;
  choices: string[];
  linkHost: string | null;
  canOpen: boolean;
  canReply: boolean;
}

export interface CardsView {
  top: CardDto | null;
  more: number;
  list: CardDto[];
}

export type CardAction =
  | { id: string; action: 'open' | 'dismiss' | 'link' | 'review' | 'arm-reply' }
  | { id: string; action: 'choose'; value: string }
  | { id: string; action: 'consent'; value: ConsentAnswer };

const dto = (c: Card): CardDto => ({
  id: c.id,
  kind: c.kind,
  urgency: c.urgency,
  source: c.source,
  ...(c.sourceDetail ? { sourceDetail: c.sourceDetail } : {}),
  title: c.title,
  message: c.message,
  choices: c.choices,
  linkHost: c.link?.host ?? null,
  canOpen: !!c.target,
  canReply: !!c.target || c.kind === 'ask',
});

export class Agents {
  readonly hub: AgentHub;
  readonly pane: PaneLink;
  server: AgentServer | undefined;
  accessLog: AccessRecord[];
  registrationState: AgentState[] = [];
  /** A card the person chose to answer by voice (the Reply button, or the key held over it). */
  armed: string | null = null;
  private saveLog: ReturnType<typeof debouncedWriter>;
  private dueTimer: ReturnType<typeof setTimeout> | undefined;
  private registering: Promise<unknown> = Promise.resolve();

  constructor(private host: AgentsHost) {
    const logFile = path.join(agentsDir(host.userData), 'access-log.json');
    this.accessLog = parseAccessLog(loadJson(logFile, host.log));
    this.saveLog = debouncedWriter(logFile, () => this.accessLog);
    this.hub = new AgentHub({
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      changed: () => this.render(),
      chime: () => {
        if (host.settings().agentChime) host.chime();
      },
      log: host.log,
      status: host.status,
      pane: {
        tab: (paneId, panelId) => this.pane.tabNames(paneId, panelId),
        lastMessage: (panelId) => this.pane.lastMessage(panelId),
        inFront: () => host.paneInFront(),
        send: (panelId, text) => this.pane.send(panelId, text),
      },
      history: {
        enabled: () => host.settings().agentHistory,
        store: () => host.history(),
        record: (rec) => {
          this.accessLog = addRecord(this.accessLog, rec);
          this.saveLog.save();
          host.log('info', `agents: ${logLine(rec)}`);
        },
      },
      vocab: {
        approved: () => host.settings().vocabulary,
        pending: () => host.settings().vocabularyPending,
        add: (terms) => host.update({ vocabularyPending: [...host.settings().vocabularyPending, ...terms] }),
      },
    });
    this.hub.queue.paused = host.settings().agentAlertsPaused;
    const paneDir = process.env.PANE_DIR || path.join(os.homedir(), '.pane');
    this.pane = new PaneLink({
      paneDir,
      log: host.log,
      onEvent: (e) => void this.hub.paneEvent(actionFor(e)).catch((err) => host.log('warn', `agents: Pane event failed (${(err as Error).message})`)),
    });
  }

  async start(): Promise<void> {
    installBridge(this.host.appRoot, this.host.userData, this.host.log);
    this.server = await startAgentChannel(
      this.host.userData,
      {
        call: (session, tool, args, signal) => this.hub.call(session, tool, args, signal),
        closed: (session) => this.hub.sessionClosed(session.id),
        log: this.host.log,
      },
      this.host.log,
    );
    this.pane.start();
    void this.applyRegistration();
  }

  stop(): void {
    clearTimeout(this.dueTimer);
    this.pane.stop();
    this.server?.stop();
    this.saveLog.flush();
  }

  // ---------- the pill ----------

  /** Sends the queue to the pill, and wakes up again when an info card should fade or a hold ends. */
  render(): void {
    const now = Date.now();
    this.hub.queue.tick(now);
    const v = this.hub.queue.view(now);
    if (this.armed && !this.hub.queue.get(this.armed)) this.armed = null;
    this.host.showCards({ top: v.top ? dto(v.top) : null, more: v.more, list: v.all.map(dto) });
    clearTimeout(this.dueTimer);
    const due = this.hub.queue.nextDue(now);
    if (due !== null) this.dueTimer = setTimeout(() => this.render(), Math.max(50, due - now));
    this.host.trayChanged();
  }

  setDictating(on: boolean): void {
    this.hub.setDictating(on);
  }

  setPaused(on: boolean): void {
    this.hub.setPaused(on);
    this.host.update({ agentAlertsPaused: on });
  }

  /** The tray label: how many cards wait while alerts are paused. */
  waiting(): number {
    return this.hub.queue.waiting;
  }

  async action(a: CardAction): Promise<{ ok: boolean; message: string } | undefined> {
    const card = this.hub.queue.get(a.id);
    if (!card) return undefined;
    switch (a.action) {
      case 'dismiss':
        this.hub.dismiss(a.id);
        return undefined;
      case 'open': {
        if (!card.target) return undefined;
        this.host.allowForeground();
        const ok = await this.pane.open(card.target.paneId, card.target.panelId);
        if (ok && card.kind !== 'ask') this.hub.dismiss(a.id);
        return ok ? undefined : { ok: false, message: "Couldn't open Pane" };
      }
      case 'link':
        if (card.link) this.host.openExternal(card.link.url);
        return undefined;
      case 'review':
        this.host.openSettings('vocabulary');
        this.hub.dismiss(a.id);
        return undefined;
      case 'arm-reply':
        this.armed = a.id;
        return undefined;
      case 'choose':
        return this.deliver(card, await this.hub.choose(a.id, a.value), a.value);
      case 'consent':
        this.hub.consent(a.id, a.value);
        return undefined;
    }
  }

  /** The person's cleaned words for a card (D5). */
  async reply(cardId: string, text: string, raw: string): Promise<{ ok: boolean; message: string }> {
    const card = this.hub.queue.get(cardId);
    const r = await this.hub.reply(cardId, text, raw);
    return card ? this.deliver(card, r, text) : r;
  }

  /** A reply that didn't reach its tab: the tab opens and the words wait on the clipboard. */
  private async deliver(card: Card, r: { ok: boolean; message: string }, text: string): Promise<{ ok: boolean; message: string }> {
    if (r.ok || !card.target) return r;
    await this.host.copy(text).catch(() => undefined);
    this.host.allowForeground();
    await this.pane.open(card.target.paneId, card.target.panelId);
    return r;
  }

  // ---------- vocabulary review ----------

  approve(term: string): void {
    const s = this.host.settings();
    const r = approveTerm(s.vocabulary, s.vocabularyPending, term);
    this.host.update({ vocabulary: r.vocabulary, vocabularyPending: r.pending });
  }

  reject(term: string): void {
    this.host.update({ vocabularyPending: rejectTerm(this.host.settings().vocabularyPending, term) });
  }

  // ---------- registration ----------

  /** Writes or removes Dictate's entries per the setting. Serialised: launch and the toggle never overlap. */
  applyRegistration(): Promise<unknown> {
    const run = async () => {
      const r = this.host.registration;
      if (!r.allowed) {
        this.host.log('info', 'agents: registration skipped (not a packaged build)');
        this.registrationState = await agentStatus({ env: r.env }).catch(() => []);
        return;
      }
      const opts = { env: r.env, executable: r.executable, bridgePath: path.join(agentsDir(this.host.userData), BRIDGE_FILE), log: this.host.log };
      const outcomes = this.host.settings().agentsEnabled ? await registerAgents(opts) : await unregisterAgents(opts);
      for (const o of outcomes) if (o.action !== 'unchanged' && o.action !== 'not-found') this.host.log('info', `agents: ${o.agent} ${o.action}${o.detail ? ` (${o.detail})` : ''}`);
      this.registrationState = await agentStatus({ env: r.env }).catch(() => []);
    };
    this.registering = this.registering.then(run, run).catch((err) => this.host.log('warn', `agents: registration failed (${(err as Error).message})`));
    return this.registering;
  }

  snippets(): Snippet[] {
    return setupSnippets(serverEntry(this.host.registration.executable, path.join(agentsDir(this.host.userData), BRIDGE_FILE), false), process.platform);
  }

  // ---------- Settings → Agents ----------

  revoke(sessionId: string): void {
    this.hub.grants.revoke(sessionId);
  }

  state() {
    return {
      channel: !!this.server,
      pane: { installed: this.pane.installed, attached: this.pane.attached },
      registration: this.registrationState,
      registrationAllowed: this.host.registration.allowed,
      snippets: this.snippets(),
      sessions: [...(this.server?.sessions.values() ?? [])].map((s) => ({ id: s.id, client: s.client.title || s.client.name, inPane: !!s.pane, connectedAt: s.connectedAt })),
      grants: this.hub.grants.list(Date.now()),
      accessLog: [...this.accessLog].reverse(),
    };
  }
}
