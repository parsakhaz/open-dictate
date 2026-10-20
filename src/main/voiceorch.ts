// "Send to the orchestrator" (lane L3): the agent key's words, and point and say's, go to the Pane "Voice"
// Session's chat. On first use the Session is found (the id kept in settings, or one named Voice) or created; its
// chat is resumed when it is stopped; nothing is sent while its composer holds a draft. Only through runpane. No
// Electron imports.
import fs from 'node:fs';
import path from 'node:path';
import { type PaneSession, parseSession, sessionPanel } from '../core/panewatch';
import { FILE_POINTER_CHARS, VOICE_GOAL, VOICE_PROFILE, VOICE_SESSION_NAME, voiceText } from '../core/voicesession';
import type { Logger } from './log';
import type { Orchestrator, OrchestratorMessage, OrchestratorResult } from './orchestrator';

/** The part of PaneLink this uses. */
export interface VoicePane {
  readonly installed: boolean;
  run<T>(args: string[], timeoutMs?: number): Promise<T>;
  send(panelId: string, text: string, opts?: { asFilePointer?: boolean }): Promise<{ delivered: boolean; blocked?: string; state?: 'taken' | 'queued' }>;
  sessions(): Promise<PaneSession[]>;
}

export interface VoiceOrchestratorDeps {
  pane: VoicePane;
  /** settings.voice.sessionId, and saving it. */
  sessionId(): string | null;
  saveSessionId(id: string | null): void;
  /** Where the Session's create payload is written for a moment (runpane reads it with --from-json). */
  tempDir: string;
  log: Logger;
  /** The first send waits on Pane starting the Session's agent: the pill says so. */
  progress?(message: string): void;
}

/** What Settings shows: the Session the key talks to, and how the last send went. */
export interface VoiceStatus {
  installed: boolean;
  session: { id: string; name: string } | null;
  last: { at: number; result: OrchestratorResult } | null;
}

interface Screen {
  state?: { running?: boolean; initialized?: boolean };
  composer?: { isPresent?: boolean; hasUndeliveredText?: boolean };
}

const MS = { create: 30_000, resume: 60_000, readyWait: 45_000 };

export class VoiceOrchestrator implements Orchestrator {
  private chain: Promise<unknown> = Promise.resolve();
  private known: PaneSession | null = null;
  last: VoiceStatus['last'] = null;

  constructor(private deps: VoiceOrchestratorDeps) {}

  available(): boolean {
    return this.deps.pane.installed;
  }

  status(): VoiceStatus {
    const id = this.deps.sessionId();
    const s = this.known && this.known.id === id ? this.known : null;
    return { installed: this.deps.pane.installed, session: id ? { id, name: s?.name || VOICE_SESSION_NAME } : null, last: this.last };
  }

  /** Forget the Session (Settings' Start over): the next send finds or creates one again. Pane keeps it. */
  forget(): void {
    this.known = null;
    this.deps.saveSessionId(null);
  }

  /** One at a time: a second instruction waits for the first, so the Session is created once. */
  send(m: OrchestratorMessage): Promise<OrchestratorResult> {
    const run = this.chain.then(() => this.sendNow(m));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async sendNow(m: OrchestratorMessage): Promise<OrchestratorResult> {
    const result = await this.attempt(m).catch((err): OrchestratorResult => ({ delivered: false, blocked: 'error', message: (err as Error).message }));
    this.last = { at: Date.now(), result };
    this.deps.log(result.delivered ? 'info' : 'warn', `voice: ${result.delivered ? `sent to the orchestrator (${result.state})` : `not sent (${result.blocked}${result.message ? `: ${result.message}` : ''})`}`);
    return result;
  }

  private async attempt(m: OrchestratorMessage): Promise<OrchestratorResult> {
    if (!this.deps.pane.installed) return { delivered: false, blocked: 'pane-missing', message: 'Pane isn’t installed' };
    const session = await this.session();
    const panel = sessionPanel(session);
    if (!panel) return { delivered: false, blocked: 'not-running', message: 'The Voice Session has no chat' };
    let screen = await this.screen(panel);
    if (!screen?.state?.running) {
      this.deps.progress?.('Starting the Voice orchestrator…');
      await this.deps.pane.run(['panels', 'resume', '--panel', panel, '--wait-ready', '--ready-timeout-ms', String(MS.readyWait), '--yes'], MS.resume);
      screen = await this.screen(panel);
      if (!screen?.state?.running) return { delivered: false, blocked: 'not-running', message: 'The Voice orchestrator didn’t start' };
    }
    if (screen.composer?.hasUndeliveredText) return { delivered: false, blocked: 'draft', message: 'Voice has a draft' };
    const text = voiceText(m.via, m.text);
    const r = await this.deps.pane.send(panel, text, { asFilePointer: m.asFilePointer || text.length > FILE_POINTER_CHARS });
    if (r.delivered) return { delivered: true, state: r.state ?? 'taken' };
    return { delivered: false, blocked: 'error', message: r.blocked || 'Pane didn’t take it' };
  }

  private async screen(panel: string): Promise<Screen | null> {
    try {
      return await this.deps.pane.run<Screen>(['panels', 'screen', '--panel', panel, '--limit', '5']);
    } catch {
      return null;
    }
  }

  /** The Session kept in settings; else the person's Session named Voice; else a new one. Archived ones don't count. */
  private async session(): Promise<PaneSession> {
    const id = this.deps.sessionId();
    if (this.known && this.known.id === id) return this.known;
    const all = await this.deps.pane.sessions();
    const found = (id ? all.find((s) => s.id === id && !s.archived) : undefined) ?? all.find((s) => s.name === VOICE_SESSION_NAME && !s.archived) ?? (await this.create());
    this.known = found;
    if (found.id !== id) this.deps.saveSessionId(found.id);
    return found;
  }

  private async create(): Promise<PaneSession> {
    this.deps.progress?.('Creating the Voice Session in Pane…');
    fs.mkdirSync(this.deps.tempDir, { recursive: true });
    const file = path.join(this.deps.tempDir, `voice-session-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify({ name: VOICE_SESSION_NAME, goal: VOICE_GOAL, profile: VOICE_PROFILE, agent: 'claude' }));
    try {
      const r = await this.deps.pane.run<{ session?: unknown }>(['sessions', 'create', '--from-json', file], MS.create);
      const s = parseSession(r.session);
      if (!s) throw new Error('Pane didn’t return the new Session');
      this.deps.log('info', `voice: created the Pane Session "${s.name}" (${s.id})`);
      return s;
    } finally {
      fs.rmSync(file, { force: true });
    }
  }
}
