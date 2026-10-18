// The overlay pill: what dictate is doing right now, a live level meter and the live partial text. It also
// hosts mic capture and the sound cues. Never takes focus (the window is not focusable).
import { dbfs } from '../core/audio';
import { dictate, h } from './bridge';
import * as capture from './capture';
import { type Cue, play } from './sounds';

export type PillState =
  | { kind: 'hidden' }
  | { kind: 'listening'; mode: 'push-to-talk' | 'toggle'; hotkey: string }
  | { kind: 'warming' }
  | { kind: 'transcribing' }
  | { kind: 'cleaning' }
  | { kind: 'done'; message: string }
  | { kind: 'copied'; message: string }
  | { kind: 'info'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'toast'; message: string; undo?: boolean; ms: number };

const BARS = 5;
/** Segoe Fluent Icons: check, copy, warning, microphone, info. */
const GLYPHS: Partial<Record<PillState['kind'], string>> = { done: '', copied: '', error: '', toast: '', info: '' };
const root = document.getElementById('root')!;
const bars = Array.from({ length: BARS }, () => h('span.bar'));
const meter = h('div.meter', {}, ...bars);
const spinner = h('div.spinner');
const glyph = h('div.glyph');
const icon = h('div.icon', {}, meter, spinner, glyph);
const text = h('div.text');
const hint = h('div.hint');
const undo = h('button.undo', { onclick: () => dictate.send('dictate:undo-mic') }, 'Undo');
const pill = h('div.pill', {}, icon, h('div.body', {}, text, hint), undo);
root.append(pill);

let state: PillState = { kind: 'hidden' };
let partial = '';
let silent = false;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
/** A short warning shown under the text without replacing the recording controls (a mic change). */
let notice = '';
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

function render(): void {
  const s = state;
  pill.dataset.kind = s.kind;
  undo.hidden = !(s.kind === 'toast' && s.undo);
  glyph.textContent = GLYPHS[s.kind] ?? '';
  switch (s.kind) {
    case 'listening':
      text.textContent = partial ? tail(partial) : 'Listening…';
      text.classList.toggle('placeholder', !partial);
      hint.textContent = silent ? 'Can’t hear you — check the mic' : s.mode === 'toggle' ? `${s.hotkey} to finish · Esc to cancel` : 'Release to finish · Esc to cancel';
      hint.classList.toggle('warn', silent);
      break;
    case 'warming':
      text.textContent = partial ? tail(partial) : 'Listening…';
      hint.textContent = 'Warming up the cleanup models…';
      hint.classList.remove('warn');
      break;
    case 'transcribing':
      text.textContent = partial ? tail(partial) : 'Transcribing…';
      text.classList.toggle('placeholder', !partial);
      hint.textContent = 'Transcribing…';
      hint.classList.remove('warn');
      break;
    case 'cleaning':
      text.textContent = partial ? tail(partial) : 'Cleaning…';
      hint.textContent = 'Cleaning…';
      hint.classList.remove('warn');
      break;
    case 'done':
    case 'copied':
    case 'info':
    case 'error':
    case 'toast':
      text.textContent = s.message;
      text.classList.remove('placeholder');
      hint.textContent = '';
      break;
  }
  if (notice && (s.kind === 'listening' || s.kind === 'warming' || s.kind === 'transcribing' || s.kind === 'cleaning')) {
    hint.textContent = notice;
    hint.classList.add('warn');
  }
  pill.classList.toggle('compact', !hint.textContent);
}

dictate.on('dictate:notice', (msg: string) => {
  notice = msg;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice = '';
    render();
  }, 4000);
  render();
});

function tail(t: string): string {
  return t.length > 90 ? `…${t.slice(-89)}` : t;
}

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
  if (s.kind === 'listening' && state.kind !== 'listening') silent = false;
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
  if (state.kind === 'listening' || state.kind === 'transcribing' || state.kind === 'warming') render();
});

dictate.on('dictate:reset-partial', () => {
  partial = '';
});

dictate.on('dictate:sound', (cue: Cue) => play(cue));

// ---------- capture ----------

capture.setLevelListener((rms) => {
  // -60 dBFS .. -12 dBFS onto 0..1, each bar with its own sensitivity so the meter has shape.
  const v = Math.max(0, Math.min(1, (dbfs(rms) + 60) / 48));
  for (let i = 0; i < BARS; i++) {
    const shape = [0.55, 0.85, 1, 0.8, 0.6][i];
    bars[i].style.transform = `scaleY(${Math.max(0.18, Math.min(1, v * shape * 1.25))})`;
  }
});

dictate.on('dictate:silent-state', (s: boolean) => {
  silent = s;
  render();
});

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
