// Coding agents reach the person through the pill. This wires the pieces together in the main process: the MCP
// bridge copied out of the bundle into the data folder (so agent configs survive updates), the local channel it
// talks to, the hub's rules, Pane through runpane, registration with Claude Code, Codex and Cursor, and the
// history access log. Electron stays with the host.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentHub, type ConsentAnswer, type SavedHub } from '../core/agenthub';
import { BRIDGE_FILE, channelPath } from '../core/agentwire';
import { type Card, takesReply } from '../core/cards';
import type { HistoryStore } from '../core/history';
import { type AccessRecord, addRecord, logLine, parseAccessLog } from '../core/historyaccess';
import { actionFor } from '../core/panewatch';
import { type Snippet, serverEntry, setupSnippets } from '../core/registration';
import type { Settings } from '../core/types';
import { approveTerm, rejectTerm } from '../core/vocabproposals';
import { AgentRequests, type SavedRequests } from './agentrequests';
import { type AgentHandlers, AgentServer } from './agentserver';
import { installCli } from './cliinstall';
import { type InstructionsFile, instructionsStatus, syncInstructions } from './instructions';
import type { Logger } from './log';
import { PaneLink } from './panelink';
import { type AgentState, agentStatus, registerAgents, unregisterAgents } from './registration';
import { debouncedWriter, loadJson, readJson } from './store';

export const agentsDir = (userData: string) => path.join(userData, 'agents');
declare const DICTATE_BUILD: string;
declare const DICTATE_VERSION: string;

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
  /** One pulse of the pill: a card an agent waits on arrived. */
  pulse(): void;
  openSettings(page: string): void;
  openExternal(url: string): void;
  copy(text: string): Promise<void>;
  /** The program in front is Pane (its executable path, when the OS says). */
  paneInFront(): boolean;
  /** Windows: let Pane take the foreground after the person's click. */
  allowForeground(): void;
  /** Registration writes real agent configs: packaged builds only, unless a test home is given. */
  registration: { allowed: boolean; executable: string; env: Record<string, string | undefined> };
  /** The tray's "Resume cards" label changed. */
  trayChanged(): void;
  /** Something Settings → Agents shows changed, such as the Pane watch attaching. */
  stateChanged(): void;
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
  /** How many times it was snoozed: the next snooze takes the next length. */
  snoozes: number;
  /** A surface card's own data, for its body (src/renderer/cards/<kind>.ts). */
  data?: unknown;
}

export interface CardsView {
  top: CardDto | null;
  more: number;
  list: CardDto[];
  /** The top card is being answered by voice right now. */
  replying: boolean;
  /** The card whose "Hold to reply" was clicked: the next dictation answers it. */
  armed?: string;
  /** The queue's summary for the pill's extras (CardView.extra). */
  extra?: Record<string, unknown>;
}

export type CardAction =
  | { id: string; action: 'open' | 'dismiss' | 'link' | 'review' | 'arm-reply' }
  | { id: string; action: 'choose'; value: string }
  | { id: string; action: 'consent'; value: ConsentAnswer }
  /** One of a surface card's own buttons: its kind's handler (AgentHub.cardKind) decides. */
  | { id: string; action: 'kind'; name: string; value?: unknown };

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
  canReply: takesReply(c),
  snoozes: c.snoozes ?? 0,
  ...(c.data !== undefined ? { data: c.data } : {}),
});

export class Agents {
  readonly requests: AgentRequests;
  readonly hub: AgentHub;
  readonly pane: PaneLink;
  server: AgentServer | undefined;
  accessLog: AccessRecord[];
  registrationState: AgentState[] = [];
  instructionsState: InstructionsFile[] = [];
  /** A card whose "Hold to reply" was clicked: the next dictation answers it, and only that one. */
  armed: string | null = null;
  /** Esc over a card: the inbox dismisses it with Undo. */
  escape: ((cardId: string) => void) | null = null;
  private sheetShows: ((top: Card | null) => boolean)[] = [];
  private saveLog: ReturnType<typeof debouncedWriter>;
  /** Waiting cards, CLI requests and card_status, kept across a restart (agents/cards.json). */
  private saveCards: ReturnType<typeof debouncedWriter>;
  private saving = true;
  private saved: { hub?: SavedHub; requests?: SavedRequests } | undefined;
  private dueTimer: ReturnType<typeof setTimeout> | undefined;
  private resumeTimer: ReturnType<typeof setTimeout> | undefined;
  private registering: Promise<unknown> = Promise.resolve();

  constructor(private host: AgentsHost) {
    const logFile = path.join(agentsDir(host.userData), 'access-log.json');
    this.accessLog = parseAccessLog(loadJson(logFile, host.log));
    this.saveLog = debouncedWriter(logFile, () => this.accessLog);
    const cardsFile = path.join(agentsDir(host.userData), 'cards.json');
    this.saved = readJson(cardsFile) as typeof this.saved;
    this.saveCards = debouncedWriter(cardsFile, () => ({ hub: this.hub.saved(), requests: this.requests.save() }));
    this.hub = new AgentHub({
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      changed: () => this.render(),
      chime: () => {
        if (host.settings().agentChime) host.chime();
      },
      pulse: () => host.pulse(),
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
    try {
      if (this.saved?.hub) this.hub.load(this.saved.hub);
    } catch (err) {
      host.log('warn', `agents: saved cards could not be read (${(err as Error).message})`);
    }
    this.requests = new AgentRequests(
      this.hub,
      { profile: host.userData, executable: host.registration.executable, build: typeof DICTATE_BUILD === 'undefined' ? 'development' : DICTATE_BUILD, version: typeof DICTATE_VERSION === 'undefined' ? 'development' : DICTATE_VERSION },
      this.saved?.requests,
      () => this.persist(),
    );
    const paneDir = process.env.PANE_DIR || path.join(os.homedir(), '.pane');
    this.pane = new PaneLink({
      paneDir,
      log: host.log,
      onAttached: () => host.stateChanged(),
      onEvent: (e) => {
        if (!host.settings().agentPaneAlerts) return;
        void this.hub.paneEvent(actionFor(e)).catch((err) => host.log('warn', `agents: Pane event failed (${(err as Error).message})`));
      },
    });
  }

  async start(): Promise<void> {
    installBridge(this.host.appRoot, this.host.userData, this.host.log);
    try { installCli(this.host.appRoot, this.host.userData, this.host.registration.executable); }
    catch { this.host.log('warn', 'agents: CLI launcher could not be installed'); }
    this.server = await startAgentChannel(
      this.host.userData,
      {
        call: (session, tool, args, signal) => this.hub.call(session, tool, args, signal),
        request: (session, op, args, signal) => this.requests.call(session, op, args, signal),
        closed: (session) => this.hub.sessionClosed(session.id),
        log: this.host.log,
      },
      this.host.log,
    );
    this.restore();
    this.applyPaneWatch();
    void this.applyRegistration();
  }

  /**
   * Follows Pane's tabs only when "Show Pane's agent alerts on the pill" is on. Off, no watch runs, so Pane sees no
   * consumer and keeps its own notifications. Agents' notify and ask don't depend on it.
   */
  applyPaneWatch(): void {
    if (this.host.settings().agentPaneAlerts) this.pane.start();
    else {
      this.pane.stop();
      this.hub.dropPaneCards();
    }
  }

  /** The cards and requests saved before the last quit come back, once the features have registered their tools. */
  private restore(): void {
    const calls = this.saved?.hub?.calls ?? [];
    this.saved = undefined;
    let n = calls.length;
    try {
      for (const c of calls) this.hub.resumeCall(c);
      n += this.requests.restore();
    } catch (err) {
      this.host.log('warn', `agents: saved cards could not come back (${(err as Error).message})`);
    }
    if (n) this.host.log('info', `agents: ${n} card${n === 1 ? '' : 's'} back from before the restart`);
  }

  private persist(): void {
    if (this.saving) this.saveCards.save();
  }

  stop(): void {
    // Saved before the channel closes, which withdraws every MCP question.
    try {
      this.saveCards.now();
    } catch (err) {
      this.host.log('warn', `agents: cards could not be saved (${(err as Error).message})`);
    }
    this.saving = false;
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
    this.hub.tickOwned();
    this.requests?.render();
    const v = this.hub.queue.view(now);
    if (this.armed && !this.hub.queue.get(this.armed)) this.armed = null;
    // A sheet showing the top card takes the pill's place: one surface, never the card and its sheet together.
    const covered = this.sheetShows.map((fn) => fn(v.top)).includes(true);
    const top = v.top && !covered ? v.top : null;
    // Under a sheet, the other cards still count as waiting.
    const extra = covered ? { ...v.extra, waiting: v.more } : v.extra;
    this.host.showCards({ top: top ? dto(top) : null, more: top ? v.more : 0, list: v.all.map(dto), replying: !!top && top.id === this.hub.queue.replyingTo, ...(this.armed ? { armed: this.armed } : {}), ...(extra ? { extra } : {}) });
    this.persist();
    clearTimeout(this.dueTimer);
    const due = this.hub.queue.nextDue(now);
    if (due !== null) this.dueTimer = setTimeout(() => this.render(), Math.max(50, due - now));
    this.host.trayChanged();
  }

  /** Asked with the pill's top card on every redraw: true when a sheet shows that card, so the pill draws none. */
  coverTop(fn: (top: Card | null) => boolean): void {
    this.sheetShows.push(fn);
  }

  /**
   * Where this dictation goes, decided at key down: the card Reply was clicked on, or the top card when the
   * pointer is over it. Null means the usual paste.
   */
  replyTarget(pointerOverCard: boolean): { cardId: string; to: string } | null {
    const armed = this.armed;
    this.armed = null;
    const v = this.hub.queue.view(Date.now());
    const card = (armed && this.hub.queue.get(armed)) || (pointerOverCard ? v.top : null);
    if (!card || !takesReply(card)) return null;
    return { cardId: card.id, to: card.source.split(' · ').pop() || 'the agent' };
  }

  /** Esc with the pointer over the card: it goes after an Undo toast (an ask returns dismissed; consent counts as deny). */
  dismissTop(): void {
    const top = this.hub.queue.view(Date.now()).top;
    if (!top) return;
    if (this.escape) this.escape(top.id);
    else this.hub.dismiss(top.id);
  }

  /** `replyTo`: the card this dictation answers; it stays on the pill until the dictation is over. */
  setDictating(on: boolean, replyTo?: string): void {
    this.hub.setDictating(on, replyTo);
  }

  /** The pointer is over the cards: info cards stop fading until it leaves. */
  setHovered(on: boolean): void {
    this.hub.queue.setHovered(on, Date.now());
    this.render();
  }

  /** Pauses cards for `minutes`, or until resumed when null; or resumes. Saved, so a pause outlives a restart. */
  setPaused(on: boolean, minutes: number | null = null): void {
    this.host.update({ agentAlertsPaused: on, agentAlertsResumeAt: on && minutes ? Date.now() + minutes * 60_000 : 0 });
  }

  /** Brings the queue and the resume timer in line with the settings; a timed pause that already ended resumes. */
  applyPause(): void {
    const { agentAlertsPaused: on, agentAlertsResumeAt: at } = this.host.settings();
    clearTimeout(this.resumeTimer);
    if (on && at && at <= Date.now()) {
      this.setPaused(false);
      return;
    }
    this.hub.setPaused(on, on && at ? at : undefined);
    if (on && at) this.resumeTimer = setTimeout(() => this.setPaused(false), Math.min(at - Date.now(), 2 ** 31 - 1));
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
        // Opening the tab ends only a Pane status card or an info note; a card an agent waits on stays.
        if (ok && (card.kind === 'pane-blocked' || card.kind === 'pane-ready' || (card.kind === 'notify' && card.urgency === 'info'))) this.hub.dismiss(a.id);
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
        this.render();
        return undefined;
      case 'choose':
        return this.deliver(card, await this.hub.choose(a.id, a.value), a.value);
      case 'consent':
        this.hub.consent(a.id, a.value);
        return undefined;
      case 'kind':
        return this.hub.cardAction(a.id, a.name, a.value);
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

  /** Writes or removes Dictate's entries and instruction blocks per the setting. Serialised: launch and the toggle never overlap. */
  applyRegistration(): Promise<unknown> {
    const run = async () => {
      const r = this.host.registration;
      if (!r.allowed) {
        this.host.log('info', 'agents: registration skipped (not a packaged build)');
        this.registrationState = await agentStatus({ env: r.env }).catch(() => []);
        this.instructionsState = instructionsStatus({ env: r.env });
        return;
      }
      const opts = { env: r.env, executable: r.executable, bridgePath: path.join(agentsDir(this.host.userData), BRIDGE_FILE), log: this.host.log };
      // The writers log each change themselves.
      const enabled = this.host.settings().agentsEnabled;
      await (enabled ? registerAgents(opts) : unregisterAgents(opts));
      syncInstructions(opts, enabled);
      this.registrationState = await agentStatus({ env: r.env }).catch(() => []);
      this.instructionsState = instructionsStatus({ env: r.env });
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
      instructions: this.instructionsState,
      registrationAllowed: this.host.registration.allowed,
      snippets: this.snippets(),
      sessions: [...(this.server?.sessions.values() ?? [])].map((s) => ({ id: s.id, client: s.client.title || s.client.name, inPane: !!s.pane, connectedAt: s.connectedAt })),
      grants: this.hub.grants.list(Date.now()),
      accessLog: [...this.accessLog].reverse(),
    };
  }
}
