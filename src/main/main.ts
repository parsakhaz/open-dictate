// dictate: a tray app. Hold Right Ctrl (or double-tap it) and speak; on release the words are transcribed
// locally, cleaned by local LLMs and typed into the focused app.
import fs from 'node:fs';
import path from 'node:path';
import { app, globalShortcut, ipcMain, Menu, MessageChannelMain, powerMonitor, screen, session, shell, systemPreferences, Tray, type UtilityProcess, utilityProcess } from 'electron';
import { gainSpec, type GainSpec } from '../core/agc';
import { dbfs } from '../core/audio';
import { CaptureController, type CaptureEvents } from '../core/capture';
import { runChain } from '../core/chain';
import { HistoryStore } from '../core/history';
import { type Bindings, bindingFromKeys, bindingLabel, type HotkeyAction, HotkeyMachine, isModifier, menuMaskCombos, menuMaskKeys, type RecordMode, swallowBindings, VK } from '../core/hotkeys';
import { type CardBox, type CardPointer, inRect, nextCardPointer } from '../core/cardpointer';
import { isSheetKind } from '../core/sheetkinds';
import { DEFAULT_SEGMENTER, LiveCleanup, Segmenter } from '../core/live';
import { deviceLabelFor, type MicDevice, type MicEvent, MicSelector, micKey, micName } from '../core/mics';
import { appliesMeasuredChain, keepsLlamaServer, upgradedOnboarded } from '../core/onboarding';
import { finishHint } from '../core/pillhint';
import { applyEnv, GEMMA_GGUF, parseSettings, resolveModelsDir, STT_MODEL } from '../core/settings';
import type { Binding, Settings } from '../core/types';
import { parseVocabularyFile } from '../core/vocabulary';
import { WarmMic } from '../core/warm';
import type { SttToMain } from '../engine/stt-worker';
import type { FromHook } from '../native/keyhook-worker';
import { accessibilityGranted, allowForegroundHandoff, batterySaverOn, caretRect, foregroundProcessPath, foregroundWindow, isWindow, killWithUs, platformCapabilities, requestAccessibility, setForeground, writeClipboardText } from '../native/platform';
import { type CapturePath, CaptureRouter } from './capture';
import { Cleanup } from './cleanup';
import { migratePlatformSettings, runtimeDefaults } from './config';
import { applyAutostart } from './startup';
import { runHardwareCheck } from './hardware';
import { type UpdateEngine, Updater } from './updater';
import { updateMode } from '../core/updates';
import { assetsFor, essentialsInstalled, SetupManager, speechInstalled } from './setup';
import { runSmoke } from './smoke';
import { type TrayState, trayIcon } from './icons';
import { KeyHook } from './keyhook';
import { fileLogger } from './log';
import { focusForPaste } from './focus';
import { NativeMic } from './nativemic';
import { realPasteSink } from './output';
import type { PasteSink } from './paste';
import { type PickRequest, pickFromHistory } from './pick';
import { PickerController, type PickerWindow } from './picker';
import { type Delivery, finishDictation, type OutputSink } from './pipeline';
import { debouncedWriter, loadJson, readJson, writeJson } from './store';
import { SttLink } from './sttlink';
import { createPicker, createPill, createSettings, placePicker, showPill } from './windows';
import { Agents, type AgentsHost, type CardAction } from './agents';
import { syncInstructions } from './instructions';
import { unregisterAgents } from './registration';
import { FEATURES } from './features';
import { Sheet } from './sheet';
import { Surfaces } from './surfaces';

/** The uninstaller's flag: remove Dictate's agent setup and quit. */
const REMOVE_AGENT_SETUP = '--remove-agent-setup';

if (process.env.DICTATE_DATA_DIR) app.setPath('userData', process.env.DICTATE_DATA_DIR);
app.setName('dictate');
if (process.platform === 'win32') app.setAppUserModelId('org.dictate.Dictate');
if (process.platform === 'linux') app.setDesktopName('org.dictate.Dictate');
// Headless runners may expose a GPU device without a functioning compositor. Keep screenshot QA deterministic.
if (process.env.DICTATE_SMOKE_TEST) app.disableHardwareAcceleration();
// What the surface features must set up before the app is ready (a privileged protocol scheme).
for (const f of FEATURES) f.beforeReady?.();

// The isolated container used for local QA forbids AF_UNIX sockets. Native CI keeps the real lock enabled.
const isolatedQa = !!process.env.DICTATE_DATA_DIR && (!!process.env.DICTATE_SMOKE_TEST || !!process.env.DICTATE_QA_CONTROL);
const skipInstanceLock = isolatedQa && process.env.DICTATE_SMOKE_SKIP_INSTANCE_LOCK === '1';
if (process.argv.includes(REMOVE_AGENT_SETUP)) {
  // Run by the Windows uninstaller (build/installer.nsh): takes Dictate back out of the agents' files, then quits.
  void app.whenReady().then(removeAgentSetup).catch((err) => log('warn', `agents: removal failed (${(err as Error).message})`)).finally(() => app.exit(0));
} else if (!skipInstanceLock && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openSettings());
  void app.whenReady().then(async () => {
    await main();
    if (process.env.DICTATE_SMOKE_TEST) await runSmoke(process.env.DICTATE_SMOKE_TEST);
  }).catch((err) => {
    log('error', `start-up failed: ${(err as Error).stack}`);
    app.exit(1);
  });
}

const userData = () => app.getPath('userData');
const log = fileLogger(path.join(app.getPath('userData'), 'logs', 'dictate.log'));
const appRoot = () => app.getAppPath();

let settings: Settings;
let history: HistoryStore;
let saveSettings: ReturnType<typeof debouncedWriter>;
let saveHistory: ReturnType<typeof debouncedWriter>;
let cleanup: Cleanup;
let sink: PasteSink;
let machine: HotkeyMachine;
let hook: KeyHook;
let mics: MicSelector;
let tray: Tray | undefined;
let pill: Electron.BrowserWindow;
let settingsWin: Electron.BrowserWindow | undefined;
let stt: UtilityProcess | undefined;
let sttReady = false;
let sttError = '';
let quitting = false;
let defaultMicLabel = '';
let devicesSeen = false;
let fakeWav: Uint8Array | undefined;
/** Native (WASAPI) capture, when it started; recordings fall back to the pill's browser capture otherwise. */
let nativeMic: NativeMic | undefined;
let nativeCapture: CaptureController | undefined;
let nativeOk = false;
let router: CaptureRouter;
let warm: WarmMic;
/** Main's own audio port to the recognizer, for native capture. */
let mainSttPort: Electron.MessagePortMain | undefined;
/** Key-down time (timeOrigin-based) of the recording being started, for key-down-to-first-audio timing. */
let keyDownAt = 0;
/** The open native mic is a Bluetooth headset: holding it open keeps the headset in its call profile. */
let micBluetooth = false;
const setup = new SetupManager();
let shortcutRegistered = false;
let shortcutRequested = false;
let startupError = '';
let hardwareRunning = false;
let updater: Updater | undefined;
/** When the last dictation, download or speed check ended: auto-update installs only after 10 idle minutes. */
let lastActivityAt = Date.now();
let hardwareError = '';
/** Getting started's "Try it" box is open: a dictation made while Settings is in front lands there. */
let practicing = false;
/** A page the tray asked for before the Settings window had loaded. */
let pendingPage: string | null = null;
const pasteKeys = process.platform === 'darwin' ? 'Cmd+V' : 'Ctrl+V';

// ---------- dictation session ----------

interface Session {
  id: number;
  mode: RecordMode | null;
  shown: boolean;
  releasedAt: number;
  partial: string;
  recognizerActive?: boolean;
  /** Audio is arriving: the pill's meter is live and the start cue has played (or will, once shown). */
  live: boolean;
  /** Live cleanup ("Clean up as I speak"): sentences split off the streaming transcript and cleaned early. */
  segmenter?: Segmenter;
  cleaner?: LiveCleanup;
  final?: (text: string) => void;
  /** Esc after release (transcribing or cleaning): stops the cleanup, and nothing is pasted. */
  abort: AbortController;
  /** This dictation answers an agent's card instead of pasting (the key went down over the card, or Reply). */
  reply?: { cardId: string; to: string };
  /** A surface's route takes the words instead (the agent key, the point key, open listening). */
  route?: string;
}

let nextId = 1;
/** The recording in progress, if any. */
let rec: Session | null = null;
/** Sessions past key release, waiting on their final. */
const finishing = new Map<number, Session>();
/** Sessions past key release that Esc can still cancel: until their text starts going out. */
const cancellable = new Set<Session>();

/** The hook swallows Esc while it cancels something: a recording, or a dictation still transcribing or cleaning. */
function syncEsc(): void {
  hook.send({ type: 'recording', on: !!rec || cancellable.size > 0 || !!replyPreview });
}

/** The 2 s look at a reply before it goes to an agent; Esc cancels it. */
let replyPreview: { cancel: () => void } | null = null;

function previewReply(to: string, text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const end = (send: boolean) => {
      clearTimeout(timer);
      replyPreview = null;
      syncEsc();
      resolve(send);
    };
    const timer = setTimeout(() => end(true), 2000);
    replyPreview = { cancel: () => end(false) };
    syncEsc();
    // A leading / ! # @ may read as a command to the agent.
    pillSend('dictate:pill', { kind: 'reply-preview', message: text, to, warn: /^[/!#@]/.test(text) });
    showPill(pill);
  });
}

/** Where the top card reaches in the pill window (CSS pixels), and how tall its head is, from the renderer. */
let cardRect: CardBox | null = null;
/** The top card's id, to open it under the pointer and start the next one closed. */
let topCardId: string | null = null;

/** QA: the centre of the card button with this label (or of what a ".selector" finds), in the pill page's CSS pixels. */
async function qaButtonAt(label: string): Promise<{ x: number; y: number } | null> {
  return (await pill.webContents.executeJavaScript(`(() => {
    const l = ${JSON.stringify(label)};
    const b = l.startsWith('.') ? document.querySelector('.cards ' + l) : [...document.querySelectorAll('.cards button')].find((x) => x.textContent === l);
    const r = b && b.getBoundingClientRect();
    return r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null;
  })()`)) as { x: number; y: number } | null;
}

/** QA: a click where the stand-in pointer is, as the window would get it: none at all while it lets clicks through. */
async function qaPointerClick(): Promise<void> {
  const at = qaPointer;
  if (!at) {
    log('info', `QA pointer-click ${JSON.stringify({ at, hit: at ? 'passed through' : 'no pointer' })}`);
    return;
  }
  const hit = (await pill.webContents.executeJavaScript(`(() => {
    const e = document.elementFromPoint(${at.x}, ${at.y});
    return e ? (e.textContent && e.tagName === 'BUTTON' ? 'button ' + e.textContent : e.tagName.toLowerCase() + '.' + e.className) : 'nothing';
  })()`)) as string;
  pill.webContents.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
  pill.webContents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
  pill.webContents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
  log('info', `QA pointer-click ${JSON.stringify({ at, hit })}`);
}

/** QA: finds a card button by its label, logs what is under its centre, and clicks there with page input events. */
async function qaCardClick(label: string, click: boolean): Promise<void> {
  const at = (await pill.webContents.executeJavaScript(`(() => {
    const b = [...document.querySelectorAll('.cards button')].find((x) => x.textContent === ${JSON.stringify(label)});
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    return { x, y, hit: hit && (hit === b || b.contains(hit)) ? 'button' : hit ? hit.tagName.toLowerCase() + '.' + hit.className : 'nothing' };
  })()`)) as { x: number; y: number; hit: string } | null;
  if (!click) {
    const b = pill.getBounds();
    log('info', `QA card-locate ${JSON.stringify(label)} ${JSON.stringify(at && screen.dipToScreenPoint({ x: b.x + at.x, y: b.y + at.y }))}`);
    return;
  }
  log('info', `QA card-click ${JSON.stringify(label)} ${JSON.stringify(at)}`);
  if (!at) return;
  pill.webContents.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
  pill.webContents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
  pill.webContents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
}

type Rect = { x: number; y: number; width: number; height: number };
/** The pill's extras' clickable areas (the inbox badge, its shelf), from the renderer, in the same CSS pixels. */
let extraRects: Rect[] = [];
let extraHover = false;

/** QA: a pointer in the pill page's CSS pixels, standing in for the OS pointer (which QA never moves). */
let qaPointer: { x: number; y: number } | null = null;

/** The pointer in the pill page's CSS pixels. */
function pointerAt(): { x: number; y: number } | null {
  if (pill.isDestroyed()) return null;
  if (qaPointer) return qaPointer;
  const p = screen.getCursorScreenPoint();
  const b = pill.getBounds();
  return { x: p.x - b.x, y: p.y - b.y };
}

function pointerIn(r: Rect): boolean {
  const p = pointerAt();
  return !!p && inRect(p, r);
}

function pointerOverCard(): boolean {
  return cardsShown && !!cardRect && pointerIn(cardRect);
}

let cardPointer: CardPointer = { over: false, openFor: null };

/**
 * The pill is click-through except over a card (and an Undo toast). Main watches the pointer itself while cards are
 * up: on Windows a click-through window gets no forwarded pointer moves, so the page never learns it is hovered and
 * the window would never start taking clicks (issue #9).
 */
let cardHover = false;
/** The top card is open under the pointer, showing its buttons. */
let cardOpen = false;
/** QA: hovered without a mouse. */
let qaCardHover = false;
let hoverPoll: ReturnType<typeof setInterval> | undefined;

function pollCardHover(): void {
  const overExtra = extraRects.some(pointerIn);
  if (overExtra !== extraHover) {
    extraHover = overExtra;
  }
  cardPointer = nextCardPointer(cardPointer, cardsShown ? topCardId : null, cardRect, pointerAt(), qaCardHover);
  if (cardPointer.over !== cardHover) {
    cardHover = cardPointer.over;
    agents?.setHovered(cardHover);
  }
  const open = cardPointer.openFor !== null;
  if (open === cardOpen) return;
  cardOpen = open;
  pillSend('dictate:card-hover', open);
}

function watchCardHover(on: boolean): void {
  if (on && !hoverPoll) hoverPoll = setInterval(pollCardHover, 40);
  if (!on && hoverPoll) {
    clearInterval(hoverPoll);
    hoverPoll = undefined;
  }
  pollCardHover();
}

/** Esc after release: every dictation still transcribing or cleaning stops, and nothing of it is pasted. */
function cancelAfterRelease(): void {
  for (const s of cancellable) {
    s.abort.abort();
    s.cleaner?.cancel();
    s.final?.('');
  }
  cancellable.clear();
  syncEsc();
}
let trayState: TrayState = 'loading';

function setTray(s: TrayState): void {
  trayState = s;
  tray?.setImage(trayIcon(s));
  tray?.setToolTip(`dictate · ${trayTooltip()}`);
}

function trayTooltip(): string {
  if (trayState === 'loading') return 'loading models…';
  if (trayState === 'recording') return 'listening';
  if (trayState === 'processing') return 'transcribing';
  if (trayState === 'error') return sttError || 'error';
  return `hold ${hotkeyLabel()} to dictate`;
}

/** The first dictation key's name, or another one's: what the tray, the welcome page and the hints call it. */
function hotkeyLabel(i = 0): string {
  return bindingLabel(settings.hotkeys[i] ?? null);
}

function idleTray(): void {
  if (rec || finishing.size) return;
  agents?.setDictating(false);
  setTray(!sttReady ? (sttError ? 'error' : 'loading') : 'idle');
  lastActivityAt = Date.now();
  updater?.activity();
}

function pillSend(channel: string, ...args: unknown[]): void {
  if (!pill.isDestroyed()) pill.webContents.send(channel, ...args);
  if (channel === 'dictate:pill') pillShot(args[0] as { kind: string; mode?: string });
}

/** The pill's look: the comparison variant (QA), and whether it shows the live words. */
function pillConfig(): void {
  const v = process.env.DICTATE_PILL_VARIANT;
  pillSend('dictate:pill-config', { variant: v === 'b' || v === 'c' ? v : 'a', showText: settings.pillText });
}

/** QA (DICTATE_PILL_SHOTS=<dir>): a PNG of the real pill window on each state change, and on request. */
const shotDir = process.env.DICTATE_PILL_SHOTS;
function pillShot(s: { kind: string; mode?: string; starting?: boolean } | string, delay = 380): void {
  if (!shotDir || !pill || pill.isDestroyed()) return;
  const name = typeof s === 'string' ? s : `${s.kind}${s.mode === 'toggle' ? '-handsfree' : ''}${s.starting ? '-starting' : ''}`;
  setTimeout(() => {
    void pill.webContents.capturePage().then((img) => {
      const v = process.env.DICTATE_PILL_VARIANT ?? 'a';
      fs.mkdirSync(shotDir, { recursive: true });
      fs.writeFileSync(path.join(shotDir, `${v}-${name}.png`), img.toPNG());
    });
  }, delay);
}

function sound(cue: 'start' | 'stop' | 'cancel' | 'error'): void {
  if (settings.sounds) pillSend('dictate:sound', cue);
}

function micDevice(): MicDevice | null {
  return mics.current;
}

function gainFor(d: MicDevice | null): GainSpec {
  return gainSpec(settings, d?.label ?? defaultMicLabel);
}

/** A dictation ended with automatic gain at `gainDb` on mic `label`: the next one on that mic starts there. */
function rememberGain(id: number, label: string, gainDb: number): void {
  if (!settings.autoGain || !label) return;
  // Native capture reports the WASAPI name; gainFor looks the mic up by its listed (browser) label.
  const key = micKey(deviceLabelFor(label, devicesCache));
  const db = Math.round(gainDb * 10) / 10;
  log('info', `capture ${id}: automatic gain ended at ${db > 0 ? '+' : ''}${db} dB`);
  if (Math.abs((settings.agcGainDb[key] ?? Number.NaN) - db) < 0.5) return;
  updateSettings({ agcGainDb: { ...settings.agcGainDb, [key]: db } });
}

function onHotkey(a: HotkeyAction): void {
  switch (a.type) {
    case 'start':
      startRecording(a.route);
      return;
    case 'mode': {
      if (!rec) return;
      const first = rec.mode === null;
      rec.mode = a.mode;
      if (!sttReady) {
        pillSend('dictate:pill', { kind: 'error', message: sttError ? `Speech model failed: ${sttError}` : 'Still loading the speech model…' });
        showPill(pill);
        rec = null;
        machine.reset();
        syncEsc();
        return;
      }
      // Until the mic delivers audio the meter is grey and flat, and the start cue waits for it.
      const route = surfaces?.route(rec.route);
      const finish = route?.finish ?? finishHint(a.mode, a.via, { hotkey: hotkeyLabel(a.key), toggle: bindingLabel(settings.toggle) });
      const routeLabel = route?.label;
      pillSend('dictate:pill', cleanup.warming() ? { kind: 'warming', finish } : { kind: 'listening', mode: a.mode, finish, starting: !rec.live, replyTo: rec.reply?.to, ...(rec.route ? { route: rec.route, routeLabel } : {}) });
      showPill(pill);
      rec.shown = true;
      if (first && rec.live) sound('start');
      setTray('recording');
      return;
    }
    case 'stop':
      return void stopRecording();
    case 'cancel': {
      const s = rec;
      rec = null;
      syncEsc();
      if (!s) return;
      router.cancel(s.id);
      stopLiveCleanup(s, true);
      surfaces?.route(s.route)?.cancelled?.(s.id);
      if (a.reason === 'escape' && s.shown) {
        sound('cancel');
        pillSend('dictate:pill', { kind: 'info', message: 'Cancelled' });
      } else if (s.shown) pillSend('dictate:pill', { kind: 'hidden' });
      applyPendingMicSwitch();
      idleTray();
      return;
    }
    case 'picker':
      void picker.open();
      return;
    case 'shortcut':
      surfaces?.shortcutPressed(a.name);
      return;
  }
}

/** Key down (or a surface's open listening): capture starts at once; the pill waits until it is a hold or a double-tap. */
function startRecording(route?: string): void {
  if (rec) return;
  if (!sttReady) {
    // Show why nothing happens, but only for a real press (mode), not a tap.
    rec = { id: nextId++, mode: null, shown: false, releasedAt: 0, partial: '', live: false, abort: new AbortController(), route };
    return;
  }
  rec = { id: nextId++, mode: null, shown: false, releasedAt: 0, partial: '', live: false, abort: new AbortController(), route };
  // The pointer over a card at key down (or Reply) sends this one dictation to it; a route's words never answer a card.
  rec.reply = route ? undefined : (surfaces?.replyTarget() ?? agents?.replyTarget(pointerOverCard()) ?? undefined);
  agents?.setDictating(true, rec.reply?.cardId);
  surfaces?.route(route)?.began?.(rec.id);
  cleanup.touch();
  // Capture starts at key down so the first word is not lost; the pill waits until this is a hold or a double-tap.
  keyDownAt = performance.timeOrigin + performance.now();
  router.start(rec.id, micDevice()?.deviceId ?? null, gainFor(micDevice()));
  startLiveCleanup(rec);
  pillSend('dictate:enumerate');
  syncEsc();
}

/** Esc after release: the session ends quietly, with nothing pasted. */
function cancelled(s: Session, when: string): void {
  log('info', `dictation ${s.id}: cancelled with Esc while ${when}`);
  sound('cancel');
  pillSend('dictate:pill', { kind: 'info', message: 'Cancelled' });
  idleTray();
}

async function stopRecording(): Promise<void> {
  const s = rec;
  rec = null;
  if (!s || !sttReady) return syncEsc();
  s.releasedAt = performance.now();
  finishing.set(s.id, s);
  cancellable.add(s);
  syncEsc();
  sound('stop');
  setTray('processing');
  pillSend('dictate:pill', { kind: 'transcribing' });
  const final = new Promise<string>((resolve) => {
    s.final = resolve;
    // A recognizer that never answers must not hang the session: use the last partial.
    setTimeout(() => resolve(s.partial), 6000);
  });
  router.stop(s.id);
  const raw = await final;
  stopLiveCleanup(s, false);
  finishing.delete(s.id);
  applyPendingMicSwitch();
  const sttMs = performance.now() - s.releasedAt;
  if (s.abort.signal.aborted) return cancelled(s, 'transcribing');
  if (!raw.trim()) {
    cancellable.delete(s);
    syncEsc();
    log('info', `dictation ${s.id}: nothing heard (${sttMs.toFixed(0)} ms)`);
    pillSend('dictate:pill', { kind: 'info', message: 'Didn’t catch that' });
    return idleTray();
  }
  pillSend('dictate:partial', raw);
  const live = s.cleaner;
  const clean = live
    ? async (heard: string) => {
        try {
          const r = await live.finish(heard);
          log('info', `live cleanup ${s.id}: ${r.early} sentence${r.early === 1 ? '' : 's'} cleaned while speaking, ${r.redone} redone after a revision`);
          return r;
        } catch (err) {
          if (s.abort.signal.aborted) return { text: heard, steps: [] };
          log('warn', `live cleanup ${s.id} failed (${(err as Error).message}); cleaning the whole dictation`);
          return runChain(heard, cleanup.steps(), cleanup.deps(), { signal: s.abort.signal });
        }
      }
    : undefined;
  const practice = practicing && !!settingsWin && !settingsWin.isDestroyed() && settingsWin.isFocused();
  const reply = !practice ? s.reply : undefined;
  // A route key's words (or open listening's) go to its feature, never into the app in front.
  const routed = !practice && !!s.route;
  const route = routed ? surfaces?.route(s.route) : undefined;
  let replied: { ok: boolean; message: string } | undefined;
  // A reply: cleaned and kept in history as usual, then previewed, then sent to the card instead of pasted. A route
  // previews or reviews the words itself.
  const replySink: OutputSink = {
    deliver: async (text): Promise<Delivery> => {
      const t = text.trim();
      if (routed) replied = route ? await route.deliver(t, raw, s.id) : { ok: false, message: 'Nowhere to send it' };
      else {
        if (!reply || !agents || !(await previewReply(reply.to, t))) return { pasted: false, copied: false, reason: 'reply cancelled' };
        replied = await agents.reply(reply.cardId, t, raw);
      }
      return replied.ok ? { pasted: true, copied: false, confirmed: true } : { pasted: false, copied: true, reason: replied.message };
    },
  };
  const deps = { chain: cleanup.deps(), sink: practice ? practiceSink : reply || routed ? replySink : sink, history, saveHistory: () => saveHistory.now(), log, clean, pressEnter: settings.pressEnter, signal: s.abort.signal };
  const result = await finishDictation(raw, cleanup.steps(), settings.output, s.releasedAt, deps, (phase) => {
    if (phase === 'cleaning') pillSend('dictate:pill', { kind: 'cleaning' });
    else {
      // The text is going out: too late for Esc.
      cancellable.delete(s);
      syncEsc();
    }
  });
  cancellable.delete(s);
  syncEsc();
  if (result.cancelled) return cancelled(s, 'cleaning');
  if (practice && result.entry) {
    const e = result.entry;
    settingsWin?.webContents.send('dictate:practice-result', { raw: e.raw, text: e.text, ms: e.ms ?? null, cleaned: result.steps.some((x) => x.status === 'ok') });
  }
  log('info', `dictation ${s.id}: final after ${sttMs.toFixed(0)} ms`);
  const d = result.delivery;
  if (reply || routed) {
    if (replied) pillSend('dictate:pill', replied.ok ? { kind: 'done', message: replied.message } : { kind: 'copied', message: replied.message });
    else pillSend('dictate:pill', { kind: 'info', message: 'Cancelled · nothing sent' });
    pushState();
    rebuildTrayMenu();
    return idleTray();
  }
  if (d?.pasted && d.confirmed === false) pillSend('dictate:pill', { kind: 'copied', message: 'Pasted · also on the clipboard' });
  else if (d?.pasted) pillSend('dictate:pill', { kind: 'done', message: `${settings.output === 'both' ? 'Pasted and copied' : 'Pasted'}${d.entered ? ' · Enter' : ''}` });
  else if (d?.copied) pillSend('dictate:pill', { kind: 'copied', message: settings.output === 'clipboard' ? 'Copied' : `Copied · press ${pasteKeys}` });
  else pillSend('dictate:pill', { kind: 'error', message: `Couldn’t paste · it’s in History (${bindingLabel(settings.picker)})` });
  pushState();
  rebuildTrayMenu();
  idleTray();
}

// ---------- recognizer ----------

function startStt(): void {
  sttReady = false;
  sttError = '';
  const models = resolveModelsDir(settings.modelsDir, fs.existsSync);
  const dir = path.join(models, STT_MODEL);
  if (!speechInstalled(models)) {
    sttError = `speech model missing or incomplete at ${dir}. Use Download speech model in Settings to install or repair it.`;
    log('error', sttError);
    setTray('error');
    return;
  }
  const child = utilityProcess.fork(path.join(appRoot(), 'out', 'engine', 'stt-worker.js'), [], { serviceName: 'dictate speech recognizer', stdio: 'pipe' });
  stt = child;
  child.stderr?.on('data', (d) => log('warn', `stt: ${String(d).trim()}`));
  child.on('message', (m: SttToMain) => {
    if (m.type === 'ready') {
      sttReady = true;
      log('info', `speech model loaded in ${(m.loadMs / 1000).toFixed(2)} s (${settings.sttThreads} threads)`);
      idleTray();
      pushState();
    } else if (m.type === 'error') {
      log('error', `stt: ${m.message}`);
      if (!sttReady) {
        sttError = m.message;
        setTray('error');
        pushState();
      }
    } else if (m.type === 'partial') {
      const s = rec?.id === m.id ? rec : finishing.get(m.id);
      if (!s) return;
      if (m.text && !s.recognizerActive) {
        s.recognizerActive = true;
        log('info', `stt partial ${m.id}: recognizer activity`);
      }
      s.partial = m.text;
      surfaces?.route(s.route)?.partial?.(s.id, m.text);
      if (s.segmenter && s.cleaner) {
        const committed = s.segmenter.update(m.text, performance.now());
        s.cleaner.revised(s.segmenter.takeRevised());
        s.cleaner.committed(committed);
      }
      pillSend('dictate:partial', m.text);
    } else if (m.type === 'cancelled') {
      log('info', `stt cancelled ${m.id}: ${m.audioMs.toFixed(0)} ms audio discarded`);
    } else if (m.type === 'final') {
      const s = finishing.get(m.id);
      log('info', `stt final ${m.id}: ${m.audioMs.toFixed(0)} ms audio, flush ${m.flushMs.toFixed(0)} ms`);
      s?.final?.(m.text);
    }
  });
  child.on('exit', (code) => {
    if (stt !== child) return;
    stt = undefined;
    sttLink.setWorker(undefined);
    sttReady = false;
    if (quitting) return;
    log('error', `speech recognizer exited (${code}); restarting`);
    setTray('error');
    setTimeout(startStt, 1000);
  });
  child.postMessage({ type: 'init', modelDir: dir, threads: settings.sttThreads });
  sttLink.setWorker(child);
  // Native capture sends its audio from main.
  const { port1, port2 } = new MessageChannelMain();
  child.postMessage({ type: 'attach' }, [port1]);
  mainSttPort?.close();
  mainSttPort = port2;
  port2.start();
}

// The capture renderer talks to the recognizer directly, in order, without a main-process hop.
const sttLink = new SttLink<UtilityProcess>((child) => {
  const { port1, port2 } = new MessageChannelMain();
  child.postMessage({ type: 'attach' }, [port1]);
  pill.webContents.postMessage('dictate:stt-port', null, [port2]);
});

// ---------- live cleanup ----------

/** Below this (after gain) the speaker is pausing, for live cleanup's fallback sentence split. */
const PAUSE_DBFS = -45;
let liveTimer: ReturnType<typeof setInterval> | undefined;
let silentSince: number | null = null;

function startLiveCleanup(s: Session): void {
  const steps = cleanup.steps();
  if (!settings.liveCleanup || !steps.length) return;
  s.segmenter = new Segmenter({ ...DEFAULT_SEGMENTER, pauseMs: settings.livePauseMs });
  s.cleaner = new LiveCleanup((raw, context, signal) => runChain(raw, steps, cleanup.deps(), { context, signal }));
  silentSince = null;
  clearInterval(liveTimer);
  liveTimer = setInterval(() => {
    if (rec !== s || !s.segmenter || !s.cleaner) return;
    s.cleaner.committed(s.segmenter.tick(performance.now()));
  }, 100);
}

/** Native capture's levels: where the speaker pauses (the browser path keeps its levels in the pill). */
function liveLevel(rms: number): void {
  const seg = rec?.segmenter;
  if (!seg) return;
  if (dbfs(rms) < PAUSE_DBFS) silentSince ??= performance.now();
  else silentSince = null;
  seg.silence(silentSince);
}

/** Recording over: no more pause splits; on Esc everything stops, including requests in flight. */
function stopLiveCleanup(s: Session, cancelled: boolean): void {
  clearInterval(liveTimer);
  liveTimer = undefined;
  if (cancelled) s.cleaner?.cancel();
}

// ---------- capture: native WASAPI, or the pill's browser capture ----------

/** Audio is arriving for recording `id`: the meter goes live and the start cue plays (never before). */
function markLive(id: number): void {
  const s = rec?.id === id ? rec : undefined;
  if (!s || s.live) return;
  s.live = true;
  if (s.shown) {
    pillSend('dictate:live');
    sound('start');
  }
}

function captureError(id: number, message: string): void {
  log('error', `capture ${id}: ${message}`);
  if (rec?.id === id && rec.shown) {
    sound('error');
    pillSend('dictate:pill', { kind: 'error', message: `Microphone error: ${message}` });
  }
}

function micLost(id: number, label: string): void {
  // Capture has already moved to the default mic; the device list will say whether something better is left.
  log('warn', `capture ${id}: mic "${label}" ended; continuing on the default mic`);
  if (rec?.id === id && rec.shown) pillSend('dictate:notice', `${micName(label || 'Microphone')} stopped · using the default mic`);
  pillSend('dictate:enumerate');
}

function captureFailed(id: number, message: string): void {
  log('error', `capture ${id}: no mic could be reopened (${message}); finishing with what was heard`);
  if (rec?.id !== id) return;
  machine.reset();
  if (rec.shown) pillSend('dictate:notice', 'Microphone lost · kept what you said');
  void stopRecording();
}

function silentState(id: number, silent: boolean): void {
  if (rec?.id === id) pillSend('dictate:silent-state', silent);
}

const browserCapture: CapturePath = {
  start: (id, deviceId, gain) => pillSend('dictate:capture-start', { id, deviceId, gain, fakeWav }),
  stop: (id) => pillSend('dictate:capture-stop', { id }),
  cancel: (id) => pillSend('dictate:capture-cancel', { id }),
  switchDevice: (id, deviceId, gain) => pillSend('dictate:capture-switch', { id, deviceId, gain }),
};

function startCapture(): void {
  router = new CaptureRouter(() => (nativeOk && nativeCapture ? nativePath : null), browserCapture, log);
  if (process.platform !== 'win32' || process.env.DICTATE_CAPTURE === 'browser') {
    log('info', `using browser audio capture (${process.platform})`);
    return;
  }
  const nm = new NativeMic(
    path.join(appRoot(), 'out', 'native', 'mic.js'),
    {
      labelFor: (id) => (id === null ? null : (devicesCache.find((d) => d.deviceId === id)?.label ?? null)),
      stt: (m) => mainSttPort?.postMessage(m),
      onAudio: (m) => nativeCapture?.onWorklet(m),
      onFirst: (sid, ms, warmStream) => {
        log('info', `capture ${sid}: first audio ${ms} ms after key down (${warmStream ? 'warm' : 'cold'} mic)`);
        markLive(sid);
      },
      onOpened: (_label, bluetooth) => {
        if (bluetooth === micBluetooth) return;
        micBluetooth = bluetooth;
        pushState();
      },
      log,
      keyDownAt: () => keyDownAt,
    },
    process.env.DICTATE_FAKE_MIC,
  );
  nativeMic = nm;
  const events: CaptureEvents = {
    started: (id, label, openMs) => log('info', `capture ${id} on "${label}" (native), mic open in ${openMs} ms`),
    error: (id, message) => {
      if (!router.nativeFailed(id, message)) captureError(id, message);
    },
    lost: micLost,
    failed: captureFailed,
    silent: silentState,
    level: (rms) => {
      pillSend('dictate:level', rms);
      liveLevel(rms);
    },
    gain: rememberGain,
  };
  nativeCapture = new CaptureController(nm, events);
  warm = new WarmMic({
    close: (why) => {
      if (why !== 'off') log('info', `mic closed (${why})`);
      nm.closeWarm();
    },
    // Battery saver closes the mic at once, like Off.
    setting: () => (batterySaverOn() ? 'off' : settings.micWarm),
    onAC: () => !powerMonitor.isOnBatteryPower(),
    timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
  });
  nm.warm = warm;
  void nm.ready.then((ok) => {
    nativeOk = ok;
    log('info', ok ? 'native mic capture ready' : 'native mic capture unavailable; using the browser path');
  });
}

const nativePath: CapturePath = {
  start: (id, deviceId, gain) => void nativeCapture!.start(id, deviceId, gain),
  stop: (id) => void nativeCapture!.stop(id),
  cancel: (id) => void nativeCapture!.cancel(id),
  switchDevice: (id, deviceId, gain) => void nativeCapture!.switchDevice(id, deviceId, gain),
};

// ---------- microphones ----------

let pendingMicEvent: MicEvent | undefined;

function onDevices(d: { list: MicDevice[]; defaultLabel: string }): void {
  defaultMicLabel = d.defaultLabel;
  const first = !devicesSeen;
  devicesSeen = true;
  const u = mics.update(d.list, !!rec);
  if (mics.prefsChanged) {
    mics.prefsChanged = false;
    settings.micOrder = [...mics.order];
    saveSettings.save();
  }
  if (!first && u.event) micToast(u.event);
  if (u.event?.kind === 'disconnected' && rec) {
    router.switchDevice(rec.id, u.active?.deviceId ?? null, gainFor(u.active));
  }
  // A warm stream is on the old mic: close it rather than reuse it.
  if (u.event) warm?.interrupt('device');
  pushState();
  rebuildTrayMenu();
}

function micToast(e: MicEvent): void {
  if (e.kind === 'disconnected') {
    const msg = `${micName(e.from)} disconnected · using ${e.to ? micName(e.to) : 'the default mic'}`;
    log('info', msg);
    // Mid-recording the pill keeps its controls and shows the change as a notice under the text.
    if (rec?.shown || finishing.size) pillSend('dictate:notice', msg);
    else showToast(msg, false, 4000);
  } else {
    log('info', `switched to ${e.to}`);
    if (rec || finishing.size) {
      pendingMicEvent = e;
      return;
    }
    showToast(`Switched to ${micName(e.to)}`, true, 6000);
  }
}

function applyPendingMicSwitch(): void {
  const u = mics.recordingEnded();
  const e = u.event ?? pendingMicEvent;
  pendingMicEvent = undefined;
  if (e) setTimeout(() => micToast(e), 1200);
}

function showToast(message: string, undo: boolean, ms: number): void {
  pillSend('dictate:pill', { kind: 'toast', message, undo, ms });
  showPill(pill);
}

/** `deviceId` null = the system default. Devices are picked by id, so two identical mics are never confused. */
function pickMic(deviceId: string | null): void {
  const dev = deviceId ? (lastDevices().find((m) => m.deviceId === deviceId) ?? null) : null;
  mics.pick(dev);
  warm?.interrupt('device');
  settings.micOrder = [...mics.order];
  saveSettings.save();
  log('info', `microphone: ${dev?.label ?? 'system default'}`);
  pushState();
  rebuildTrayMenu();
}

let devicesCache: MicDevice[] = [];
function lastDevices(): MicDevice[] {
  return devicesCache;
}

// ---------- history picker ----------

function pickerItems() {
  return history.list();
}

/** The live picker BrowserWindow, for click-outside checks. */
let pickerWin: Electron.BrowserWindow | undefined;

function makePickerWindow(): PickerWindow {
  const w = createPicker();
  pickerWin = w;
  const gone: (() => void)[] = [];
  w.on('focus', () => {
    hook.send({ type: 'capture', on: false });
    w.webContents.send('dictate:picker-local-keys', true);
  });
  w.on('blur', () => closePicker());
  w.on('close', (event) => { if (!quitting) { event.preventDefault(); closePicker(); } });
  const fireGone = () => {
    if (pickerWin === w) pickerWin = undefined;
    for (const cb of gone.splice(0)) cb();
  };
  w.webContents.on('render-process-gone', fireGone);
  w.on('closed', fireGone);
  return {
    send: (ch, ...args) => {
      if (!w.isDestroyed()) w.webContents.send(ch, ...args);
    },
    showInactive: () => {
      if (platformCapabilities().canSwallowKeys) w.showInactive();
      else { w.show(); w.focus(); }
      w.setAlwaysOnTop(true, 'pop-up-menu');
    },
    hide: () => {
      if (!w.isDestroyed()) w.hide();
    },
    isVisible: () => !w.isDestroyed() && w.isVisible(),
    destroy: () => {
      if (!w.isDestroyed()) w.destroy();
    },
    place: (caret) => placePicker(w, caret),
    onReady: (cb) => {
      const ok = (e: Electron.IpcMainEvent) => {
        if (e.sender !== w.webContents) return;
        ipcMain.removeListener('dictate:picker-ready', ok);
        cb();
      };
      ipcMain.on('dictate:picker-ready', ok);
      gone.push(() => ipcMain.removeListener('dictate:picker-ready', ok));
    },
    onGone: (cb) => gone.push(cb),
  };
}

let picker: PickerController;

function closePicker(): void {
  picker.close();
  machine.clearKeys();
}

async function choose(req: PickRequest): Promise<void> {
  closePicker();
  // The portable picker takes focus; wait until its original target is active before pasting.
  const target = picker.target;
  const focused = req.copyOnly || await focusForPaste(target, { current: foregroundWindow, exists: isWindow, activate: setForeground });
  const d = await pickFromHistory(history, { ...req, copyOnly: req.copyOnly || !focused }, sink);
  if (d && !req.copyOnly && !d.pasted) showToast(d.copied ? `Copied · press ${pasteKeys}` : 'Couldn’t paste or copy', false, 3500);
}

// ---------- keyboard ----------

let recordingBinding: { keys: Set<number>; held: Set<number>; resolve: (b: Binding | null) => void } | null = null;

function onHook(e: FromHook): void {
  if (e.type === 'ready') {
    machine.clearKeys();
    return;
  }
  if (e.type === 'click') {
    // Portable pickers use ordinary window focus/blur. screenToDipPoint is not a macOS API.
    if (!platformCapabilities().canSwallowKeys) return;
    if (picker.isOpen && pickerWin && !pickerWin.isDestroyed()) {
      const b = pickerWin.getBounds();
      const p = screen.screenToDipPoint({ x: e.x, y: e.y });
      // 12 px of the window is transparent shadow margin.
      if (p.x < b.x + 12 || p.x > b.x + b.width - 12 || p.y < b.y + 12 || p.y > b.y + b.height - 12) closePicker();
    }
    return;
  }
  if (e.type !== 'key') return;
  if (e.down) surfaces?.keyDown(performance.now());
  if (recordingBinding) {
    const r = recordingBinding;
    if (e.down) {
      if (e.vk === 0x1b && r.keys.size === 0) {
        recordingBinding = null;
        r.resolve(null);
        return;
      }
      r.keys.add(e.vk);
      r.held.add(e.vk);
    } else {
      r.held.delete(e.vk);
      if (r.held.size === 0 && r.keys.size) {
        recordingBinding = null;
        r.resolve(bindingFromKeys([...r.keys]));
      }
    }
    return;
  }
  // Esc during a reply's preview: nothing is sent.
  if (e.down && e.vk === VK.Escape && !rec && replyPreview) {
    replyPreview.cancel();
    return;
  }
  // Esc with the pointer over an agent's card dismisses it (the app in front sees the Esc too).
  if (e.down && e.vk === VK.Escape && !rec && !cancellable.size && pointerOverCard()) agents?.dismissTop();
  // Esc after release cancels a dictation still transcribing or cleaning (the hook swallowed it).
  if (e.down && e.vk === VK.Escape && !rec && cancellable.size) {
    cancelAfterRelease();
    return;
  }
  if (e.down && e.vk === VK.Escape && escapeKeyless()) return;
  if (picker.isOpen) {
    if (!platformCapabilities().canSwallowKeys || pickerWin?.isFocused()) return;
    if (e.down && [0xa4, 0xa5, 0x5b, 0x5c].includes(e.vk)) closePicker();
    else if (e.down && !isModifier(e.vk)) picker.send('dictate:picker-key', { vk: e.vk, shift: e.shift });
    return;
  }

  if (e.down) machine.down(e.vk, e.t);
  else machine.up(e.vk, e.t);
}

/**
 * Esc while a recording runs that no key started (a surface's open listening): the machine is idle and would ignore
 * it, and the hook swallows Esc while recording, so it cancels here. True when it did.
 */
function escapeKeyless(): boolean {
  if (!rec || machine.recording) return false;
  onHotkey({ type: 'cancel', reason: 'escape' });
  return true;
}

function bindings(): Bindings {
  return { hotkeys: settings.hotkeys, toggle: settings.toggle, picker: settings.picker };
}

/** The machine's bindings: the dictation keys, and the surfaces' keys their features have registered. */
function machineBindings(): Bindings {
  return { ...bindings(), ...surfaces?.bindings(settings) };
}

function applyBindings(): void {
  const b = machineBindings();
  machine.configure(b, { tapMs: settings.tapMs, doubleTapMs: settings.doubleTapMs });
  // Swallow the last key of each combo so the app never sees it (Right Ctrl+V must not paste), and dedicated
  // dictation keys (F13). Mask lone Alt/Win presses of the bindings, so dictating with Right Alt never opens a menu bar.
  hook.send({ type: 'config', swallow: swallowBindings(b), mask: menuMaskKeys(b), maskCombos: menuMaskCombos(b) });
}

// ---------- tray ----------

function rebuildTrayMenu(): void {
  if (!tray) return;
  const last = history.latest();
  const devices = lastDevices();
  const current = mics.current;
  const micItems: Electron.MenuItemConstructorOptions[] = [
    { label: `System default${defaultMicLabel ? ` (${micName(defaultMicLabel)})` : ''}`, type: 'radio', checked: !current, click: () => pickMic(null) },
    ...devices.map((d) => ({ label: micName(d.label), sublabel: d.label, type: 'radio' as const, checked: current?.deviceId === d.deviceId, click: () => pickMic(d.deviceId) })),
  ];
  const chain = (c: Settings['cleanup'], label: string): Electron.MenuItemConstructorOptions => ({ label, type: 'radio', checked: settings.cleanup === c, click: () => updateSettings({ cleanup: c }) });
  const out = (o: Settings['output'], label: string): Electron.MenuItemConstructorOptions => ({ label, type: 'radio', checked: settings.output === o, click: () => updateSettings({ output: o }) });
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Hold ${hotkeyLabel()} to dictate · double-tap to toggle`, enabled: false },
      { type: 'separator' },
      { label: rec ? 'Finish dictation' : 'Start dictation', enabled: sttReady, click: () => toggleFromApp() },
      { label: 'Copy last dictation', enabled: !!last, click: () => last && void writeClipboardText(last.text, { history: true }).catch(() => undefined) },
      { label: `History…   ${bindingLabel(settings.picker)}`, enabled: !!last, click: () => void picker.open() },
      { type: 'separator' },
      { label: 'Microphone', submenu: micItems },
      { label: 'Cleanup', submenu: [chain('gemma-emberon', 'Gemma → Emberon (best)'), chain('gemma', 'Gemma only'), chain('emberon', 'Emberon only (fastest)'), chain('off', 'Off (raw transcript)')] },
      { label: 'Output', submenu: [out('paste', 'Paste into the focused app'), out('clipboard', 'Clipboard only'), out('both', 'Paste and keep on clipboard')] },
      { label: 'Sounds', type: 'checkbox', checked: settings.sounds, click: (i) => updateSettings({ sounds: i.checked }) },
      { label: `Pause agent alerts${settings.agentAlertsPaused && agents?.waiting() ? ` (${agents.waiting()} waiting)` : ''}`, type: 'checkbox', checked: settings.agentAlertsPaused, click: (i) => agents?.setPaused(i.checked) },
      { type: 'separator' },
      { label: 'Getting started…', click: () => openSettings('start') },
      { label: 'Settings…', click: () => openSettings() },
      { label: 'Clear history', enabled: !!last, click: () => clearHistory() },
      { label: 'Open log', click: () => void shell.openPath(path.join(userData(), 'logs', 'dictate.log')) },
      { type: 'separator' },
      { label: 'Quit dictate', click: () => app.quit() },
    ]),
  );
}

function clearHistory(): void {
  history.clear();
  saveHistory.save();
  pushState();
  rebuildTrayMenu();
}

// ---------- settings ----------

function openSettings(page?: string): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (page) settingsWin.webContents.send('dictate:navigate', page);
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  pendingPage = page ?? null;
  settingsWin = createSettings();
  settingsWin.on('closed', () => {
    settingsWin = undefined;
    practicing = false;
  });
}

const binDir = () => path.join(userData(), 'bin');
const llamaServerPath = () => path.join(binDir(), process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');

function downloadSizes(): { essentials: number; gemma: number } {
  const opts = { platform: process.platform, arch: process.arch };
  const total = (xs: { bytes: number }[]) => xs.reduce((n, a) => n + a.bytes, 0);
  return { essentials: total(assetsFor('essentials', opts)), gemma: total(assetsFor('cleanup', { ...opts, cleanupModels: ['gemma'], binDir: binDir() })) };
}

/** The practice box's sink: nothing is pasted or put on the clipboard; the text goes to the Settings window. */
const practiceSink: OutputSink = { deliver: async (): Promise<Delivery> => ({ pasted: true, copied: false, confirmed: true }) };

/** C4/D10: time cleanup on this computer, save the result, and use the chain it picks. */
async function hardwareCheck(measureGemma: boolean, requested: boolean): Promise<unknown> {
  if (hardwareRunning) return state();
  if (rec || finishing.size) throw new Error('Finish dictating before running the check');
  hardwareRunning = true;
  hardwareError = '';
  pushState();
  try {
    const report = await runHardwareCheck({
      llamaServer: settings.llamaServer,
      modelsDir: settings.modelsDir,
      sample: fs.readFileSync(path.join(appRoot(), 'defaults', 'hardware-sample.txt'), 'utf8'),
      clean: async (text, chain) => runChain(text, await cleanup.trial(chain), cleanup.deps(), { timeoutMs: 3000 }),
      measureGemma,
    });
    const c = report.choice;
    log('info', `hardware check: ${c.summary} (emberon ${report.emberonMs?.toFixed(0) ?? '-'} ms, gemma chain ${report.gemmaChainMs?.toFixed(0) ?? '-'} ms, ${report.devices.length} GPU devices)`);
    // After Getting started, a check nobody asked for (one after a download) reports but keeps the person's chain.
    const chain = appliesMeasuredChain({ onboarded: settings.onboarded, requested }) ? { cleanup: c.chain } : {};
    updateSettings({ ...chain, hardware: { summary: c.summary, chain: c.chain, emberonMs: report.emberonMs, gemmaChainMs: report.gemmaChainMs, offerGemma: c.offerGemma, measuredAt: report.measuredAt } });
  } catch (err) {
    hardwareError = `The speed check failed: ${(err as Error).message}`;
    log('error', hardwareError);
  } finally {
    hardwareRunning = false;
    cleanup.sync();
    lastActivityAt = Date.now();
    updater?.activity();
    pushState();
  }
  return state();
}

const RELEASES_API = 'https://api.github.com/repos/parsakhaz/open-dictate/releases/latest';

/** C6: GitHub Releases only, and only while Settings → About → Automatic updates is on. */
async function startUpdater(): Promise<void> {
  const mode = updateMode({ platform: process.platform, packaged: app.isPackaged, appImage: process.env.APPIMAGE });
  let engine: UpdateEngine | undefined;
  if (mode === 'install') {
    // require, not import(): a dynamic ESM import of a package inside app.asar fails in the packaged app.
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    engine = {
      check: async () => {
        await autoUpdater.checkForUpdates();
      },
      install: () => {
        quitting = true;
        // Silent, then relaunch: the app starts in the tray as it does at login.
        autoUpdater.quitAndInstall(true, true);
      },
      on: ((event: 'available' | 'none' | 'progress' | 'downloaded' | 'error', cb: (x?: string | number) => void) => {
        if (event === 'available') autoUpdater.on('update-available', (i) => cb(i.version));
        else if (event === 'none') autoUpdater.on('update-not-available', () => cb());
        else if (event === 'progress') autoUpdater.on('download-progress', (p) => cb(p.percent));
        else if (event === 'downloaded') autoUpdater.on('update-downloaded', (i) => cb(i.version));
        else autoUpdater.on('error', (e) => cb(e.message));
      }) as UpdateEngine['on'],
    };
  }
  updater = new Updater({
    mode,
    currentVersion: app.getVersion(),
    enabled: () => settings.autoUpdate,
    busy: () => ({ recording: !!rec, cleaning: finishing.size > 0, downloading: setup.state.phase === 'downloading' || setup.state.phase === 'extracting' || hardwareRunning }),
    lastActivityAt: () => lastActivityAt,
    log,
    engine,
    latestRelease: async () => {
      const r = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`GitHub answered HTTP ${r.status}`);
      const j = (await r.json()) as { tag_name?: string; html_url?: string };
      return j.tag_name && j.html_url ? { tag: j.tag_name, url: j.html_url } : null;
    },
    onChange: () => pushState(),
  });
  updater.start();
}

function stats() {
  const ms = history
    .list()
    .map((e) => e.ms)
    .filter((x): x is number => typeof x === 'number')
    .slice(0, 50)
    .sort((a, b) => a - b);
  return { samples: ms.length, median: ms.length ? ms[Math.floor(ms.length / 2)] : null };
}

function state() {
  return {
    settings,
    labels: { hotkey: hotkeyLabel(), hotkeys: settings.hotkeys.map((b) => bindingLabel(b)), toggle: bindingLabel(settings.toggle), picker: bindingLabel(settings.picker) },
    devices: lastDevices(),
    mic: mics.current,
    defaultMicLabel,
    gain: gainFor(mics.current),
    micBluetooth,
    stt: sttReady ? 'ready' : sttError ? 'error' : 'loading',
    sttError,
    servers: cleanup.states(),
    effectiveChain: cleanup.chain(),
    onBattery: cleanup.onBattery,
    missing: cleanup.missingFiles(),
    history: { count: history.list().length, ...stats() },
    logFile: path.join(userData(), 'logs', 'dictate.log'),
    version: app.getVersion(),
    platform: platformCapabilities(),
    microphonePermission: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('microphone') : 'system',
    setup: setup.state,
    speechInstalled: speechInstalled(settings.modelsDir),
    essentialsReady: essentialsInstalled(settings.modelsDir, binDir(), process.platform),
    gemmaInstalled: fs.existsSync(path.join(settings.modelsDir, GEMMA_GGUF)),
    sizes: downloadSizes(),
    hardwareRunning,
    hardwareError,
    dataDir: userData(),
    update: updater?.state ?? { status: 'off', mode: 'off' },
    shortcutRegistered,
    shortcutRequested,
    startupError,
    recording: !!rec,
    automation: !!process.env.DICTATE_SMOKE_TEST,
    agents: agents?.state() ?? null,
    /** Each surface feature's own part, for its Settings → Agents section. */
    surfaces: surfaces?.state() ?? {},
  };
}

function pushState(): void {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('dictate:state', state());
}

function updateSettings(patch: Partial<Settings>): void {
  const before = settings;
  if (patch.startWithWindows !== undefined && patch.startAtLogin === undefined) patch = { ...patch, startAtLogin: patch.startWithWindows };
  if (patch.startAtLogin !== undefined) patch = { ...patch, startWithWindows: patch.startAtLogin };
  // From the settings page: the person's own choice from now on.
  if (patch.liveCleanup !== undefined) patch = { ...patch, liveCleanupSet: true };
  settings = parseSettings({ ...settings, ...patch }, runtimeDefaults(settings.vocabulary, { platform: process.platform, userData: userData() }));
  saveSettings.save();
  if (['hotkeys', 'toggle', 'picker', 'tapMs', 'doubleTapMs', 'inbox', 'snooze', 'voice', 'point'].some((k) => k in patch)) applyBindings();
  if (patch.historyLimit !== undefined) history.setLimit(settings.historyLimit);
  if (patch.micWarm !== undefined) warm?.settingChanged();
  if (patch.pillText !== undefined) pillConfig();
  if (patch.startAtLogin !== undefined) applyLoginItem();
  if (patch.autoUpdate !== undefined) updater?.setEnabled(settings.autoUpdate);
  if (patch.agentsEnabled !== undefined && patch.agentsEnabled !== before.agentsEnabled) void agents?.applyRegistration().then(() => pushState());
  if (patch.agentPaneAlerts !== undefined && patch.agentPaneAlerts !== before.agentPaneAlerts) agents?.applyPaneWatch();
  if (before.agentHistory && !settings.agentHistory) agents?.hub.historyAccessOff();
  if (patch.agentAlertsPaused !== undefined && agents && agents.hub.queue.paused !== settings.agentAlertsPaused) agents.setPaused(settings.agentAlertsPaused);
  if (patch.portableShortcut !== undefined || patch.portableShortcutEnabled !== undefined) applyPortableShortcut();
  if (['cleanup', 'llamaServer', 'modelsDir', 'vocabulary', 'batteryEmberonOnly', 'batteryUnloadMinutes'].some((k) => k in patch)) cleanup.update(settings);
  if ((patch.modelsDir && patch.modelsDir !== before.modelsDir) || (patch.sttThreads && patch.sttThreads !== before.sttThreads)) {
    const old = stt;
    stt = undefined;
    old?.kill();
    startStt();
  }
  pushState();
  rebuildTrayMenu();
  setTray(trayState);
}

function applyLoginItem(): void {
  try {
    applyAutostart(settings.startAtLogin, { platform: process.platform, appRoot: appRoot(), executable: process.execPath, packaged: app.isPackaged, appImage: process.env.APPIMAGE, configHome: process.env.XDG_CONFIG_HOME, setLoginItem: (options) => app.setLoginItemSettings(options) });
    startupError = '';
  } catch (err) {
    startupError = (err as Error).message;
    log('error', `start at login: ${startupError}`);
  }
}

function toggleFromApp(): void {
  machine.toggle();
  pushState();
  rebuildTrayMenu();
}

/** Wayland's portal can offer a toggle even though raw key-up events and synthetic paste are forbidden. */
function applyPortableShortcut(): void {
  globalShortcut.unregisterAll();
  shortcutRegistered = false;
  shortcutRequested = false;
  if (platformCapabilities().displayServer !== 'wayland' || !settings.portableShortcutEnabled || !settings.portableShortcut) return;
  try {
    // On Wayland this boolean confirms submission, not consent. Electron 44.7 has no resolution event.
    shortcutRequested = globalShortcut.register(settings.portableShortcut, () => {
      shortcutRegistered = true;
      toggleFromApp();
    });
  }
  catch (err) { log('warn', `desktop shortcut: ${(err as Error).message}`); }
}

function registerIpc(): void {
  ipcMain.handle('dictate:get-state', () => state());
  ipcMain.handle('dictate:toggle', () => { toggleFromApp(); return state(); });
  ipcMain.handle('dictate:open-history', () => picker.open());
  ipcMain.handle('dictate:enable-shortcut', () => { updateSettings({ portableShortcutEnabled: true }); return state(); });
  ipcMain.handle('dictate:permissions', async () => {
    if (process.platform === 'darwin') {
      requestAccessibility();
      await systemPreferences.askForMediaAccess('microphone');
      if (accessibilityGranted()) hook.start();
    }
    return state();
  });
  ipcMain.handle('dictate:setup-models', async (_e, kind: 'speech' | 'cleanup' | 'essentials' | 'gemma') => {
    if (!['speech', 'cleanup', 'essentials', 'gemma'].includes(kind)) throw new Error('Unknown model download');
    if (rec || finishing.size) throw new Error('Finish dictating before changing models');
    cleanup.stopAll();
    const options = { modelsDir: settings.modelsDir, binDir: binDir(), platform: process.platform, arch: process.arch };
    try {
      if (kind === 'gemma') await setup.install('cleanup', { ...options, cleanupModels: ['gemma'] });
      // The Cleanup page's button also repairs a broken llama.cpp runtime, so it always reinstalls it.
      else await setup.install(kind, { ...options, reinstallRuntime: kind === 'cleanup' });
    } catch (err) { cleanup.sync(); throw err; }
    finally {
      lastActivityAt = Date.now();
      updater?.activity();
    }
    if (kind === 'speech' || kind === 'essentials') { const old = stt; stt = undefined; old?.kill(); startStt(); }
    if (kind === 'speech') cleanup.sync();
    else {
      // D10: the measurement picks the chain, not the download (the Cleanup page's button included).
      if (!keepsLlamaServer(settings.llamaServer, fs.existsSync)) updateSettings({ llamaServer: llamaServerPath() });
      // Downloading Gemma asks to switch to it if it is fast enough; the other downloads only report afterwards.
      void hardwareCheck(kind !== 'essentials', kind === 'gemma').catch(() => undefined);
    }
    return state();
  });
  ipcMain.handle('dictate:cancel-setup', () => setup.cancel());
  ipcMain.handle('dictate:set-settings', (_e, patch: Partial<Settings>) => {
    updateSettings(patch);
    return state();
  });
  ipcMain.handle('dictate:record-binding', () => {
    recordingBinding?.resolve(null);
    return new Promise<Binding | null>((resolve) => {
      recordingBinding = { keys: new Set(), held: new Set(), resolve };
    });
  });
  ipcMain.handle('dictate:cancel-record-binding', () => {
    recordingBinding?.resolve(null);
    recordingBinding = null;
  });
  ipcMain.handle('dictate:pick-mic', (_e, deviceId: string | null) => {
    pickMic(deviceId);
    return state();
  });
  ipcMain.handle('dictate:set-gain', (_e, label: string, db: number) => {
    updateSettings({ gainDb: { ...settings.gainDb, [micKey(label)]: db } });
    return state();
  });
  ipcMain.handle('dictate:clear-history', () => {
    clearHistory();
    return state();
  });
  ipcMain.handle('dictate:open-log', () => shell.openPath(path.join(userData(), 'logs', 'dictate.log')));
  ipcMain.handle('dictate:finish-onboarding', (_e, startAtLogin: boolean) => {
    practicing = false;
    updateSettings({ onboarded: true, onboardingStep: 'done', startAtLogin });
    return state();
  });
  ipcMain.handle('dictate:check-updates', async () => {
    await updater?.check();
    return state();
  });
  ipcMain.handle('dictate:hardware-check', (_e, requested?: boolean) => hardwareCheck(fs.existsSync(path.join(settings.modelsDir, GEMMA_GGUF)), requested !== false));
  ipcMain.handle('dictate:practice', (_e, on: boolean) => {
    practicing = !!on;
  });
  ipcMain.handle('dictate:take-page', () => {
    const p = pendingPage;
    pendingPage = null;
    return p;
  });
  ipcMain.handle('dictate:open-data', () => shell.openPath(userData()));
  ipcMain.handle('dictate:agents-vocab', (_e, a: { term: string; approve: boolean }) => {
    if (a.approve) agents?.approve(String(a.term));
    else agents?.reject(String(a.term));
    return state();
  });
  ipcMain.handle('dictate:agents-revoke', (_e, sessionId: string) => {
    agents?.revoke(String(sessionId));
    return state();
  });
  ipcMain.handle('dictate:agents-copy', async (_e, text: string) => {
    await writeClipboardText(String(text), { history: false });
  });
  ipcMain.handle('dictate:open-url', (_e, url: string) => {
    // Only the licence and source links the pages show: https, never a file or app protocol.
    if (typeof url === 'string' && /^https:\/\/\S+$/.test(url)) return shell.openExternal(url);
  });

  ipcMain.on('dictate:pill-ready', () => {
    log('info', 'pill ready');
    pillConfig();
    // Cards that arrived while the page was still loading.
    agents?.render();
    sttLink.pillReady();
  });
  ipcMain.on('dictate:pill-content', (event, visible: unknown) => {
    if (event.sender !== pill.webContents) return;
    if (visible === true) showPill(pill);
    else if (visible === false) pill.hide();
  });
  ipcMain.on('dictate:renderer-error', (_e, page: string, message: string) => log('error', `renderer ${page}: ${String(message).slice(0, 2000)}`));
  ipcMain.on('dictate:pill-hidden', () => {
    if (!rec?.shown && !cardsShown && !extraRects.length) pill.hide();
  });
  ipcMain.on('dictate:extra-rects', (_e, rs: unknown) => {
    extraRects = Array.isArray(rs) ? rs.filter((r): r is Rect => !!r && [r.x, r.y, r.width, r.height].every(Number.isFinite)) : [];
    if (extraRects.length) showPill(pill);
    watchCardHover(cardsShown || extraRects.length > 0);
  });
  ipcMain.handle('dictate:card-action', (_e, a: CardAction) => agents?.action(a));
  ipcMain.on('dictate:card-rect', (_e, r: typeof cardRect) => {
    cardRect = r && [r.x, r.y, r.width, r.height].every(Number.isFinite) ? { x: r.x, y: r.y, width: r.width, height: r.height, id: typeof r.id === 'string' ? r.id : null, head: Number.isFinite(r.head) ? r.head : 0 } : null;
  });
  ipcMain.on('dictate:devices', (_e, d: { list: MicDevice[]; defaultLabel: string }) => {
    if (process.env.DICTATE_QA_DEVICES) return;
    devicesCache = d.list;
    onDevices(d);
  });
  ipcMain.on('dictate:capture-started', (_e, a: { id: number; label: string; openMs: number }) => {
    log('info', `capture ${a.id} on "${a.label}" (browser), mic open in ${a.openMs} ms after key down`);
    markLive(a.id);
  });
  ipcMain.on('dictate:capture-cancelled', (_e, a: { id: number }) => log('info', `capture ${a.id}: cancelled (browser)`));
  ipcMain.on('dictate:capture-error', (_e, a: { id: number; message: string }) => captureError(a.id, a.message));
  ipcMain.on('dictate:mic-lost', (_e, a: { id: number; label: string }) => micLost(a.id, a.label));
  ipcMain.on('dictate:capture-failed', (_e, a: { id: number; message: string }) => captureFailed(a.id, a.message));
  ipcMain.on('dictate:silent', (_e, a: { id: number; silent: boolean }) => silentState(a.id, a.silent));
  ipcMain.on('dictate:capture-gain', (_e, a: { id: number; label: string; gainDb: number }) => rememberGain(a.id, a.label, a.gainDb));
  ipcMain.on('dictate:undo-mic', () => {
    const d = mics.undo();
    log('info', `undo mic switch: back to ${d?.label ?? 'system default'}`);
    pillSend('dictate:pill', { kind: 'info', message: `Using ${d ? micName(d.label) : 'the default mic'}` });
    pushState();
    rebuildTrayMenu();
  });

  // picker
  ipcMain.on('dictate:picker-choose', (_e, a: PickRequest) => void choose(a));
  ipcMain.on('dictate:picker-close', () => closePicker());
  ipcMain.on('dictate:picker-pin', (_e, a: { id: string; pinned: boolean }) => {
    history.setPinned(a.id, a.pinned);
    saveHistory.save();
    picker.send('dictate:picker-items', pickerItems());
  });
  ipcMain.on('dictate:picker-delete', (_e, a: { id: string }) => {
    history.remove(a.id);
    saveHistory.save();
    picker.send('dictate:picker-items', pickerItems());
    rebuildTrayMenu();
  });
  ipcMain.handle('dictate:history', () => history.list());
}

// ---------- start-up ----------

function loadSettings(): Settings {
  const vocab = parseVocabularyFile(fs.readFileSync(path.join(appRoot(), 'defaults', 'vocabulary.json'), 'utf8')).terms;
  const defaults = runtimeDefaults(vocab, { platform: process.platform, userData: userData() });
  const saved = loadJson(path.join(userData(), 'settings.json'), log);
  const data = migratePlatformSettings(saved, defaults, fs.existsSync);
  const s = parseSettings(data, defaults);
  // A profile from before Getting started that already dictates keeps working as it was, without the walkthrough.
  if (!s.onboarded && upgradedOnboarded(saved, speechInstalled(resolveModelsDir(s.modelsDir, fs.existsSync)))) {
    s.onboarded = true;
    s.onboardingStep = 'done';
  }
  return applyEnv(s, process.env);
}

async function main(): Promise<void> {
  log('info', `dictate ${app.getVersion()} starting (electron ${process.versions.electron})`);
  if (process.platform === 'darwin') app.dock?.hide();
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const own = contents.getURL().startsWith('file:') && [pill?.webContents, settingsWin?.webContents].includes(contents);
    callback(own && permission === 'media' && 'mediaTypes' in details && (details.mediaTypes?.every((t) => t === 'audio') ?? false));
  });
  settings = loadSettings();
  // Frequent byte counts must not rebuild settings controls or reopen microphone meters.
  setup.onChange = () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('dictate:setup-progress', setup.state);
  };
  saveSettings = debouncedWriter(path.join(userData(), 'settings.json'), () => settings);
  if (!fs.existsSync(path.join(userData(), 'settings.json'))) writeJson(path.join(userData(), 'settings.json'), settings);
  const hist = loadJson(path.join(userData(), 'history.json'), log);
  history = new HistoryStore(Array.isArray(hist) ? hist : [], settings.historyLimit);
  saveHistory = debouncedWriter(path.join(userData(), 'history.json'), () => history.toJSON());
  mics = new MicSelector(settings.micOrder);
  if (process.env.DICTATE_FAKE_MIC) {
    fakeWav = new Uint8Array(fs.readFileSync(process.env.DICTATE_FAKE_MIC));
    log('warn', `fake mic: ${process.env.DICTATE_FAKE_MIC}`);
  }

  const v3 = fs.readFileSync(path.join(appRoot(), 'defaults', 'prompt-v3.txt'), 'utf8');
  cleanup = new Cleanup({ ...settings, modelsDir: resolveModelsDir(settings.modelsDir, fs.existsSync) }, v3, log, (pid) => {
    if (!killWithUs(pid)) log('warn', `could not tie llama-server ${pid} to dictate's lifetime`);
  });
  cleanup.onChange = () => pushState();
  cleanup.onBattery = powerMonitor.isOnBatteryPower();
  powerMonitor.on('on-battery', () => {
    cleanup.setBattery(true);
    warm?.powerChanged();
  });
  powerMonitor.on('on-ac', () => {
    cleanup.setBattery(false);
    warm?.powerChanged();
  });
  // A warm mic closes at once when the PC locks or sleeps.
  powerMonitor.on('lock-screen', () => warm?.interrupt('lock'));
  powerMonitor.on('suspend', () => warm?.interrupt('sleep'));
  // Keys pressed while the session was locked never send their key-up to us.
  powerMonitor.on('unlock-screen', () => machine.clearKeys());
  powerMonitor.on('resume', () => machine.clearKeys());

  sink = realPasteSink({ modifiersDown: () => machine.modifiersDown(), ownPid: process.pid, log });
  if (process.env.DICTATE_QA_SINK === 'none') {
    // QA without a desktop: nothing is pasted or put on the clipboard; the text is only logged.
    log('warn', 'QA: output goes to the log only');
    sink = {
      deliver: async (text: string) => {
        log('info', `QA delivered ${text.length} chars: ${JSON.stringify(text)}`);
        return { pasted: true, copied: false, confirmed: true };
      },
    } as unknown as PasteSink;
  }
  machine = new HotkeyMachine(bindings(), onHotkey, { tapMs: settings.tapMs, doubleTapMs: settings.doubleTapMs });

  tray = new Tray(trayIcon('loading'));
  tray.on('click', () => openSettings());
  setTray('loading');
  rebuildTrayMenu();

  registerIpc();
  startCapture();
  void startUpdater().catch((e) => log('error', `updater did not start: ${e instanceof Error ? e.message : String(e)}`));
  pill = createPill();
  pill.on('close', (event) => {
    if (!quitting) { event.preventDefault(); agents?.dismissTop(); pill.hide(); }
  });
  pill.webContents.on('render-process-gone', (_e, d) => {
    log('error', `pill renderer gone: ${d.reason}`);
    if (!quitting) {
      sttLink.pillGone();
      pill = createPill();
      const old = stt;
      stt = undefined;
      old?.kill();
      setTimeout(startStt, 500);
    }
  });
  startStt();
  cleanup.sync();
  picker = new PickerController({
    create: makePickerWindow,
    capture: (on) => hook.send({ type: 'capture', on }),
    foreground: () => pickerWin?.isFocused() ? picker.target : foregroundWindow(),
    caret: caretRect,
    items: pickerItems,
    hotkey: () => hotkeyLabel(),
    takesFocus: !platformCapabilities().canSwallowKeys,
    log,
  });
  void picker.ensure();

  hook = new KeyHook(path.join(appRoot(), 'out', 'native', 'keyhook.js'), onHook, log);
  hook.start();
  applyBindings();
  if (!process.env.DICTATE_SMOKE_TEST && !process.env.DICTATE_QA_CONTROL) applyLoginItem();
  else log('info', 'QA: existing OS login items are unchanged');
  // A fresh installation asks only after the button press; subsequent launches reuse the saved choice.
  if (settings.portableShortcutEnabled) applyPortableShortcut();

  if (!settings.onboarded) openSettings();
  startAgents();

  // QA: drive the hotkey without the keyboard. Each line appended to this file is `down` or `up` (the dictation
  // key), handled as if the hook had seen it.
  const qaControl = process.env.DICTATE_QA_CONTROL;
  if (qaControl) {
    log('warn', `QA hotkey control from ${qaControl}`);
    let seen = 0;
    fs.writeFileSync(qaControl, '');
    fs.watchFile(qaControl, { interval: 20 }, () => {
      const lines = fs.readFileSync(qaControl, 'utf8').split('\n').filter(Boolean);
      const first = settings.hotkeys[0]?.keys[0];
      const key = typeof first === 'number' ? first : 0xa3;
      for (const line of lines.slice(seen)) {
        const t = performance.now();
        if (line === 'down') machine.down(key, t);
        else if (line === 'up') machine.up(key, t);
        else if (line === 'escape') {
          if (!escapeKeyless()) machine.down(VK.Escape, t);
          machine.up(VK.Escape, t + 1);
        }
        else if (line === 'quit') app.quit();
        // Bring Settings to the front, as a click would (Getting started's practice box needs it focused).
        else if (line === 'focus') { app.focus({ steal: true }); settingsWin?.show(); settingsWin?.focus(); }
        else if (line.startsWith('shot ')) pillShot(line.slice(5), 0);
        else if (line.startsWith('state ')) {
          pillSend('dictate:pill', JSON.parse(line.slice(6)));
          showPill(pill);

        } else if (line.startsWith('partial ')) pillSend('dictate:partial', line.slice(8));
        // Agent cards: hover (expanded) without a mouse, and the top card's buttons ("card choose Prod").
        else if (line.startsWith('cards-hover ')) {
          qaCardHover = line.slice(12) === 'on';
          pollCardHover();
        }
        else if (line === 'cards-list') pillSend('dictate:qa-list');
        // A stand-in pointer, in pill page pixels: on a card button by its label ("pointer ✕"), at "x,y", or "off".
        else if (line.startsWith('pointer ')) {
          const to = line.slice(8);
          const xy = /^(-?\d+),(-?\d+)$/.exec(to);
          void (to === 'off' ? Promise.resolve(null) : xy ? Promise.resolve({ x: +xy[1], y: +xy[2] }) : qaButtonAt(to)).then((at) => {
            qaPointer = at;
            pollCardHover();
            log('info', `QA pointer ${JSON.stringify(at)}`);
          });
        }
        else if (line === 'pointer-click') void qaPointerClick();
        // Whether main would take a click on that card button right now: its centre against the card's hit area.
        else if (line.startsWith('card-hit ')) {
          void qaButtonAt(line.slice(9)).then((at) => {
            const r = cardRect;
            log('info', `QA card-hit ${JSON.stringify({ at, rect: r, inside: !!(at && r && inRect(at, r)) })}`);
          });
        }
        // A click on a card button by its label, as input events into the pill page (the OS pointer stays put).
        else if (line.startsWith('card-click ')) void qaCardClick(line.slice(11), true);
        // Where that button is on screen (physical pixels), for a real pointer.
        else if (line.startsWith('card-locate ')) void qaCardClick(line.slice(12), false);
        // Whether the top card's title is cut off, and how tall the card is (CSS pixels).
        else if (line === 'card-layout') {
          void pill.webContents
            .executeJavaScript(`(() => { const c = document.querySelector('.cards .card'); const t = c && c.querySelector('.title'); const b = c && c.querySelector('.cbody'); return c && { titleClipped: t.scrollWidth > t.clientWidth + 1 || t.scrollHeight > t.clientHeight + 1, cardHeight: Math.round(c.getBoundingClientRect().height), bodyScrolls: b ? b.scrollHeight > b.clientHeight + 1 : false, buttons: [...c.querySelectorAll('button.cbtn')].map((x) => x.textContent), replying: c.dataset.replying === 'true', text: c.innerText, styled: [...c.querySelectorAll('.msg strong, .msg em, .msg code')].map((x) => x.tagName.toLowerCase() + ':' + x.textContent), elements: c.querySelectorAll('.msg *:not(strong):not(em):not(code), .title *').length }; })()`)
            .then((r) => log('info', `QA card-layout ${JSON.stringify(r)}`));
        }
        // Where the top card is on screen (physical pixels, for a real pointer), and what the queue holds.
        else if (line === 'card-where' && cardRect) {
          const b = pill.getBounds();
          log('info', `QA card at ${JSON.stringify(screen.dipToScreenRect(pill, { x: Math.round(b.x + cardRect.x), y: Math.round(b.y + cardRect.y), width: Math.round(cardRect.width), height: Math.round(cardRect.height) }))}`);
        } else if (line === 'cards-dump') {
          const v = agents?.hub.queue.view(Date.now());
          log('info', `QA cards ${JSON.stringify({ top: v?.top ? { title: v.top.title, source: v.top.source, urgency: v.top.urgency, kind: v.top.kind, target: !!v.top.target } : null, more: v?.more ?? 0, all: v?.all.map((c) => c.title) ?? [], replying: agents?.hub.queue.replyingTo ?? null })}`);
        }
        else if (line.startsWith('pause ')) agents?.setPaused(line.slice(6) === 'on');
        // The sheet window: open a page by kind (the empty stub, or a surface's page with no data), close it, a
        // screenshot of it, and where it is and what it shows.
        else if (line.startsWith('sheet ')) {
          const [kind, ...json] = line.slice(6).split(' ');
          if (isSheetKind(kind)) sheet.open(kind, json.length ? JSON.parse(json.join(' ')) : null, { focus: false });
        } else if (line === 'sheet-close') sheet.close('esc');
        else if (line.startsWith('sheet-shot ') && shotDir) void sheet.shot(path.join(shotDir, `sheet-${line.slice(11)}.png`)).then(() => log('info', `QA sheet-shot ${line.slice(11)}`));
        else if (line === 'sheet-dump') {
          const w = sheet.window();
          void w.webContents
            .executeJavaScript(`(() => ({ kind: document.body.dataset.kind || null, text: document.getElementById('root')?.innerText ?? '' }))()`)
            .then((page) => log('info', `QA sheet ${JSON.stringify({ open: sheet.isOpen, kind: sheet.kind, visible: w.isVisible(), focusable: w.isFocusable(), bounds: w.getBounds(), pill: pill.getBounds(), page })}`));
        }
        // A surface feature's own QA commands: "<feature> <rest>".
        else if (surfaces?.qa(line)) {
          // handled
        }
        else if (line.startsWith('card ')) {
          const [action, ...rest] = line.slice(5).split(' ');
          const top = agents?.hub.queue.view(Date.now()).top;
          if (top) void agents?.action({ id: top.id, action, value: rest.join(' ') } as CardAction);
        }
      }
      seen = lines.length;
    });
  }

  // QA: simulate plugging and unplugging mics by rewriting this JSON file ({ list, defaultLabel }).
  const qaDevices = process.env.DICTATE_QA_DEVICES;
  if (qaDevices) {
    log('warn', `QA device list from ${qaDevices}`);
    const apply = () => {
      const d = readJson(qaDevices) as { list: MicDevice[]; defaultLabel: string } | undefined;
      if (!d) return;
      devicesCache = d.list;
      onDevices(d);
    };
    fs.watchFile(qaDevices, { interval: 300 }, apply);
    apply();
  }
}

// ---------- coding agents ----------

let agents: Agents | undefined;
/** The surface features (src/main/features/), started with the agents. */
let surfaces: Surfaces | undefined;
/** The big surfaces' shared window, created when a surface first opens it. */
let sheet: Sheet;
/** The pill shows agent cards: it stays up, and takes clicks over the cards. */
let cardsShown = false;

/** Registration writes the person's real agent configs: packaged builds only. QA points it at a test home. */
function registrationOptions(): AgentsHost['registration'] {
  const testHome = process.env.DICTATE_AGENT_HOME;
  if (testHome) {
    return { allowed: true, executable: process.execPath, env: { ...process.env, HOME: testHome, USERPROFILE: testHome, CODEX_HOME: path.join(testHome, '.codex'), CLAUDE_CONFIG_DIR: testHome } };
  }
  const automated = !!process.env.DICTATE_SMOKE_TEST || !!process.env.DICTATE_QA_CONTROL;
  return { allowed: app.isPackaged && !automated, executable: process.env.APPIMAGE || process.execPath, env: process.env };
}

/** Removes the MCP entries and instruction blocks Dictate wrote, whatever the setting says; hand-written ones stay. */
async function removeAgentSetup(): Promise<void> {
  const r = registrationOptions();
  if (!r.allowed) return;
  const opts = { env: r.env, executable: r.executable, bridgePath: '', log };
  await unregisterAgents(opts);
  syncInstructions(opts, false);
}

function startAgents(): void {
  agents = new Agents({
    userData: userData(),
    appRoot: appRoot(),
    log,
    settings: () => settings,
    update: (patch) => updateSettings(patch),
    history: () => history,
    status: () => ({ modelsReady: sttReady, dictating: !!rec || finishing.size > 0 }),
    showCards: (view) => {
      cardsShown = !!view.top;
      topCardId = view.top?.id ?? null;
      // Before the cards: a card that takes the place of an open one is drawn closed.
      pollCardHover();
      pillSend('dictate:cards', view);
      if (cardsShown) showPill(pill);
      watchCardHover(cardsShown || extraRects.length > 0);
    },
    chime: () => pillSend('dictate:sound', 'chime'),
    openSettings: (page) => openSettings(page),
    openExternal: (url) => {
      if (/^https:\/\/\S+$/.test(url)) void shell.openExternal(url);
    },
    copy: (text) => writeClipboardText(text, { history: true }),
    paneInFront: () => /(^|[\\/])pane(\.exe)?$/i.test(foregroundProcessPath()),
    allowForeground: () => void allowForegroundHandoff(),
    registration: registrationOptions(),
    trayChanged: () => rebuildTrayMenu(),
    stateChanged: () => pushState(),
  });
  void agents.start().catch((e) => log('error', `agents did not start: ${(e as Error).message}`));
  startSurfaces(agents);
}

function startSurfaces(a: Agents): void {
  sheet = new Sheet(log);
  surfaces = new Surfaces({
    log,
    userData: userData(),
    settings: () => settings,
    update: (patch) => updateSettings(patch),
    agents: a,
    sheet,
    pill: {
      send: (channel, ...args) => pillSend(channel, ...args),
      show: () => showPill(pill),
      pointerOverCard,
    },
    windows: () => [pill, pickerWin, settingsWin, sheet.isOpen ? sheet.window() : undefined].filter((w): w is Electron.BrowserWindow => !!w && !w.isDestroyed()),
    preview: previewReply,
    recording: {
      start: (route) => {
        startRecording(route);
        onHotkey({ type: 'mode', mode: 'toggle', via: 'combo' });
      },
      stop: () => {
        machine.reset();
        void stopRecording();
      },
      // The feature ended it (a round done), so the pill just hides: only the person's Esc says "Cancelled".
      cancel: () => {
        machine.reset();
        onHotkey({ type: 'cancel', reason: 'shortcut' });
      },
      active: () => !!rec,
    },
    bindingsChanged: () => applyBindings(),
    stateChanged: () => pushState(),
  });
  surfaces.start();
}

app.on('window-all-closed', () => {
  // A tray app: closing settings does not quit.
});

app.on('before-quit', () => {
  quitting = true;
  saveSettings?.flush();
  saveHistory?.flush();
  globalShortcut.unregisterAll();
  setup.cancel();
  hook?.stop();
  nativeMic?.stop();
  cleanup?.stopAll();
  stt?.kill();
  agents?.stop();
  surfaces?.stop();
  sheet?.destroy();
  log('info', 'quit');
});
