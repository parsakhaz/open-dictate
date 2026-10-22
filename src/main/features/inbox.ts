// L2 · Inbox, flow guard, decision round and snooze. Cards wait while the person is busy (the queue's rules in
// src/core/cards.ts; the typing and busy signals come from here), a card can be snoozed from the pill, the shortcut
// or a round, and the round works through the waiting cards in the sheet right above the pill, by keys or by open
// listening. card_status reports where a card is, also an answer given after the agent's call returned.

import type { CardEnd } from '../../core/agenthub';
import { ToolInputError } from '../../core/agenttools';
import { type Card, MAX_WAIT_MS } from '../../core/cards';
import { BUSY_POLL_MS, isBusyState } from '../../core/flowguard';
import { clockTime, nextLength, parseCommand, Round, type RoundCommand, type RoundResult, summaryLine } from '../../core/round';
import { foregroundWindow, setForeground } from '../../native/platform';
import type { Feature, FeatureHost } from './host';

/** The snooze toast stays this long; pressing the shortcut again meanwhile steps to the next length. */
const TOAST_MS = 5000;
/** The round's summary stays this long, then the last action is sent and the summary goes. */
const SUMMARY_MS = 8000;
/** Open listening ends an utterance when the words stop changing for this long. */
const UTTERANCE_PAUSE_MS = 1200;
/** Open listening stops after this long with nothing said. */
const LISTEN_IDLE_MS = 30_000;
/** A question told it was snoozed still takes a late answer for this long. */
const LATE_ANSWER_MS = 8 * 60 * 60_000;
/** How often the shortcuts' claims are checked against what is on screen. */
const CLAIM_POLL_MS = 250;

const tabOf = (c: Card) => c.source.split(' · ').pop() || 'the agent';
const iso = (t: number) => new Date(t).toISOString();

/** What an answer was, as card_status gives it back: the words and picks, never anything else the wait carried. */
function answerOf(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ['text', 'choice', 'answers', 'picks', 'approved', 'changes']) if (v[k] !== undefined) out[k] = v[k];
  return Object.keys(out).length ? out : undefined;
}

class Inbox {
  private timers: ReturnType<typeof setInterval>[] = [];
  private claims = { snooze: false, round: false };
  private busyOverride: boolean | null = null;
  private toast: { id: string; minutes: number; until: number; at: number } | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private round: Round | null = null;
  /** The last action in the round, not yet sent so Undo can take it back. */
  private pending: { id: string; commit: () => Promise<unknown> } | null = null;
  private summary: { id: string; timer: ReturnType<typeof setTimeout> } | null = null;
  /** The window that had focus before the round took it. */
  private before = 0;
  private listen = { on: false, id: -1, startedAt: 0, text: '', changedAt: 0, selfStop: false };
  private heard = '';
  /** The round's cards' titles and tabs, for its summary after a card has left the queue. */
  private titles = new Map<string, { title: string; tab: string }>();
  private config = '';

  constructor(private host: FeatureHost) {}

  private get q() {
    return this.host.hub.queue;
  }

  private now(): number {
    return Date.now();
  }

  private render(): void {
    this.host.agents.render();
  }

  start(): void {
    const { host } = this;
    const hub = host.hub;
    this.q.returnTo = host.settings().snooze.returnTo;

    // ---------- the flow guard ----------
    host.onKeyDown(() => this.q.typed(this.now()));
    const probe = this.busyProbe();
    if (probe) {
      this.timers.push(
        setInterval(() => {
          const busy = this.busyOverride ?? probe();
          if (this.q.setBusy(busy, this.now())) this.render();
        }, BUSY_POLL_MS),
      );
    }
    hub.extendStatus(() => ({ focus: this.q.focus(this.now()), waiting: this.q.waiting }));

    // ---------- card_status, and how cards end ----------
    hub.handle('card_status', async (_session, args) => {
      const id = args && typeof args === 'object' ? (args as { card_id?: unknown }).card_id : undefined;
      if (typeof id !== 'string' || !id.trim()) throw new ToolInputError('card_id is required: the card_id a tool returned');
      const s = this.q.status(id.trim(), this.now());
      if (!s) return { card_id: id, state: 'unknown' };
      return { card_id: id, state: s.state, ...(s.until !== undefined ? { until: iso(s.until) } : {}), ...(s.answer !== undefined ? { answer: s.answer } : {}) };
    });
    hub.onEnded((id, how, value) => this.ended(id, how, value));

    // ---------- the pill's chips, toast and shelf ----------
    host.ipc.handle('snooze', (id, minutes) => typeof id === 'string' && typeof minutes === 'number' && this.snooze(id, minutes));
    host.ipc.handle('undo-snooze', () => this.undoSnooze());
    host.ipc.handle('now', (id) => typeof id === 'string' && this.bringBack(id));
    host.ipc.handle('drop', (id) => typeof id === 'string' && hub.dismiss(id));
    host.ipc.handle('round', () => this.startRound());
    // The pill asks when it loads; changes are pushed after that.
    host.ipc.handle('config', () => JSON.parse(this.configJson()));

    // ---------- the shortcuts ----------
    host.shortcut('snooze', { claimed: () => this.snoozeClaimed(), pressed: () => this.snoozePressed() });
    host.shortcut('round', { claimed: () => this.roundClaimed(), pressed: () => (this.round ? this.endRound('key') : this.startRound()) });
    this.timers.push(setInterval(() => this.poll(), CLAIM_POLL_MS));

    // ---------- the round ----------
    hub.cardKind('round-summary', { action: async (_card, name) => this.summaryAction(name) });
    host.ipc.handle('key', (key) => typeof key === 'string' && this.roundKey(key));
    host.ipc.handle('jump', (id) => {
      if (typeof id !== 'string' || !this.round) return;
      this.round.jump(id);
      this.showRound();
    });
    host.sheet.onClosed((kind, why) => {
      if (kind === 'round' && this.round) this.endRound(why === 'esc' ? 'esc' : 'closed');
    });
    host.replyTarget(() => {
      const id = this.round?.current();
      const c = id ? this.q.get(id) : undefined;
      return c ? { cardId: c.id, to: tabOf(c) } : null;
    });
    host.route('round', {
      label: 'Listening for your call',
      finish: 'Esc ends the round',
      began: (id) => {
        this.listen.id = id;
      },
      partial: (_id, text) => {
        if (text !== this.listen.text) {
          this.listen.text = text;
          this.listen.changedAt = this.now();
        }
      },
      cancelled: () => {
        const self = this.listen.selfStop;
        this.listen.on = false;
        this.listen.selfStop = false;
        // Esc while listening ends the round.
        if (!self && this.round) this.endRound('esc');
      },
      deliver: async (text, raw) => {
        const r = await this.utterance(text, raw);
        this.listen.on = false;
        if (this.round && !this.round.done()) setTimeout(() => this.startListening(), 600);
        return r;
      },
    });
    this.timers.push(setInterval(() => this.listenTick(), 200));

    host.qa((line) => this.qa(line));
    host.ipc.on('qa-dump', (v) => host.log('info', `QA inbox pill ${JSON.stringify(v)}`));
    host.state(() => ({ snoozed: this.q.snoozed().length, round: !!this.round }));
    this.sendConfig();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    clearTimeout(this.toastTimer);
    if (this.summary) clearTimeout(this.summary.timer);
  }

  /** Windows' busy state; nothing on macOS and Linux yet. */
  private busyProbe(): (() => boolean) | null {
    if (process.platform !== 'win32') return null;
    try {
      const w = require('../../native/win32') as typeof import('../../native/win32');
      return () => isBusyState(w.notificationState());
    } catch (err) {
      this.host.log('warn', `inbox: no busy probe (${(err as Error).message})`);
      return null;
    }
  }

  private poll(): void {
    this.q.returnTo = this.host.settings().snooze.returnTo;
    // The toast's card came back (its time, Now): pressing the shortcut again starts over at the first length.
    if (this.toast && this.q.get(this.toast.id)?.snoozedUntil === undefined) this.setToast(null);
    const snooze = this.snoozeClaimed();
    const round = this.roundClaimed();
    if (snooze !== this.claims.snooze || round !== this.claims.round) {
      this.claims = { snooze, round };
      this.host.bindingsChanged();
    }
    this.sendConfig();
  }

  private configJson(): string {
    const s = this.host.settings();
    return JSON.stringify({ lengths: s.snooze.minutes, key: s.snooze.key, roundKey: s.inbox.roundKey });
  }

  private sendConfig(): void {
    const config = this.configJson();
    if (config === this.config) return;
    this.config = config;
    this.host.pill.send('dictate:inbox:config', JSON.parse(config));
  }

  private ended(id: string, how: CardEnd, value: unknown): void {
    this.q.ended(id, how, how === 'answered' ? answerOf(value) : undefined);
    if (this.summary?.id === id) {
      clearTimeout(this.summary.timer);
      this.summary = null;
      this.commitPending();
    }
    // A card in the round answered some other way (the dictation key with open listening off): the round moves on.
    if (this.round && this.round.current() === id) {
      const seen = this.titles.get(id) ?? { title: '', tab: '' };
      const text = answerOf(value)?.text;
      this.round.act({ id, action: how === 'answered' ? 'answered' : 'skipped', ...seen, ...(typeof text === 'string' ? { text } : {}) });
      this.advance();
    } else this.round?.drop(id);
    if (this.toast?.id === id) this.setToast(null);
  }

  // ---------- snooze ----------

  private snoozeClaimed(): boolean {
    if (this.round || this.toast) return true;
    const top = this.q.view(this.now()).top;
    return !!top && top.urgency !== 'consent' && top.kind !== 'round-summary';
  }

  private snoozePressed(): void {
    const s = this.host.settings().snooze;
    if (this.round) return void this.roundCommand({ type: 'snooze', minutes: s.minutes[0] });
    if (this.toast && this.now() - this.toast.at < TOAST_MS) {
      this.snooze(this.toast.id, nextLength(s.minutes, this.toast.minutes));
      return;
    }
    const top = this.q.view(this.now()).top;
    if (top) this.snooze(top.id, s.minutes[0]);
  }

  /** Puts a card away for `minutes`. A waiting call keeps waiting if the card comes back in time; otherwise it is told now. */
  snooze(id: string, minutes: number, toast = true): boolean {
    const c = this.q.get(id);
    const now = this.now();
    const until = now + Math.round(Math.min(120, Math.max(1, minutes))) * 60_000;
    if (!c || !this.q.snooze(id, until, now)) return false;
    if (!this.host.hub.requestOwned(id) && this.host.hub.waiting(id) && until > c.createdAt + MAX_WAIT_MS) {
      this.host.hub.settle(id, { answered: false, reason: 'snoozed', until: iso(until), card_id: id }, true);
      this.lateAnswer(c);
    }
    this.host.log('info', `inbox: card ${id} snoozed for ${minutes} min`);
    if (toast) this.setToast({ id, minutes, until, at: now });
    this.render();
    return true;
  }

  /**
   * A question told it was snoozed still takes an answer: a click or the person's words settle this second wait.
   * In Pane the answer goes to the tab as a message, as voice replies do; elsewhere it waits for card_status.
   */
  private lateAnswer(c: Card): void {
    const never = new AbortController();
    void this.host.hub.wait<unknown>(c.id, { session: `inbox:${c.id}`, kind: c.kind, timeoutMs: LATE_ANSWER_MS, signal: never.signal }).then(async (v) => {
      const a = answerOf(v);
      if (!a || !c.target || (v as { answered?: unknown }).answered === false) return;
      const text = String(a.choice ?? a.text ?? '');
      if (!text) return;
      const r = await this.host.agents.pane.send(c.target.panelId, `Answer to your snoozed question “${c.title}”: ${text}`).catch(() => ({ delivered: false }));
      this.host.log(r.delivered ? 'info' : 'warn', `inbox: late answer to card ${c.id} ${r.delivered ? 'sent to its tab' : 'not delivered; card_status has it'}`);
    });
  }

  private setToast(t: Inbox['toast']): void {
    clearTimeout(this.toastTimer);
    this.toast = t;
    this.host.pill.send('dictate:inbox:toast', t ? { id: t.id, minutes: t.minutes, back: clockTime(t.until) } : null);
    if (t) this.toastTimer = setTimeout(() => this.setToast(null), TOAST_MS);
    this.host.bindingsChanged();
  }

  private undoSnooze(): void {
    const t = this.toast;
    if (!t) return;
    this.q.wake(t.id, this.now(), false);
    this.setToast(null);
    this.render();
  }

  private bringBack(id: string): void {
    if (!this.q.wake(id, this.now(), true)) this.q.unquiet(id, this.now());
    this.q.unquiet(id, this.now());
    this.render();
  }

  // ---------- the round ----------

  private roundClaimed(): boolean {
    return !!this.round || this.q.roundCards().length > 0;
  }

  startRound(): void {
    if (this.round) return;
    const cards = this.q.roundCards();
    if (!cards.length) return;
    this.commitPending();
    this.dropSummary();
    this.before = foregroundWindow();
    this.round = new Round(
      cards.map((c) => c.id),
      this.now(),
    );
    this.q.setRound(true);
    this.heard = '';
    this.host.log('info', `inbox: round started over ${cards.length} card${cards.length === 1 ? '' : 's'}`);
    this.showRound(true);
    this.startListening();
    this.render();
  }

  private showRound(open = false): void {
    const r = this.round;
    if (!r) return;
    for (const c of this.q.roundCards()) this.titles.set(c.id, { title: c.title, tab: tabOf(c) });
    r.add(this.q.roundCards().map((c) => c.id));
    const id = r.current();
    const c = id ? this.q.get(id) : undefined;
    if (!c) return void this.endRound('done');
    this.q.markShown(c.id, this.now());
    const payload = {
      position: r.position(),
      chips: r.chips().map((x) => {
        const card = this.q.get(x.id);
        return { id: x.id, state: x.state, label: card ? tabOf(card) : '' };
      }),
      card: { id: c.id, kind: c.kind, source: c.source, age: Math.max(0, Math.round((this.now() - c.createdAt) / 60_000)), title: c.title, message: c.message, choices: c.choices.slice(0, 4), canOpen: !!c.target },
      lengths: this.host.settings().snooze.minutes,
      listening: this.listen.on,
      heard: this.heard,
    };
    if (open) this.host.sheet.open('round', payload, { focus: true });
    else this.host.sheet.update(payload);
  }

  private roundKey(key: string): void {
    const s = this.host.settings().snooze;
    if (/^[1-4]$/.test(key)) this.roundCommand({ type: 'choose', n: Number(key) });
    else if (key === 'Enter') this.roundCommand({ type: 'approve' });
    else if (key === 's' || key === 'S') this.roundCommand({ type: 'snooze', minutes: s.minutes[0] });
    else if (key === 'ArrowRight') this.roundCommand({ type: 'skip' });
    else if (key === 'o' || key === 'O') this.roundCommand({ type: 'open' });
    else if (key === 'Escape') this.endRound('esc');
  }

  /** One action on the round's current card; true when it did something. */
  private roundCommand(cmd: RoundCommand): boolean {
    const r = this.round;
    const id = r?.current();
    const c = id ? this.q.get(id) : undefined;
    if (!r || !c) return false;
    const base = { id: c.id, title: c.title, tab: tabOf(c) };
    switch (cmd.type) {
      case 'choose':
      case 'approve': {
        const choice = c.choices[cmd.type === 'choose' ? cmd.n - 1 : 0];
        if (choice) {
          this.act({ ...base, action: cmd.type === 'approve' ? 'approved' : 'answered', text: choice }, () => this.host.agents.action({ id: c.id, action: 'choose', value: choice }));
          return true;
        }
        if (cmd.type === 'approve' && c.target) return this.roundCommand({ type: 'open' });
        return false;
      }
      case 'open':
        if (!c.target) return false;
        this.act({ ...base, action: 'opened' });
        void this.host.agents.action({ id: c.id, action: 'open' });
        return true;
      case 'snooze':
        if (!this.snooze(c.id, cmd.minutes, false)) return false;
        this.act({ ...base, action: 'snoozed', until: this.q.get(c.id)?.snoozedUntil });
        return true;
      case 'skip':
        this.act({ ...base, action: 'skipped' });
        return true;
      case 'end':
        this.endRound('done');
        return true;
    }
  }

  /** Records the action and moves on; an answer waits out of sight until the next action, so Undo can take it back. */
  private act(result: RoundResult, commit?: () => Promise<unknown>): void {
    this.commitPending();
    if (commit) {
      this.q.park(result.id, true, this.now());
      this.pending = { id: result.id, commit };
    }
    this.round?.act(result);
    this.advance();
  }

  private advance(): void {
    if (!this.round) return;
    this.round.add(this.q.roundCards().map((c) => c.id));
    if (this.round.done()) this.endRound('done');
    else this.showRound();
  }

  private commitPending(): void {
    const p = this.pending;
    this.pending = null;
    if (!p) return;
    this.q.park(p.id, false, this.now());
    void p.commit().catch((err) => this.host.log('warn', `inbox: a round answer failed (${(err as Error).message})`));
  }

  /** The round ends: the sheet goes and focus goes back, listening stops, and the summary shows what it did. */
  private endRound(why: 'done' | 'esc' | 'closed' | 'key'): void {
    const r = this.round;
    if (!r) return;
    this.round = null;
    this.stopListening();
    this.q.setRound(false, this.now());
    if (this.host.sheet.kind === 'round') this.host.sheet.close();
    if (this.before) setForeground(this.before);
    this.host.log('info', `inbox: round ended (${why}) after ${r.results.length} action${r.results.length === 1 ? '' : 's'}`);
    const acted = r.results.filter((x) => x.action !== 'skipped');
    if (acted.length) this.showSummary(r);
    else this.commitPending();
    this.render();
  }

  private showSummary(r: Round): void {
    this.dropSummary();
    const hub = this.host.hub;
    const id = hub.newId();
    const mins = Math.max(1, Math.round((this.now() - r.startedAt) / 60_000));
    const last = r.results[r.results.length - 1];
    hub.raise({
      id,
      key: 'round-summary',
      origin: 'dictate',
      kind: 'round-summary',
      urgency: 'info',
      source: `Decision round · ${r.results.length} card${r.results.length === 1 ? '' : 's'} · ${mins} min`,
      title: summaryLine(r.results, clockTime),
      message: '',
      choices: [],
      target: null,
      createdAt: this.now(),
      data: {
        results: r.results.map((x) => ({ action: x.action, title: x.title, tab: x.tab, ...(x.text ? { text: x.text } : {}), ...(x.until !== undefined ? { back: clockTime(x.until) } : {}) })),
        undo: last && last.action !== 'opened' && last.action !== 'skipped' ? last.action : null,
        waiting: this.q.roundCards().length,
      },
    });
    this.summary = { id, timer: setTimeout(() => this.dropSummary(), SUMMARY_MS) };
    this.undoable = r;
  }

  private undoable: Round | null = null;

  private dropSummary(): void {
    const s = this.summary;
    this.summary = null;
    if (!s) return;
    clearTimeout(s.timer);
    this.commitPending();
    this.undoable = null;
    if (this.q.remove(s.id)) this.render();
  }

  private async summaryAction(name: string): Promise<{ ok: boolean; message: string } | undefined> {
    if (name === 'done') this.dropSummary();
    else if (name === 'round') {
      this.dropSummary();
      this.startRound();
    } else if (name === 'undo') {
      const r = this.undoable;
      const last = r?.undo();
      if (last) {
        if (this.pending?.id === last.id) {
          this.q.park(last.id, false, this.now());
          this.pending = null;
        }
        if (last.action === 'snoozed') this.q.wake(last.id, this.now(), false);
        this.host.log('info', `inbox: undid ${last.action} on card ${last.id}`);
      }
      this.undoable = null;
      const s = this.summary;
      this.summary = null;
      if (s) {
        clearTimeout(s.timer);
        this.q.remove(s.id);
      }
      this.render();
      return last ? { ok: true, message: 'Undone' } : undefined;
    }
    return undefined;
  }

  // ---------- open listening ----------

  private startListening(): void {
    if (!this.round || this.listen.on || this.host.recording.active()) return;
    this.listen = { on: true, id: -1, startedAt: this.now(), text: '', changedAt: this.now(), selfStop: false };
    this.host.recording.start('round');
    this.showRound();
  }

  private stopListening(): void {
    if (!this.listen.on) return;
    this.listen.selfStop = true;
    this.listen.on = false;
    if (this.host.recording.active()) this.host.recording.cancel();
  }

  private listenTick(): void {
    const l = this.listen;
    if (!l.on || !this.round) return;
    const now = this.now();
    if (l.text.trim() && now - l.changedAt >= UTTERANCE_PAUSE_MS) {
      // The words stopped: this utterance is done (deliver reopens the mic afterwards).
      l.text = '';
      this.host.recording.stop();
    } else if (!l.text.trim() && now - l.startedAt >= LISTEN_IDLE_MS) {
      this.host.log('info', 'inbox: open listening stopped after 30 s with nothing said');
      this.stopListening();
      this.showRound();
    }
  }

  /** One utterance in a round: a command, or the answer to the current card. */
  private async utterance(text: string, raw: string): Promise<{ ok: boolean; message: string }> {
    const said = text.trim();
    this.heard = said;
    const cmd = parseCommand(said, this.host.settings().snooze.minutes) ?? parseCommand(raw, this.host.settings().snooze.minutes);
    if (cmd) {
      const ok = this.roundCommand(cmd);
      return { ok, message: ok ? `“${said}”` : `Can’t ${cmd.type} this card` };
    }
    const r = this.round;
    const id = r?.current();
    const c = id ? this.q.get(id) : undefined;
    if (!c || !said) return { ok: false, message: 'Nothing to answer' };
    if (!c.target && c.kind !== 'ask' && !this.host.hub.waiting(c.id)) return { ok: false, message: 'This card takes no answer · Enter or →' };
    this.act({ id: c.id, action: 'answered', title: c.title, tab: tabOf(c), text: said }, () => this.host.agents.reply(c.id, said, raw));
    return { ok: true, message: `Answer for ${tabOf(c)}` };
  }

  // ---------- QA ----------

  private qa(line: string): void {
    const [cmd, ...rest] = line.split(' ');
    const arg = rest.join(' ');
    const now = this.now();
    if (cmd === 'keydown') this.q.typed(now);
    else if (cmd === 'busy') {
      this.busyOverride = arg === 'on' ? true : arg === 'off' ? false : null;
      if (this.q.setBusy(!!this.busyOverride, now)) this.render();
    } else if (cmd === 'clock') {
      // Moves time forward for snoozes, in seconds.
      this.q.advance(Number(arg) * 1000);
      this.render();
    } else if (cmd === 'snooze') {
      const top = this.q.view(now).top;
      if (top) this.snooze(top.id, Number(arg) || this.host.settings().snooze.minutes[0]);
    } else if (cmd === 'shortcut') {
      if (arg === 'snooze' && this.snoozeClaimed()) this.snoozePressed();
      else if (arg === 'round' && this.roundClaimed()) (this.round ? this.endRound('key') : this.startRound());
      this.host.log('info', `QA inbox shortcut ${arg} claimed=${arg === 'snooze' ? this.snoozeClaimed() : this.roundClaimed()}`);
    } else if (cmd === 'key') this.roundKey(arg);
    else if (cmd === 'say') void this.utterance(arg, arg).then((r) => this.host.log('info', `QA inbox said ${JSON.stringify(r)}`));
    else if (cmd === 'undo') void this.summaryAction('undo');
    else if (cmd === 'pill') this.host.pill.send('dictate:inbox:qa', arg);
    else if (cmd === 'dump') this.dump();
  }

  private dump(): void {
    const now = this.now();
    const v = this.q.view(now);
    const r = this.round;
    this.host.log(
      'info',
      `QA inbox ${JSON.stringify({
        top: v.top ? { id: v.top.id, title: v.top.title, kind: v.top.kind } : null,
        extra: v.extra,
        focus: this.q.focus(now),
        round: r ? { current: r.current(), position: r.position(), results: r.results.map((x) => x.action) } : null,
        listening: this.listen.on,
        recording: this.host.recording.active(),
        sheet: { open: this.host.sheet.isOpen, kind: this.host.sheet.kind },
        toast: this.toast ? { id: this.toast.id, minutes: this.toast.minutes } : null,
        claims: { snooze: this.snoozeClaimed(), round: this.roundClaimed() },
        summary: this.summary?.id ?? null,
        foreground: foregroundWindow(),
        before: this.before,
      })}`,
    );
  }
}

let running: Inbox | null = null;

export const inbox: Feature = {
  name: 'inbox',
  setup(host) {
    running = new Inbox(host);
    running.start();
  },
  stop() {
    running?.stop();
    running = null;
  },
};
