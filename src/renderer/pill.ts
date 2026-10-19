// The overlay pill: what dictate is doing right now, a live waveform and the live words. It also hosts mic
// capture (the browser fallback path) and the sound cues. Never takes focus (the window is not focusable).
// Small and centred, its width following its content; every state keeps the same height and cross-fades.
import { dbfs } from '../core/audio';
import { hintVisible } from '../core/pillhint';
import { dictate, h } from './bridge';
import * as capture from './capture';
import { type Cue, play } from './sounds';

export type PillState =
  | { kind: 'hidden' }
  /** `starting`: the mic is still opening; the waveform is grey and flat until its first audio. */
  | { kind: 'listening'; mode: 'push-to-talk' | 'toggle'; finish: string; starting?: boolean }
  | { kind: 'warming'; finish?: string }
  | { kind: 'transcribing' }
  | { kind: 'cleaning' }
  | { kind: 'done'; message: string }
  | { kind: 'copied'; message: string }
  | { kind: 'info'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'toast'; message: string; undo?: boolean; ms: number };

export interface PillConfig {
  /** Design variant (the comparison build); 'a' otherwise. */
  variant: 'a' | 'b' | 'c';
  /** Show the live words; off leaves just the waveform. */
  showText: boolean;
}

const BARS = 9;
/** Segoe Fluent Icons: check, copy, warning, info, microphone. */
const GLYPHS: Partial<Record<PillState['kind'], string>> = { done: '✓', copied: '⧉', error: '⚠', info: 'ⓘ', toast: '●' };

const root = document.getElementById('root')!;
const bars = Array.from({ length: BARS }, () => h('span.bar'));
const wave = h('div.wave', {}, ...bars);
const dot = h('span.dot');
const spinner = h('span.spinner');
const glyph = h('span.glyph');
const lead = h('div.lead', {}, dot, spinner, glyph);
const text = h('span.text');
const textwrap = h('div.textwrap', {}, text);
const undo = h('button.undo', { onclick: () => dictate.send('dictate:undo-mic') }, 'Undo');
const content = h('div.content', {}, lead, wave, textwrap, undo);
const pill = h('div.pill', {}, content);
/** Above the pill: the hint for the first seconds of the first recordings, or the caption (variant B). */
const above = h('div.above');
root.append(above, pill);

let config: PillConfig = { variant: 'a', showText: true };
let state: PillState = { kind: 'hidden' };
let partial = '';
let silent = false;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
/** A short warning in place of the hint (a mic change), without leaving the recording state. */
let notice = '';
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let sessionStart = 0;
let hintTimer: ReturnType<typeof setTimeout> | undefined;

function sessionsSeen(): number {
  try {
    return Number(localStorage.getItem('dictate.hintSessions') ?? '0') || 0;
  } catch {
    return 99;
  }
}
function countSession(): void {
  try {
    localStorage.setItem('dictate.hintSessions', String(sessionsSeen() + 1));
  } catch {
    // storage unavailable: no hint
  }
}
let hintAllowed = false;

const recording = (k: PillState['kind']) => k === 'listening' || k === 'warming';
const working = (k: PillState['kind']) => k === 'transcribing' || k === 'cleaning';

function words(): string {
  if (state.kind === 'listening') return partial || (state.starting ? 'Starting…' : 'Listening…');
  if (state.kind === 'warming') return partial || 'Warming up…';
  if (state.kind === 'transcribing') return partial || 'Transcribing…';
  if (state.kind === 'cleaning') return partial || 'Cleaning up…';
  if ('message' in state) return state.message;
  return '';
}

function render(): void {
  const s = state;
  root.dataset.variant = config.variant;
  pill.dataset.kind = s.kind;
  pill.dataset.starting = String(s.kind === 'listening' && !!s.starting);
  pill.dataset.placeholder = String((recording(s.kind) || working(s.kind)) && !partial);
  pill.dataset.silent = String(recording(s.kind) && silent);
  undo.hidden = !(s.kind === 'toast' && s.undo);
  glyph.textContent = GLYPHS[s.kind] ?? '';
  // Working states animate the bars themselves (a travelling pulse), not the last level.
  if (!recording(s.kind)) for (const b of bars) b.style.transform = '';
  const live = recording(s.kind) || working(s.kind);
  // Without live words the recording states are just the waveform.
  const showWords = !live || config.showText;
  textwrap.hidden = !showWords;
  text.textContent = showWords ? words() : '';

  let line = '';
  if (notice && live) line = notice;
  else if (recording(s.kind) && silent) line = 'Can’t hear you — check the mic';
  else if (s.kind === 'listening' && hintAllowed && hintVisible(0, performance.now() - sessionStart)) line = `${s.finish} · Esc to cancel`;
  // Variant B carries the live words above a waveform-only pill.
  if (config.variant === 'b' && live && config.showText && !line) {
    above.textContent = words();
    above.dataset.role = 'caption';
    textwrap.hidden = true;
  } else {
    above.textContent = line;
    above.dataset.role = notice || silent ? 'warn' : 'hint';
  }
  above.classList.toggle('shown', !!above.textContent);
  fitWidth();
}

/** The pill hugs its content: width follows the measured content, eased, never jumping in height. */
function fitWidth(): void {
  requestAnimationFrame(() => {
    const clipped = text.scrollWidth > textwrap.clientWidth + 1;
    textwrap.classList.toggle('clipped', clipped);
    pill.style.width = `${Math.ceil(content.scrollWidth)}px`;
  });
}

dictate.on('dictate:pill-config', (c: PillConfig) => {
  config = c;
  render();
});

dictate.on('dictate:notice', (msg: string) => {
  notice = msg;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice = '';
    render();
  }, 4000);
  render();
});

function show(): void {
  clearTimeout(hideTimer);
  root.classList.add('visible');
}

function hideAfter(ms: number): void {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    root.classList.remove('visible');
    // Wait for the fade before telling main the window can hide.
    setTimeout(() => {
      if (!root.classList.contains('visible')) dictate.send('dictate:pill-hidden');
    }, 220);
  }, ms);
}

dictate.on('dictate:pill', (s: PillState) => {
  if (s.kind === 'listening' && state.kind !== 'listening') {
    silent = false;
    sessionStart = performance.now();
    hintAllowed = hintVisible(sessionsSeen(), 0);
    if (hintAllowed) countSession();
    clearTimeout(hintTimer);
    hintTimer = setTimeout(render, 3050);
  }
  state = s;
  if (s.kind === 'hidden') {
    partial = '';
    root.classList.remove('visible');
    return;
  }
  render();
  show();
  if (s.kind === 'done') hideAfter(900);
  else if (s.kind === 'copied') hideAfter(3500);
  else if (s.kind === 'info') hideAfter(1600);
  else if (s.kind === 'error') hideAfter(4000);
  else if (s.kind === 'toast') hideAfter(s.ms);
  if (s.kind === 'done' || s.kind === 'copied' || s.kind === 'info' || s.kind === 'error' || s.kind === 'toast') partial = '';
});

dictate.on('dictate:partial', (t: string) => {
  partial = t;
  if (recording(state.kind) || working(state.kind)) render();
});

dictate.on('dictate:reset-partial', () => {
  partial = '';
});

dictate.on('dictate:sound', (cue: Cue) => play(cue));

dictate.on('dictate:live', () => {
  if (state.kind === 'listening' && state.starting) {
    state = { ...state, starting: false };
    render();
  }
});

// ---------- the waveform ----------

/** The last BARS levels, newest in the middle-right: a short scrolling trace of the voice. */
const history: number[] = Array(BARS).fill(0);
const SHAPE = [0.45, 0.6, 0.75, 0.9, 1, 0.9, 0.75, 0.6, 0.45];

function showLevel(rms: number): void {
  if (!recording(state.kind)) return;
  // -60 dBFS .. -6 dBFS onto 0..1, eased so normal speech sits mid-height and only peaks reach the top.
  const v = Math.max(0, Math.min(1, (dbfs(rms) + 60) / 54)) ** 1.6;
  history.shift();
  history.push(v);
  for (let i = 0; i < BARS; i++) {
    // Mix the trace with the current level so the centre always moves with the voice.
    const x = 0.55 * history[i] + 0.45 * v;
    bars[i].style.transform = `scaleY(${Math.max(0.15, Math.min(1, x * SHAPE[i] * 1.1))})`;
  }
}

// Levels come from the capture here (browser path) or from main (native capture).
capture.setLevelListener(showLevel);
dictate.on('dictate:level', showLevel);

dictate.on('dictate:silent-state', (s: boolean) => {
  silent = s;
  render();
});

// ---------- capture (the browser fallback path) ----------

dictate.on('dictate:capture-start', (a: { id: number; deviceId: string | null; gainDb: number; fakeWav?: Uint8Array }) => {
  partial = '';
  void capture.start(a.id, a.deviceId, a.gainDb, a.fakeWav);
});
dictate.on('dictate:capture-stop', (a: { id: number }) => void capture.stop(a.id));
dictate.on('dictate:capture-cancel', (a: { id: number }) => void capture.cancel(a.id));
dictate.on('dictate:capture-switch', (a: { id: number; deviceId: string | null; gainDb: number }) => void capture.switchDevice(a.id, a.deviceId, a.gainDb));

const report = (d: capture.DeviceList) => dictate.send('dictate:devices', d);
dictate.on('dictate:enumerate', async () => report(await capture.devices()));
capture.watchDevices(report);

void capture.prepare().then(async () => {
  report(await capture.devices());
  dictate.send('dictate:pill-ready');
});
