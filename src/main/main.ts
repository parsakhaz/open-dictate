// dictate: a tray app. Hold Right Ctrl (or double-tap it) and speak; on release the words are transcribed
// locally, cleaned by local LLMs and typed into the focused app.
import fs from 'node:fs';
import path from 'node:path';
import { app, globalShortcut, ipcMain, Menu, MessageChannelMain, powerMonitor, screen, session, shell, systemPreferences, Tray, type UtilityProcess, utilityProcess } from 'electron';
import { dbfs, defaultGainDb } from '../core/audio';
import { CaptureController, type CaptureEvents } from '../core/capture';
import { runChain } from '../core/chain';
import { HistoryStore } from '../core/history';
import { type Bindings, bindingFromKeys, bindingLabel, type HotkeyAction, HotkeyMachine, isModifier, menuMaskKeys, type RecordMode, swallowBindings, VK } from '../core/hotkeys';
import { DEFAULT_SEGMENTER, LiveCleanup, Segmenter } from '../core/live';
import { type MicDevice, type MicEvent, MicSelector, micKey, micName } from '../core/mics';
import { appliesMeasuredChain, keepsLlamaServer, upgradedOnboarded } from '../core/onboarding';
import { finishHint } from '../core/pillhint';
import { applyEnv, GEMMA_GGUF, parseSettings, resolveModelsDir, STT_MODEL } from '../core/settings';
import type { Binding, Settings } from '../core/types';
import { parseVocabularyFile } from '../core/vocabulary';
import { WarmMic } from '../core/warm';
import type { SttToMain } from '../engine/stt-worker';
import type { FromHook } from '../native/keyhook-worker';
import { accessibilityGranted, batterySaverOn, caretRect, foregroundWindow, isWindow, killWithUs, platformCapabilities, requestAccessibility, setForeground, writeClipboardText } from '../native/platform';
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
import type { AgentServer } from './agentserver';
import { installBridge, startAgentChannel } from './agents';

if (process.env.DICTATE_DATA_DIR) app.setPath('userData', process.env.DICTATE_DATA_DIR);
app.setName('dictate');
if (process.platform === 'win32') app.setAppUserModelId('org.dictate.Dictate');
if (process.platform === 'linux') app.setDesktopName('org.dictate.Dictate');
// Headless runners may expose a GPU device without a functioning compositor. Keep screenshot QA deterministic.
if (process.env.DICTATE_SMOKE_TEST) app.disableHardwareAcceleration();

// The isolated container used for local QA forbids AF_UNIX sockets. Native CI keeps the real lock enabled.
const isolatedQa = !!process.env.DICTATE_DATA_DIR && (!!process.env.DICTATE_SMOKE_TEST || !!process.env.DICTATE_QA_CONTROL);
const skipInstanceLock = isolatedQa && process.env.DICTATE_SMOKE_SKIP_INSTANCE_LOCK === '1';
if (!skipInstanceLock && !app.requestSingleInstanceLock()) {
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
  hook.send({ type: 'recording', on: !!rec || cancellable.size > 0 });
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

function gainFor(d: MicDevice | null): number {
  const label = d?.label ?? defaultMicLabel;
  return settings.gainDb[micKey(label)] ?? defaultGainDb(label);
}

function onHotkey(a: HotkeyAction): void {
  switch (a.type) {
    case 'start': {
      if (rec) return;
      if (!sttReady) {
        // Show why nothing happens, but only for a real press (mode), not a tap.
        rec = { id: nextId++, mode: null, shown: false, releasedAt: 0, partial: '', live: false, abort: new AbortController() };
        return;
      }
      rec = { id: nextId++, mode: null, shown: false, releasedAt: 0, partial: '', live: false, abort: new AbortController() };
      cleanup.touch();
      // Capture starts at key down so the first word is not lost; the pill waits until this is a hold or a double-tap.
      keyDownAt = performance.timeOrigin + performance.now();
      router.start(rec.id, micDevice()?.deviceId ?? null, gainFor(micDevice()));
      startLiveCleanup(rec);
      pillSend('dictate:enumerate');
      syncEsc();
      return;
    }
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
      const finish = finishHint(a.mode, a.via, { hotkey: hotkeyLabel(a.key), toggle: bindingLabel(settings.toggle) });
      pillSend('dictate:pill', cleanup.warming() ? { kind: 'warming', finish } : { kind: 'listening', mode: a.mode, finish, starting: !rec.live });
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
  }
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
  const deps = { chain: cleanup.deps(), sink: practice ? practiceSink : sink, history, saveHistory: () => saveHistory.now(), log, clean, pressEnter: settings.pressEnter, signal: s.abort.signal };
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
  if (d?.pasted && d.confirmed === false) pillSend('dictate:pill', { kind: 'copied', message: 'Pasted — also on the clipboard' });
  else if (d?.pasted) pillSend('dictate:pill', { kind: 'done', message: `${settings.output === 'both' ? 'Pasted and copied' : 'Pasted'}${d.entered ? ' · Enter' : ''}` });
  else if (d?.copied) pillSend('dictate:pill', { kind: 'copied', message: settings.output === 'clipboard' ? 'Copied' : `Copied — press ${pasteKeys}` });
  else pillSend('dictate:pill', { kind: 'error', message: `Could not paste — it’s in History (${bindingLabel(settings.picker)})` });
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
  if (rec?.id === id && rec.shown) pillSend('dictate:notice', `${micName(label || 'Microphone')} stopped — using the default mic`);
  pillSend('dictate:enumerate');
}

function captureFailed(id: number, message: string): void {
  log('error', `capture ${id}: no mic could be reopened (${message}); finishing with what was heard`);
  if (rec?.id !== id) return;
  machine.reset();
  if (rec.shown) pillSend('dictate:notice', 'Microphone lost — keeping what you said');
  void stopRecording();
}

function silentState(id: number, silent: boolean): void {
  if (rec?.id === id) pillSend('dictate:silent-state', silent);
}

const browserCapture: CapturePath = {
  start: (id, deviceId, gainDb) => pillSend('dictate:capture-start', { id, deviceId, gainDb, fakeWav }),
  stop: (id) => pillSend('dictate:capture-stop', { id }),
  cancel: (id) => pillSend('dictate:capture-cancel', { id }),
  switchDevice: (id, deviceId, gainDb) => pillSend('dictate:capture-switch', { id, deviceId, gainDb }),
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
  start: (id, deviceId, gainDb) => void nativeCapture!.start(id, deviceId, gainDb),
  stop: (id) => void nativeCapture!.stop(id),
  cancel: (id) => void nativeCapture!.cancel(id),
  switchDevice: (id, deviceId, gainDb) => void nativeCapture!.switchDevice(id, deviceId, gainDb),
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
    const msg = `${micName(e.from)} disconnected — using ${e.to ? micName(e.to) : 'the default mic'}`;
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

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function showToast(message: string, undo: boolean, ms: number): void {
  pillSend('dictate:pill', { kind: 'toast', message, undo, ms });
  showPill(pill);
  clearTimeout(toastTimer);
  if (undo) {
    pill.setIgnoreMouseEvents(false);
    toastTimer = setTimeout(() => pill.setIgnoreMouseEvents(true), ms);
  }
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
  if (!platformCapabilities().canSwallowKeys) w.on('blur', () => closePicker());
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
  if (d && !req.copyOnly && !d.pasted) showToast(d.copied ? `Copied — press ${pasteKeys}` : 'Could not paste or copy', false, 3500);
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
  // Esc after release cancels a dictation still transcribing or cleaning (the hook swallowed it).
  if (e.down && e.vk === VK.Escape && !rec && cancellable.size) {
    cancelAfterRelease();
    return;
  }
  if (picker.isOpen) {
    if (!platformCapabilities().canSwallowKeys) return;
    // Alt and Win combos (Alt+Tab, Win+D) are the person leaving: let them through and close.
    if (e.down && [0xa4, 0xa5, 0x5b, 0x5c].includes(e.vk)) closePicker();
    else if (e.down && !isModifier(e.vk)) picker.send('dictate:picker-key', { vk: e.vk, shift: e.shift });
    return;
  }
  if (e.down) machine.down(e.vk, e.t);
  else machine.up(e.vk, e.t);
}

function bindings(): Bindings {
  return { hotkeys: settings.hotkeys, toggle: settings.toggle, picker: settings.picker };
}

function applyBindings(): void {
  machine.configure(bindings(), { tapMs: settings.tapMs, doubleTapMs: settings.doubleTapMs });
  // Swallow the last key of each combo so the app never sees it (Right Ctrl+V must not paste), and dedicated
  // dictation keys (F13). Mask lone Alt/Win presses of the bindings, so dictating with Right Alt never opens a menu bar.
  hook.send({ type: 'config', swallow: swallowBindings(bindings()), mask: menuMaskKeys(bindings()) });
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
  if (patch.hotkeys !== undefined || patch.toggle !== undefined || patch.picker !== undefined || patch.tapMs !== undefined || patch.doubleTapMs !== undefined) applyBindings();
  if (patch.historyLimit !== undefined) history.setLimit(settings.historyLimit);
  if (patch.micWarm !== undefined) warm?.settingChanged();
  if (patch.pillText !== undefined) pillConfig();
  if (patch.startAtLogin !== undefined) applyLoginItem();
  if (patch.autoUpdate !== undefined) updater?.setEnabled(settings.autoUpdate);
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
  ipcMain.handle('dictate:open-url', (_e, url: string) => {
    // Only the licence and source links the pages show: https, never a file or app protocol.
    if (typeof url === 'string' && /^https:\/\/\S+$/.test(url)) return shell.openExternal(url);
  });

  ipcMain.on('dictate:pill-ready', () => {
    log('info', 'pill ready');
    pillConfig();
    sttLink.pillReady();
  });
  ipcMain.on('dictate:renderer-error', (_e, page: string, message: string) => log('error', `renderer ${page}: ${String(message).slice(0, 2000)}`));
  ipcMain.on('dictate:pill-hidden', () => {
    if (!rec?.shown) pill.hide();
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
  ipcMain.on('dictate:undo-mic', () => {
    const d = mics.undo();
    log('info', `undo mic switch: back to ${d?.label ?? 'system default'}`);
    pill.setIgnoreMouseEvents(true);
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
    foreground: foregroundWindow,
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
  void startAgents().catch((e) => log('error', `agents did not start: ${(e as Error).message}`));

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
        else if (line === 'escape') { machine.down(VK.Escape, t); machine.up(VK.Escape, t + 1); }
        else if (line === 'quit') app.quit();
        // Bring Settings to the front, as a click would (Getting started's practice box needs it focused).
        else if (line === 'focus') { app.focus({ steal: true }); settingsWin?.show(); settingsWin?.focus(); }
        else if (line.startsWith('shot ')) pillShot(line.slice(5), 0);
        else if (line.startsWith('state ')) {
          pillSend('dictate:pill', JSON.parse(line.slice(6)));
          showPill(pill);
        } else if (line.startsWith('partial ')) pillSend('dictate:partial', line.slice(8));
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

let agentServer: AgentServer | undefined;

function agentStatus() {
  return { running: true, modelsReady: sttReady, dictating: !!rec || finishing.size > 0, doNotDisturb: false, historyAccess: false };
}

async function startAgents(): Promise<void> {
  installBridge(appRoot(), userData(), log);
  agentServer = await startAgentChannel(userData(), {
    call: async (_session, tool) => {
      if (tool === 'status') return agentStatus();
      throw new Error(`${tool} isn't available in this version of Dictate`);
    },
    log,
  }, log);
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
  agentServer?.stop();
  log('info', 'quit');
});
