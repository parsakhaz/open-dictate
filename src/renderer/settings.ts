// The settings window: the first-run walkthrough (Getting started), then pages for
// hotkeys, microphone, cleanup, vocabulary, history, advanced paths and about.
import { dbfs, defaultGainDb } from '../core/audio';
import { bindingLabel, dictationKeyProblem } from '../core/hotkeys';
import type { MicDevice } from '../core/mics';
import { micKey, micName } from '../core/mics';
import { canGoBack, canSkip, nextStep, previousStep, resumeStep, STEPS, type Step, stepNumber, tryReady } from '../core/onboarding';
import { displaySize, THIRD_PARTY } from '../core/thirdparty';
import type { Binding, CleanupChain, OutputMode, Settings, VocabTerm } from '../core/types';
import { dictate, h } from './bridge';

interface State {
  settings: Settings;
  labels: { hotkey: string; hotkeys: string[]; toggle: string; picker: string };
  devices: MicDevice[];
  mic: MicDevice | null;
  defaultMicLabel: string;
  gain: number;
  micBluetooth: boolean;
  stt: 'ready' | 'error' | 'loading';
  sttError: string;
  servers: { gemma: string; emberon: string };
  effectiveChain: CleanupChain;
  onBattery: boolean;
  missing: string[];
  history: { count: number; samples: number; median: number | null };
  logFile: string;
  version: string;
  platform: { platform: string; displayServer: string; globalHotkeys: boolean; canSwallowKeys: boolean; automaticPaste: boolean; accessibilityRequired: boolean; accessibilityGranted: boolean; reason?: string };
  microphonePermission: string;
  setup: { phase: string; kind?: string; file?: string; received?: number; total?: number; message?: string; overallReceived?: number; overallTotal?: number; bytesPerSecond?: number; etaSeconds?: number; step?: number; steps?: number };
  speechInstalled: boolean;
  essentialsReady: boolean;
  gemmaInstalled: boolean;
  sizes: { essentials: number; gemma: number };
  hardwareRunning: boolean;
  hardwareError: string;
  dataDir: string;
  shortcutRegistered: boolean;
  shortcutRequested: boolean;
  startupError: string;
  recording: boolean;
  automation: boolean;
}

type Page = 'start' | 'general' | 'microphone' | 'cleanup' | 'vocabulary' | 'history' | 'advanced' | 'about';

const PAGES: { id: Page; label: string; icon: string }[] = [
  { id: 'start', label: 'Getting started', icon: '⌂' },
  { id: 'general', label: 'Hotkeys & output', icon: '⌨' },
  { id: 'microphone', label: 'Microphone', icon: '●' },
  { id: 'cleanup', label: 'Cleanup', icon: '✦' },
  { id: 'vocabulary', label: 'Vocabulary', icon: 'Aa' },
  { id: 'history', label: 'History', icon: '◷' },
  { id: 'advanced', label: 'Advanced', icon: '⚙' },
  { id: 'about', label: 'About', icon: 'ⓘ' },
];

let st: State;
let page: Page = 'general';
let actionError = '';
let welcomeStartAtLogin = true;
let renderedPage: Page | undefined;
let renderPending = false;
let pointerActive = false;
const pasteKeys = () => st.platform.platform === 'darwin' ? 'Cmd+V' : 'Ctrl+V';
const osName = () => ({win32:'Windows',darwin:'macOS',linux:'Linux'}[st.platform.platform] ?? st.platform.platform);
const nav = h('nav.nav');
const content = h('main.content');
document.getElementById('root')!.append(h('header.titlebar', {}, h('span.appicon', {}, '●'), h('span', {}, 'dictate')), h('div.shell', {}, nav, content));

async function refresh(next: Promise<State>): Promise<void> {
  st = await next;
  render();
}

const set = (patch: Partial<Settings>) => refresh(dictate.invoke<State>('dictate:set-settings', patch));
const pickMic = (deviceId: string | null) => refresh(dictate.invoke<State>('dictate:pick-mic', deviceId));

// ---------- building blocks ----------

function card(title: string, desc: string | Node | null, control?: Node | null, extra?: Node | null): HTMLElement {
  return h('section.card', {}, h('div.cardrow', {}, h('div.cardtext', {}, h('div.cardtitle', {}, title), desc ? h('div.carddesc', {}, desc) : null), control ? h('div.control', {}, control) : null), extra ?? null);
}

function toggle(on: boolean, onChange: (v: boolean) => void, label?: string): HTMLElement {
  const text = h('span.toggletext', {}, on ? 'On' : 'Off');
  const input = h('input', { type: 'checkbox', checked: on, onchange: (e: Event) => {
    const checked = (e.target as HTMLInputElement).checked;
    text.textContent = checked ? 'On' : 'Off';
    onChange(checked);
  } });
  return h('label.toggle', {}, text, input, h('span.track', {}, h('span.thumb')), label ? h('span.sr', {}, label) : null);
}

function select<T extends string>(value: T, options: [T, string][], onChange: (v: T) => void): HTMLSelectElement {
  const s = h('select.select', { onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value as T) }, ...options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  return s;
}

function radios<T extends string>(name: string, value: T, options: [T, string, string][], onChange: (v: T) => void): HTMLElement {
  return h(
    'div.radios',
    {},
    ...options.map(([v, l, d]) =>
      h('label.radio', {}, h('input', { type: 'radio', name, checked: v === value, onchange: () => onChange(v) }), h('span.radiodot'), h('span.radiotext', {}, h('span', {}, l), d ? h('span.radiodesc', {}, d) : null)),
    ),
  );
}

function keycap(label: string): HTMLElement {
  return h('span.keys', {}, ...label.split(' + ').map((k) => h('kbd', {}, k)));
}

function bindingControl(which: 'toggle' | 'picker', canClear: boolean): HTMLElement {
  const label = st.labels[which];
  const box = h('div.binding', {}, label === 'Off' ? h('span.muted', {}, 'Off') : keycap(label));
  const change = h(
    'button.button',
    {
      onclick: async () => {
        box.replaceChildren(h('span.recording', {}, 'Press the keys, then release…'));
        change.disabled = true;
        const b = await dictate.invoke<Binding | null>('dictate:record-binding');
        change.disabled = false;
        if (b) await set({ [which]: b } as Partial<Settings>);
        else render();
      },
    },
    'Change',
  );
  const clear = canClear && label !== 'Off' ? h('button.button.subtle', { onclick: () => set({ [which]: null } as Partial<Settings>) }, 'Turn off') : null;
  return h('div.bindingrow', {}, box, change, clear);
}

const R_CTRL = 0xa3;
const R_ALT = 0xa5;
const F13 = 0x7c;
const V = 0x56;
const MAX_KEYS = 4;
const same = (a: Binding | null, b: Binding) => !!a && a.keys.length === b.keys.length && a.keys.every((k, i) => k === b.keys[i]);

/**
 * One key for dictation: Right Ctrl or Right Alt (for keyboards without Right Ctrl). The picker moves along with
 * it while it is still that key + V.
 */
function useKey(key: number): Promise<void> {
  const other = key === R_ALT ? R_CTRL : R_ALT;
  const picker = st.settings.picker;
  const follow = !picker || same(picker, { keys: [other, V] });
  return set({ hotkeys: [{ keys: [key] }], ...(follow ? { picker: { keys: [key, V] } } : {}) });
}

const hasKey = (b: Binding) => st.settings.hotkeys.some((k) => same(k, b));

/** Records a dictation key; null if cancelled, a duplicate, or refused (the reason is shown in `note`). */
async function recordDictationKey(note: HTMLElement): Promise<Binding | null> {
  const b = await dictate.invoke<Binding | null>('dictate:record-binding');
  if (!b) return null;
  const problem = dictationKeyProblem(b);
  note.textContent = problem ?? (hasKey(b) ? `${bindingLabel(b)} is already a dictation key.` : '');
  return problem || hasKey(b) ? null : b;
}

/** Every dictation key (B2): change or remove each, add another, or add/remove a quick pick. */
function dictationKeys(): HTMLElement {
  const keys = st.settings.hotkeys;
  const note = h('div.warnline');
  const setKeys = (next: Binding[]) => set({ hotkeys: next });
  const rows = keys.map((b, i) => {
    const box = h('div.binding', {}, keycap(st.labels.hotkeys[i] ?? bindingLabel(b)));
    const change = h(
      'button.button',
      {
        onclick: async () => {
          box.replaceChildren(h('span.recording', {}, 'Press the keys, then release…'));
          change.disabled = true;
          const nb = await recordDictationKey(note);
          change.disabled = false;
          if (nb) await setKeys(keys.map((k, j) => (j === i ? nb : k)));
          else box.replaceChildren(keycap(st.labels.hotkeys[i] ?? bindingLabel(b)));
        },
      },
      'Change',
    );
    const remove = keys.length > 1 ? h('button.button.subtle', { onclick: () => setKeys(keys.filter((_, j) => j !== i)) }, 'Remove') : null;
    return h('div.bindingrow', {}, box, change, remove);
  });
  const add =
    keys.length < MAX_KEYS
      ? h(
          'button.button',
          {
            onclick: async (e: Event) => {
              const btn = e.currentTarget as HTMLButtonElement;
              btn.textContent = 'Press the keys, then release…';
              btn.disabled = true;
              const nb = await recordDictationKey(note);
              if (nb) await setKeys([...keys, nb]);
              else {
                btn.textContent = 'Add another key';
                btn.disabled = false;
              }
            },
          },
          'Add another key',
        )
      : null;
  const chips: [string, Binding][] = [['Right Ctrl', { keys: [R_CTRL] }], ['Right Alt', { keys: [R_ALT] }], ['F13', { keys: [F13] }]];
  const quick = h(
    'div.presets',
    {},
    h('span.muted', {}, 'Quick pick:'),
    ...chips.map(([label, b]) => {
      const on = hasKey(b);
      const click = () => (on ? keys.length > 1 && setKeys(keys.filter((k) => !same(k, b))) : keys.length < MAX_KEYS && setKeys([...keys, b]));
      return h('button.chip', { 'data-active': String(on), onclick: click }, label);
    }),
  );
  return h('div.keylist', {}, ...rows, add, note, quick);
}

function presets(which: 'hotkey' | 'picker'): HTMLElement {
  const options: [string, Binding][] =
    which === 'hotkey'
      ? [['Right Ctrl', { keys: [R_CTRL] }], ['Right Alt', { keys: [R_ALT] }]]
      : [['Right Ctrl + V', { keys: [R_CTRL, V] }], ['Right Alt + V', { keys: [R_ALT, V] }]];
  return h(
    'div.presets',
    {},
    h('span.muted', {}, 'Quick pick:'),
    ...options.map(([label, b]) =>
      h(
        'button.chip',
        { 'data-active': String(same(which === 'hotkey' ? (st.settings.hotkeys.length === 1 ? st.settings.hotkeys[0] : null) : st.settings.picker, b)), onclick: () => (which === 'hotkey' ? useKey(b.keys[0] as number) : set({ picker: b })) },
        label,
      ),
    ),
  );
}

// ---------- level meters ----------

interface Meter {
  stream: MediaStream;
  ctx: AudioContext;
  analyser: AnalyserNode;
  el: HTMLElement;
  label: string;
}

let meters: Meter[] = [];
/** Meters refresh at ~25 fps: smooth enough to read, a fraction of the cost of every frame. */
let meterTimer: ReturnType<typeof setTimeout> | undefined;

/** Bumped by stopMeters(): a mic that finishes opening for an older page is closed at once. */
let meterGen = 0;

function stopMeters(): void {
  meterGen++;
  clearTimeout(meterTimer);
  for (const m of meters) {
    for (const t of m.stream.getTracks()) t.stop();
    void m.ctx.close();
  }
  meters = [];
}

async function startMeter(deviceId: string | null, label: string, el: HTMLElement): Promise<void> {
  const gen = meterGen;
  if (document.hidden || st.automation) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    // The page changed, or the window was hidden, while the mic was opening.
    if (gen !== meterGen || document.hidden || !el.isConnected) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    meters.push({ stream, ctx, analyser, el, label });
    if (meters.length === 1) loop();
  } catch {
    el.classList.add('unavailable');
  }
}

function gainOf(label: string): number {
  return st.settings.gainDb[micKey(label)] ?? defaultGainDb(label);
}

function loop(): void {
  const buf = new Float32Array(1024);
  const tick = () => {
    for (const m of meters) {
      m.analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const x of buf) sum += x * x;
      const rms = Math.sqrt(sum / buf.length) * 10 ** (gainOf(m.label) / 20);
      const v = Math.max(0, Math.min(1, (dbfs(rms) + 60) / 54));
      m.el.style.setProperty('--level', String(v));
      m.el.classList.toggle('hot', dbfs(rms) > -3);
    }
    meterTimer = setTimeout(tick, 40);
  };
  meterTimer = setTimeout(tick, 40);
}

function meterEl(): HTMLElement {
  return h('div.meter', {}, h('div.meterfill'));
}

async function action(channel: string, ...args: unknown[]): Promise<void> {
  actionError = '';
  try { await dictate.invoke(channel, ...args); st = await dictate.invoke<State>('dictate:get-state'); }
  catch (err) { actionError = (err as Error).message; }
  render();
}

function modelCard(kind: 'speech' | 'cleanup'): HTMLElement {
  const busy = st.setup.phase === 'downloading' || st.setup.phase === 'extracting';
  const progress = setupProgress(kind);
  const title = kind === 'speech' ? 'Speech model' : 'Optional local cleanup';
  const desc = kind === 'speech'
    ? (st.speechInstalled ? st.stt === 'ready' ? 'Nemotron English streaming model is ready.' : st.stt === 'error' ? `Speech model error: ${st.sttError}` : 'Nemotron English streaming model is installed and loading…' : 'Download 443 MB once to transcribe English locally. No account or API key needed.')
    : 'Download Gemma, Emberon and llama.cpp (about 3.2 GB) for local text cleanup, then times them here and picks what is fast enough. Raw dictation works without these.';
  const button = h('button.button', {'data-setup-download': kind, disabled: busy || (kind === 'speech' && st.speechInstalled), onclick: () => void action('dictate:setup-models', kind)}, kind === 'speech' && st.speechInstalled ? 'Installed' : `Download ${kind === 'speech' ? 'speech model' : 'cleanup models'}`);
  return card(title, h('span', {}, desc, h('div.warnline', {'data-setup-progress': kind, hidden: !progress}, progress)), h('div.bindingrow', {}, button, h('button.button.subtle', {'data-setup-cancel': kind, hidden: !busy || !setupIs(kind), onclick: () => void action('dictate:cancel-setup')}, 'Cancel')));
}

/** Getting started's essentials download includes the speech model, so the speech card follows it too. */
const setupIs = (kind: 'speech' | 'cleanup') => st.setup.kind === kind || (kind === 'speech' && st.setup.kind === 'essentials');

function setupProgress(kind: 'speech' | 'cleanup'): string {
  if (!setupIs(kind)) return '';
  if (st.setup.phase === 'downloading') return `Downloading ${st.setup.file}: ${Math.round((st.setup.received ?? 0) / 1048576)} / ${Math.round((st.setup.total ?? 0) / 1048576)} MB`;
  if (st.setup.phase === 'extracting') return 'Verifying and installing…';
  return st.setup.phase === 'error' ? st.setup.message ?? 'Download failed. Try again.' : '';
}

function updateSetupProgress(): void {
  const busy = st.setup.phase === 'downloading' || st.setup.phase === 'extracting';
  for (const kind of ['speech', 'cleanup'] as const) {
    const progress = document.querySelector<HTMLElement>(`[data-setup-progress="${kind}"]`);
    if (progress) { progress.textContent = setupProgress(kind); progress.hidden = !progress.textContent; }
    const download = document.querySelector<HTMLButtonElement>(`[data-setup-download="${kind}"]`);
    if (download) download.disabled = busy || (kind === 'speech' && st.speechInstalled);
    const cancel = document.querySelector<HTMLElement>(`[data-setup-cancel="${kind}"]`);
    if (cancel) cancel.hidden = !busy || !setupIs(kind);
  }
}

function platformCards(): Node[] {
  const p = st.platform;
  const rows: Node[] = [];
  if (p.reason) rows.push(h('div.warning', {}, p.reason));
  if (p.accessibilityRequired && (!p.accessibilityGranted || st.microphonePermission !== 'granted')) rows.push(card('Allow microphone and keyboard access', 'macOS needs Microphone, Accessibility and Input Monitoring permissions. Enable Dictate in System Settings → Privacy & Security, then restart Dictate.', h('button.button', {onclick: () => void action('dictate:permissions')}, 'Enable access')));
  if (!p.canSwallowKeys && p.globalHotkeys) rows.push(card('Keyboard behavior', 'Hold and double-tap work globally. The desktop also receives keys; use an unused dictation key and avoid combinations already used by your apps. History opens in its own focused window.'));
  if (p.displayServer === 'wayland') {
    rows.push(card('Desktop toggle shortcut', st.shortcutRegistered ? 'Desktop shortcut confirmed by activation. Use it to start and finish; output stays on the clipboard.' : st.shortcutRequested ? 'Shortcut request submitted. Approve any desktop consent dialog, then press the shortcut to confirm it works. You can always use Start / Finish here.' : st.settings.portableShortcutEnabled ? 'The desktop did not accept the shortcut request. Retry, choose another shortcut, or use Start / Finish here and paste copied text yourself.' : 'Wayland can offer a toggle through its shortcut portal. Hold-to-talk and automatic paste are restricted by the desktop. You can always use Start / Finish here and paste copied text yourself.', h('button.button', {onclick: () => void action('dictate:enable-shortcut')}, st.shortcutRegistered || st.shortcutRequested ? 'Retry request' : 'Enable desktop shortcut'), select(st.settings.portableShortcut, [['CommandOrControl+Shift+Space','Ctrl+Shift+Space'],['CommandOrControl+Alt+D','Ctrl+Alt+D'],['','Disabled']], (v) => void set({portableShortcut:v}))));
  }
  return rows;
}

function setupCards(): Node[] {
  return [...platformCards(), modelCard('speech'), actionError ? h('div.warning', {}, actionError) : null].filter(Boolean) as Node[];
}

// ---------- pages ----------

// ---------- getting started: the first-run walkthrough, reopened any time from the nav or the tray ----------

let step: Step = 'welcome';
let practice: { raw: string; text: string; ms: number | null; cleaned: boolean } | null = null;
let hardwareStarted = false;

const size = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`);
const stepCtx = () => ({ licencesSeen: st.settings.licencesSeen, speechReady: st.speechInstalled });
const busySetup = () => st.setup.phase === 'downloading' || st.setup.phase === 'extracting';
const link = (text: string, url: string) =>
  h('a.link', { href: url, onclick: (e: Event) => { e.preventDefault(); void dictate.invoke('dictate:open-url', url); } }, text);

function go(next: Step): void {
  if (step === 'try' && next !== 'try') void dictate.invoke('dictate:practice', false);
  if (next === 'try') void dictate.invoke('dictate:practice', true);
  step = next;
  content.scrollTop = 0;
  render();
  if (!st.settings.onboarded) void dictate.invoke('dictate:set-settings', { onboardingStep: next });
}

const primaryButton = (label: string, onclick: () => void, disabled = false) => h('button.button.accent', { 'data-wiz': 'next', disabled, onclick }, label);

/** `pending`: the step's work is not done yet, so Skip means something (it otherwise duplicates the primary button). */
function stepFrame(title: string | null, lead: string | Node | null, body: (Node | null)[], primary: HTMLElement | null, pending = false): Node[] {
  const n = stepNumber(step);
  return [
    h('div.wizdots', { 'aria-label': `Step ${n.index} of ${n.total}` }, ...STEPS.map((s, i) => h('span.wizdot', { 'data-state': s === step ? 'current' : i < n.index - 1 ? 'done' : 'todo' }))),
    title ? h('h1', {}, title) : null,
    lead ? h('p.lead', {}, lead) : null,
    ...body,
    h(
      'div.wizfoot',
      {},
      h('span.muted.small', {}, `Step ${n.index} of ${n.total}`),
      h(
        'div.wizbuttons',
        {},
        canGoBack(step) ? h('button.button.subtle', { 'data-wiz': 'back', onclick: () => go(previousStep(step)) }, 'Back') : null,
        canSkip(step) && pending ? h('button.button.subtle', { 'data-wiz': 'skip', onclick: () => go(nextStep(step)) }, 'Skip') : null,
        primary,
      ),
    ),
  ].filter(Boolean) as Node[];
}

function startEssentials(): void {
  void dictate.invoke('dictate:setup-models', 'essentials').catch(() => undefined);
}

function welcomeStep(): Node[] {
  const plan: [string, string][] = [
    ['Download the models', `About ${size(st.sizes.essentials)}, once, from their official sources.`],
    ['A quick speed check', 'dictate times a cleanup on this computer and picks what runs fast here.'],
    ['Your mic and your key', 'Then a practice dictation, right here in this window.'],
  ];
  return stepFrame(
    null,
    null,
    [
      h('div.hero', {}, h('div.heroicon', {}, '●'), h('h1', {}, 'Welcome to dictate'), h('p.lead', {}, 'Hold a key, speak, and clean text appears wherever you type. Speech recognition and cleanup run on this computer: no account, no cloud, and it works offline once it is set up.')),
      h('div.steps', {}, ...plan.map(([t, d], i) => h('div.step', {}, h('div.stepnum', {}, String(i + 1)), h('div', {}, h('div.cardtitle', {}, t), h('div.carddesc', {}, d))))),
    ],
    primaryButton('Get started', () => go('licences')),
  );
}

function licencesStep(): Node[] {
  const ready = st.essentialsReady;
  return stepFrame(
    'Models and licences',
    'dictate downloads these from their official sources. Each keeps its own licence. There is nothing to accept; this is what you are getting.',
    [
      h(
        'div.licences',
        {},
        ...THIRD_PARTY.filter((i) => i.downloaded).map((i) =>
          h(
            'div.licence',
            {},
            h('div', {}, h('div.cardtitle', {}, i.name, i.optional ? h('span.badge', {}, 'optional') : null), h('div.carddesc', {}, `${i.role} · `, link(i.licence, i.licenceUrl), ' · ', link('source', i.source)), i.notice ? h('div.muted.small', {}, i.notice) : null),
            h('div.licencesize', {}, displaySize(i)),
          ),
        ),
      ),
      h('p.muted.small', {}, `Now: about ${size(st.sizes.essentials)}. Gemma (${size(st.sizes.gemma)}) is offered later, only if this computer runs it fast enough. The same list is in Settings → About.`),
    ],
    primaryButton(ready ? 'Continue' : `Download ${size(st.sizes.essentials)}`, async () => {
      st = await dictate.invoke<State>('dictate:set-settings', { licencesSeen: true });
      if (!ready && !busySetup()) startEssentials();
      go('download');
    }),
  );
}

function eta(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '';
  return seconds < 60 ? ' · less than a minute left' : ` · about ${Math.ceil(seconds / 60)} min left`;
}

/** The live part of the download step; progress events redraw only this block. */
function downloadBlock(): Node {
  const s = st.setup;
  if (st.essentialsReady) return card('Downloaded and verified', 'The speech model, the Emberon cleanup model and llama.cpp are installed. Every file matched its pinned SHA-256 checksum.');
  if (busySetup() && s.kind === 'essentials') {
    const received = s.overallReceived ?? s.received ?? 0;
    const total = s.overallTotal ?? s.total ?? 0;
    const pct = total ? Math.min(100, Math.floor((received / total) * 100)) : 0;
    const speed = s.bytesPerSecond ? ` · ${(s.bytesPerSecond / 1e6).toFixed(1)} MB/s` : '';
    return h(
      'section.card',
      {},
      h('div.cardtitle', {}, s.phase === 'extracting' ? 'Verifying and installing…' : `Downloading… ${pct}%`),
      h('div.progress', {}, h('div.progressfill', { style: { width: `${pct}%` } })),
      h('div.carddesc', { 'data-download-detail': '' }, `${size(received)} of ${size(total)}${speed}${eta(s.etaSeconds)}`),
      s.file ? h('div.muted.small', {}, `${s.steps ? `File ${(s.step ?? 0) + 1} of ${s.steps}: ` : ''}${s.file}`) : null,
      h('div.bindingrow', {}, h('button.button', { 'data-wiz': 'pause', onclick: () => void dictate.invoke('dictate:cancel-setup') }, 'Pause')),
    );
  }
  if (s.phase === 'error' && s.kind === 'essentials')
    return h(
      'section.card',
      {},
      h('div.warning', { 'data-download-error': '' }, s.message ?? 'The download stopped.'),
      h('div.bindingrow', {}, h('button.button.accent', { 'data-wiz': 'retry', onclick: () => startEssentials() }, 'Retry'), h('span.muted.small', {}, 'Retry picks up where it stopped.')),
    );
  if (busySetup()) return card('Another download is running', 'It finishes first; then press Download.');
  return card('Ready to download', `About ${size(st.sizes.essentials)}. You can pause and resume at any time.`, h('button.button.accent', { 'data-wiz': 'start-download', onclick: () => startEssentials() }, 'Download'));
}

function downloadStep(): Node[] {
  return stepFrame(
    'Download',
    'Keep going while it downloads: the next steps work without it, and the practice dictation waits until it is done.',
    [h('div', { 'data-wizdownload': '' }, downloadBlock())],
    primaryButton(busySetup() && st.setup.kind === 'essentials' ? 'Continue while it downloads' : 'Next', () => go('hardware')),
    !st.essentialsReady && !busySetup(),
  );
}

const CHAIN_NAMES: Record<CleanupChain, string> = { 'gemma-emberon': 'Gemma, then Emberon', gemma: 'Gemma only', emberon: 'Emberon only', off: 'Off: the raw transcript' };

function hardwareStep(): Node[] {
  const hw = st.settings.hardware;
  const body: (Node | null)[] = [];
  if (!st.essentialsReady) body.push(card('Waiting for the download', 'The check times a real cleanup, so it starts once the download is done. Skip ahead and come back, or run it later from Settings → Cleanup.'));
  else if (st.hardwareRunning) body.push(card('Checking this computer…', 'Timing a cleanup of a 5-second sample. This takes a few seconds.', h('span.spinner')));
  else if (hw) {
    body.push(
      card('This computer', h('span', { 'data-hardware-summary': '' }, hw.summary)),
      card('Cleanup', `${CHAIN_NAMES[hw.chain]}. You can change it in Settings → Cleanup.`, h('button.button.subtle', { onclick: () => void action('dictate:hardware-check') }, 'Run again')),
    );
    if (hw.offerGemma && hw.chain !== 'gemma-emberon' && !st.gemmaInstalled) {
      const downloading = busySetup() && st.setup.kind === 'gemma';
      body.push(card('Better names with Gemma (optional)', `${size(st.sizes.gemma)}, in the background. dictate times it when it arrives and switches to it only if it is fast enough here.`, h('button.button', { disabled: busySetup(), onclick: () => void dictate.invoke('dictate:setup-models', 'gemma').catch(() => undefined) }, downloading ? 'Downloading…' : 'Download Gemma')));
    }
  } else {
    if (!hardwareStarted && !st.hardwareError) {
      hardwareStarted = true;
      void action('dictate:hardware-check');
    }
    body.push(st.hardwareError ? h('section.card', {}, h('div.warning', {}, st.hardwareError), h('button.button', { onclick: () => void action('dictate:hardware-check') }, 'Retry')) : card('Checking this computer…', 'Timing a cleanup of a 5-second sample.', h('span.spinner')));
  }
  return stepFrame('Speed check', 'Cleanup fixes punctuation, fillers and names. dictate measures it here and picks what is fast enough on this computer.', body, primaryButton('Next', () => go('microphone')), !hw);
}

function microphoneStep(): Node[] {
  const meter = meterEl();
  void startMeter(st.mic?.deviceId ?? null, st.mic?.label ?? st.defaultMicLabel, meter);
  return stepFrame(
    'Your microphone',
    'Pick the mic you will dictate with, then say something: the bar should move into the middle.',
    [...platformCards(), card('Microphone', null, micSelect(), meter), h('p.muted.small', {}, 'Too quiet? Raise its input gain on the Microphone page any time.')],
    primaryButton('Next', () => go('hotkey')),
  );
}

function hotkeyStep(): Node[] {
  if (st.platform.displayServer === 'wayland')
    return stepFrame('Starting a dictation', null, [card('Output on this desktop', `Wayland keeps apps isolated, so dictate copies your result; paste it with ${pasteKeys()}. Start and finish from the tray, or enable a desktop shortcut in Hotkeys & output.`)], primaryButton('Next', () => go('try')));
  const mac = st.platform.platform === 'darwin';
  const note = h('div.warnline');
  const current = st.settings.hotkeys.length === 1 ? st.settings.hotkeys[0] : null;
  const chips: [string, number][] = [[mac ? 'Right Control' : 'Right Ctrl', R_CTRL], [mac ? 'Right Option' : 'Right Alt', R_ALT], ['F13 (mouse button)', F13]];
  const press = h(
    'button.chip',
    {
      onclick: async () => {
        press.textContent = 'Press the key…';
        const b = await dictate.invoke<Binding | null>('dictate:record-binding');
        const problem = b ? dictationKeyProblem(b) : null;
        if (b && !problem) await set({ hotkeys: [b] });
        else {
          note.textContent = problem ?? '';
          press.textContent = 'Press any key…';
        }
      },
    },
    'Press any key…',
  );
  return stepFrame(
    'Your dictation key',
    'Hold it to talk and let go to finish. Double-tap it for hands-free, then tap once to finish. Esc cancels.',
    [
      card(
        'Dictation key',
        'No Right Ctrl on your keyboard? Pick Right Alt. Mapped a mouse button to F13 in Logitech Options+ or G HUB? Pick F13.',
        h('div.bindingrow', {}, keycap(st.labels.hotkey)),
        h('div.keylist', {}, h('div.presets', {}, ...chips.map(([label, key]) => h('button.chip', { 'data-active': String(same(current, { keys: [key] })), onclick: () => (key === F13 ? set({ hotkeys: [{ keys: [F13] }] }) : useKey(key)) }, label)), press), note),
      ),
      st.platform.canSwallowKeys ? null : h('p.muted.small', {}, 'On this desktop other apps also receive the key, so choose one you do not use for anything else.'),
    ],
    primaryButton('Next', () => go('try')),
  );
}

function tryStep(): Node[] {
  if (!tryReady(stepCtx())) {
    const s = st.setup;
    const pct = busySetup() && s.overallTotal ? ` (${Math.floor(((s.overallReceived ?? 0) / s.overallTotal) * 100)}%)` : '';
    return stepFrame('Try it', null, [card('Waiting for the speech model', `It is still downloading${pct}. Come back once it is done, or skip and try your key in any app later.`, h('button.button', { onclick: () => go('download') }, 'See the download'))], primaryButton('Next', () => go('done')));
  }
  const manual = st.platform.displayServer === 'wayland' || !st.platform.globalHotkeys;
  const result = practice
    ? h(
        'div.practiceresult',
        {},
        h('div.practicelabel', {}, practice.cleaned ? 'Cleaned' : 'Typed'),
        h('div.practicetext', { 'data-practice-text': '' }, practice.text),
        practice.cleaned && practice.raw !== practice.text ? h('div.muted.small', {}, `Heard: ${practice.raw}`) : null,
        practice.ms !== null ? h('div.muted.small', {}, `Ready ${(practice.ms / 1000).toFixed(2)} s after you let go.${practice.cleaned ? '' : ' Cleanup is off, so this is the raw transcript.'}`) : null,
      )
    : h('div.practicehint', {}, manual ? 'Press Start, speak, then Finish.' : h('span', {}, 'Click here, hold ', keycap(st.labels.hotkey), ', speak, and let go.'));
  return stepFrame(
    'Try it',
    'Say something like “Testing my new dictation app, it runs entirely on my own computer.”',
    [
      h('div.practicebox', { tabindex: '0', 'data-practice': '' }, result),
      manual ? h('div.bindingrow', {}, h('button.button', { onclick: () => void action('dictate:toggle') }, st.recording ? 'Finish' : 'Start')) : null,
      h('p.muted.small', {}, 'While this window is in front, a dictation lands in the box instead of in another app.'),
    ],
    primaryButton(practice ? 'Next' : 'Skip for now', () => go('done')),
  );
}

function doneStep(): Node[] {
  const wayland = st.platform.displayServer === 'wayland';
  const key = () => keycap(st.labels.hotkey);
  const recap: [Node | string, string][] = wayland
    ? [['Tray → Start dictation', 'start, then finish'], [keycap(pasteKeys()), 'paste the copied result']]
    : [[key(), 'hold to talk, let go to finish'], [h('span', {}, key(), ' ', key()), 'double-tap for hands-free; tap again to finish'], [keycap('Esc'), 'cancel']];
  if (st.settings.picker && !wayland) recap.push([keycap(st.labels.picker), 'your dictation history, at the cursor']);
  return stepFrame(
    'You are set',
    `dictate waits in the ${st.platform.platform === 'darwin' ? 'menu bar' : 'tray'} and uses no CPU until you press your key.`,
    [
      h('div.recap', {}, ...recap.map(([k, d]) => h('div.recaprow', {}, h('span.recapkey', {}, k), h('span.carddesc', {}, d)))),
      card('Start at login', `Start dictate when you sign in to ${osName()}.`, toggle(welcomeStartAtLogin, (v) => (welcomeStartAtLogin = v))),
      card('Where your history lives', h('span', {}, 'On this computer only, in ', h('code', {}, st.dataDir), '. Settings → History sets how much is kept.'), h('button.button', { onclick: () => void dictate.invoke('dictate:open-data') }, 'Open folder')),
      card('Come back any time', 'Getting started, in Settings and in the tray menu, opens these steps again.'),
    ],
    primaryButton('Finish', async () => {
      void dictate.invoke('dictate:practice', false);
      st = await dictate.invoke<State>('dictate:finish-onboarding', welcomeStartAtLogin);
      page = 'general';
      render();
    }),
  );
}

function start(): Node[] {
  return { welcome: welcomeStep, licences: licencesStep, download: downloadStep, hardware: hardwareStep, microphone: microphoneStep, hotkey: hotkeyStep, try: tryStep, done: doneStep }[step]();
}

function about(): Node[] {
  return [
    h('h1', {}, 'About'),
    card('dictate', h('span', {}, `Version ${st.version}. Part of `, link('open-dictate', 'https://github.com/parsakhaz/open-dictate'), ', free software under the GNU AGPL-3.0. Copyright © 2026 Dcouple Inc.')),
    h('h2', {}, 'Models and libraries'),
    h(
      'div.licences',
      {},
      ...THIRD_PARTY.map((i) =>
        h('div.licence', {}, h('div', {}, h('div.cardtitle', {}, i.name), h('div.carddesc', {}, `${i.role} · `, link(i.licence, i.licenceUrl), ' · ', link('source', i.source)), i.notice ? h('div.muted.small', {}, i.notice) : null), h('div.licencesize', {}, i.downloaded ? displaySize(i) : 'bundled')),
      ),
    ),
  ];
}

function micSelect(): HTMLSelectElement {
  const options: [string, string][] = [['', `System default${st.defaultMicLabel ? ` (${micName(st.defaultMicLabel)})` : ''}`], ...st.devices.map((d) => [d.deviceId, micName(d.label)] as [string, string])];
  return select(st.mic?.deviceId ?? '', options, (v) => void pickMic(v || null));
}

function general(): Node[] {
  const s = st.settings;
  return [
    h('h1', {}, 'Hotkeys & output'),
    ...platformCards(),
    ...(st.stt !== 'ready' ? [modelCard('speech')] : []),
    card('Dictate now', 'Start here or from the tray. Click Finish after speaking. Clipboard mode lets you paste the result into any app.', h('button.button.accent', {disabled: st.stt !== 'ready', onclick: () => void action('dictate:toggle')}, st.recording ? 'Finish dictation' : 'Start dictation')),
    card('History', 'Search, copy or reuse a previous dictation.', h('button.button', {onclick: () => void action('dictate:open-history')}, 'Open history')),
    h('h2', {}, 'Hotkeys'),
    card(
      st.settings.hotkeys.length > 1 ? 'Dictation keys' : 'Dictation key',
      'Hold to talk, release to finish. Double-tap to keep listening hands-free; tap again to finish. No Right Ctrl on your keyboard? Use Right Alt. Up to four keys work side by side.',
      null,
      dictationKeys(),
    ),
    card(
      'Using a mouse button?',
      `In Logitech Options+ or G HUB, map the button to F13 (or any of F13–F24), then add that key here. Hold the button to talk, or tap it once to start hands-free and again to finish. ${st.platform.canSwallowKeys ? 'The app you type into never sees the key.' : 'Your desktop also receives this key, so use an unused key.'}`,
    ),
    card('History picker', 'Opens your dictation history at the cursor.', bindingControl('picker', true), presets('picker')),
    card('Toggle combo', 'Optional: a separate shortcut that starts and stops hands-free dictation.', bindingControl('toggle', true)),
    h('h2', {}, 'Output'),
    card(
      'When a dictation is done',
      null,
      null,
      radios<OutputMode>('output', s.output, [
        ['paste', 'Paste into the focused app', 'The clipboard is restored when the target can be confirmed. Otherwise your text stays copied.'],
        ['clipboard', 'Copy to the clipboard only', `Paste it yourself with ${pasteKeys()}.`],
        ['both', 'Paste, and keep it on the clipboard', ''],
      ], (v) => set({ output: v })),
    ),
    card(
      'Say “press enter” to send',
      'End a dictation with the words “press enter” and dictate presses Enter after the text, to send a chat message hands-free. Only as the very last words.',
      toggle(s.pressEnter, (v) => set({ pressEnter: v })),
    ),
    card('Show what you say', 'The live words in the pill while you speak. Off leaves just the waveform.', toggle(s.pillText, (v) => set({ pillText: v }))),
    card('Sounds', 'A soft cue when dictation starts, stops or is cancelled.', toggle(s.sounds, (v) => set({ sounds: v }))),
    card('Start at login', st.startupError || `Start dictate in the tray when you sign in to ${osName()}.`, toggle(s.startAtLogin, (v) => set({ startAtLogin: v }))),
  ];
}

function microphone(): Node[] {
  const s = st.settings;
  const rows: Node[] = [];
  const all: { deviceId: string | null; label: string; name: string }[] = [
    { deviceId: null, label: st.defaultMicLabel, name: `System default${st.defaultMicLabel ? ` · ${micName(st.defaultMicLabel)}` : ''}` },
    ...st.devices.map((d) => ({ deviceId: d.deviceId, label: d.label, name: micName(d.label) })),
  ];
  for (const d of all) {
    const active = (st.mic?.deviceId ?? null) === d.deviceId;
    const meter = meterEl();
    void startMeter(d.deviceId, d.label, meter);
    const gain = gainOf(d.label);
    const slider = h('input.slider', {
      type: 'range',
      min: '-10',
      max: '30',
      step: '1',
      value: String(gain),
      oninput: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value);
        gainLabel.textContent = `${v > 0 ? '+' : ''}${v} dB`;
        st.settings.gainDb[micKey(d.label)] = v;
      },
      onchange: (e: Event) => void dictate.invoke('dictate:set-gain', d.label, Number((e.target as HTMLInputElement).value)),
    });
    const gainLabel = h('span.gainlabel', {}, `${gain > 0 ? '+' : ''}${gain} dB`);
    rows.push(
      h(
        'section.card.mic',
        { 'data-active': String(active) },
        h(
          'div.cardrow',
          {},
          h('label.radio', {}, h('input', { type: 'radio', name: 'mic', checked: active, onchange: () => void pickMic(d.deviceId) }), h('span.radiodot'), h('span.radiotext', {}, h('span', {}, d.name), h('span.radiodesc', {}, d.deviceId ? d.label : 'Follows the system default input'))),
        ),
        h('div.microw', {}, meter, h('div.gain', {}, h('span.muted', {}, 'Input gain'), slider, gainLabel)),
      ),
    );
  }
  const order = s.micOrder.length
    ? h('ol.order', {}, ...s.micOrder.map((p) => h('li', {}, micName(p.label), st.devices.some((d) => micKey(d.label) === micKey(p.label) && (!p.groupId || d.groupId === p.groupId)) ? null : h('span.muted', {}, ' · not connected'))))
    : h('div.muted', {}, 'None yet: dictate uses the system default until you pick one.');
  return [
    h('h1', {}, 'Microphone'),
    h('p.lead', {}, 'Pick the mic to dictate with. Your choices are remembered in order: when your favourite is unplugged dictate falls back to the next, and switches back (with Undo) when it returns.'),
    ...rows,
    card('Preferred order', 'Picking a mic puts it at the top.', null, order),
    h('p.muted.small', {}, 'Input gain boosts quiet mics; loud peaks are softened instead of clipping. The built-in Microphone Array starts at +20 dB because it is very quiet.'),
    st.platform.platform === 'win32' ? card(
      'Keep the mic ready after a dictation',
      h(
        'span',
        {},
        'A follow-up dictation then starts with no delay, and the system shows the mic as in use for that time. A Bluetooth headset stays in call mode while its mic is open, which lowers music and call quality: leave this Off if you use one.',
        st.settings.micWarm !== 'off' && st.micBluetooth ? h('div.warnline', {}, 'Your mic is a Bluetooth headset: it stays in call mode while the mic is kept ready.') : null,
      ),
      select<Settings['micWarm']>(st.settings.micWarm, [
        ['off', 'Off'],
        ['30s', 'For 30 seconds'],
        ['always', 'Always, while plugged in'],
      ], (v) => void set({ micWarm: v })),
    ) : card('Microphone lifetime', 'The microphone opens for each recording and closes afterwards. The prepared audio worklet is reused without holding the microphone open.'),
  ];
}

function cleanupPage(): Node[] {
  const s = st.settings;
  const status = (name: string, state: string) => h('span.status', { 'data-state': state }, h('span.dot'), `${name}: ${state === 'ready' ? 'ready' : state === 'starting' ? 'loading…' : state === 'crashed' ? 'restarting…' : 'not running'}`);
  return [
    h('h1', {}, 'Cleanup'),
    h('p.lead', {}, 'After transcription, small local language models fix punctuation, fillers and the names in your vocabulary. If a step fails or rewrites too much, its input is kept, so you never lose words.'),
    modelCard('cleanup'),
    card(
      'Speed check',
      st.hardwareRunning ? 'Timing a cleanup of a 5-second sample…' : st.hardwareError || (st.settings.hardware?.summary ?? 'Times a cleanup on this computer and picks the chain that is fast enough here.'),
      h('button.button', { disabled: st.hardwareRunning || !st.essentialsReady, onclick: () => void action('dictate:hardware-check') }, 'Re-run the check'),
    ),
    card(
      'Cleanup',
      h('span.statusrow', {}, status('Gemma 4 E2B', st.servers.gemma), status('Emberon-2', st.servers.emberon)),
      null,
      radios<CleanupChain>('chain', s.cleanup, [
        ['gemma-emberon', 'Gemma, then Emberon', 'Names from your vocabulary, then a final polish. Speed depends on your computer.'],
        ['gemma', 'Gemma only', 'Vocabulary-aware; slightly less polish.'],
        ['emberon', 'Emberon only', 'Fastest; may misspell names.'],
        ['off', 'Off', 'Type exactly what the recognizer heard.'],
      ], (v) => set({ cleanup: v })),
    ),
    card(
      'Clean up as I speak',
      'Finished sentences are cleaned while you are still talking, so a long dictation is ready sooner after you let go. The text is still pasted once, at the end.',
      toggle(s.liveCleanup, (v) => set({ liveCleanup: v })),
    ),
    h('h2', {}, 'On battery'),
    card(
      'Unload models when idle',
      `On battery, after this long without dictating. Loaded models use memory but no CPU or GPU while idle; reloading takes about 5 s and reads about 3 GB from disk. Plugged in, they stay loaded.${st.onBattery ? ' On battery now.' : ''}`,
      select(String(s.batteryUnloadMinutes), [['0', 'Never'], ['5', '5 minutes'], ['15', '15 minutes'], ['30', '30 minutes'], ['60', '1 hour'], ['120', '2 hours']], (v) => set({ batteryUnloadMinutes: Number(v) })),
    ),
    card('Emberon only on battery', 'Skip Gemma while unplugged, for less GPU work.', toggle(s.batteryEmberonOnly, (v) => set({ batteryEmberonOnly: v }))),
    st.missing.length ? h('div.warning', {}, 'Missing files: ', ...st.missing.map((m) => h('code', {}, m))) : null,
  ].filter(Boolean) as Node[];
}

let vocabTimer: ReturnType<typeof setTimeout> | undefined;
function vocabulary(): Node[] {
  const terms: VocabTerm[] = st.settings.vocabulary.map((t) => ({ term: t.term, aliases: [...(t.aliases ?? [])] }));
  const save = () => {
    clearTimeout(vocabTimer);
    vocabTimer = setTimeout(() => void dictate.invoke('dictate:set-settings', { vocabulary: terms.filter((t) => t.term.trim()) }).then((s) => (st = s as State)), 500);
  };
  const filter = h('input.textbox', { placeholder: 'Filter terms', oninput: () => draw() });
  const body = h('div.vocab');
  const draw = () => {
    const q = (filter as HTMLInputElement).value.toLowerCase();
    body.replaceChildren(
      h('div.vocabhead', {}, h('span', {}, 'Term'), h('span', {}, 'Sounds like (comma-separated)'), h('span')),
      ...terms
        .map((t, i) => ({ t, i }))
        .filter(({ t }) => !q || t.term.toLowerCase().includes(q) || (t.aliases ?? []).some((a) => a.toLowerCase().includes(q)))
        .map(({ t, i }) =>
          h(
            'div.vocabrow',
            {},
            h('input.textbox', { value: t.term, oninput: (e: Event) => {
                terms[i].term = (e.target as HTMLInputElement).value;
                save();
              },
            }),
            h('input.textbox', {
              value: (t.aliases ?? []).join(', '),
              placeholder: 'e.g. pain, the pain',
              oninput: (e: Event) => {
                terms[i].aliases = (e.target as HTMLInputElement).value
                  .split(',')
                  .map((x) => x.trim())
                  .filter(Boolean);
                save();
              },
            }),
            h('button.iconbutton', { title: 'Remove', onclick: () => {
                  terms.splice(i, 1);
                  save();
                  draw();
                },
              }, '×'),
          ),
        ),
    );
  };
  draw();
  return [
    h('h1', {}, 'Vocabulary'),
    h('p.lead', {}, 'Names and terms the cleanup step should spell right. Add what the recognizer tends to write instead under "sounds like".'),
    h('div.toolbar', {}, filter, h('button.button.accent', { onclick: () => {
          terms.unshift({ term: '', aliases: [] });
          (filter as HTMLInputElement).value = '';
          draw();
          (body.querySelector('.vocabrow input') as HTMLInputElement | null)?.focus();
        },
      }, 'Add term'), h('span.muted', {}, `${terms.length} terms`)),
    body,
  ];
}

function historyPage(): Node[] {
  const s = st.settings;
  return [
    h('h1', {}, 'History'),
    h('p.lead', {}, 'Your dictations are kept on this laptop only. Open them anywhere with ', keycap(st.labels.picker), '.'),
    card('Keep the last', 'Pinned dictations are always kept.', select(String(s.historyLimit), [['50', '50 dictations'], ['200', '200 dictations'], ['1000', '1,000 dictations'], ['5000', '5,000 dictations']], (v) => set({ historyLimit: Number(v) }))),
    card('Clear history', `${st.history.count} saved. Pinned ones stay.`, h('button.button', { onclick: () => void refresh(dictate.invoke<State>('dictate:clear-history')) }, 'Clear')),
    card('Speed', st.history.median !== null ? `Median release-to-text over the last ${st.history.samples} dictations: ${st.history.median} ms.` : 'Dictate something to see how fast it is.'),
  ];
}

function advanced(): Node[] {
  const s = st.settings;
  const path = (key: 'modelsDir' | 'llamaServer', label: string, desc: string) => {
    const input = h('input.textbox.wide', { 'data-setting': key, value: s[key], onchange: (e: Event) => set({ [key]: (e.target as HTMLInputElement).value } as Partial<Settings>) });
    return card(label, desc, null, input);
  };
  const num = (key: 'tapMs' | 'doubleTapMs' | 'sttThreads', label: string, desc: string, min: number, max: number, step: number) =>
    card(label, desc, h('input.textbox.num', { 'data-setting': key, type: 'number', min: String(min), max: String(max), step: String(step), value: String(s[key]), onchange: (e: Event) => set({ [key]: Number((e.target as HTMLInputElement).value) } as Partial<Settings>) }));
  return [
    h('h1', {}, 'Advanced'),
    ...setupCards(),
    h('h2', {}, 'Models'),
    path('modelsDir', 'Models folder', 'Holds the Nemotron speech model and the Gemma and Emberon GGUFs. DICTATE_MODELS_DIR overrides it.'),
    path('llamaServer', 'llama-server', 'llama.cpp b11700 CPU (Windows/Linux) or Metal (macOS). DICTATE_LLAMA_SERVER overrides it.'),
    card('Speech model', st.stt === 'ready' ? 'Nemotron Speech Streaming 0.6B, 1120 ms chunks: loaded.' : st.stt === 'error' ? `Failed: ${st.sttError}` : 'Loading…'),
    num('sttThreads', 'Recognizer threads', 'CPU threads for speech recognition. Reduce this if other work becomes less responsive.', 1, 16, 1),
    h('h2', {}, 'Timing'),
    num('tapMs', 'Tap threshold (ms)', 'A press shorter than this is a tap; longer is hold-to-talk.', 100, 800, 10),
    num('doubleTapMs', 'Double-tap window (ms)', 'How quickly the second tap must follow the first.', 150, 1000, 10),
    h('h2', {}, 'Diagnostics'),
    card('Log file', st.logFile, h('button.button', { onclick: () => dictate.invoke('dictate:open-log') }, 'Open')),
    card('Version', `dictate ${st.version}`),
  ];
}

// ---------- shell ----------

function render(): void {
  // State can change while an uncommitted path or number draft is being edited.
  // Keep that control (and its caret/selection) alive until focus leaves the editor or the page changes.
  if (page === renderedPage && (pointerActive || (page === 'advanced' && document.activeElement?.matches('input.textbox')) || document.querySelector('.slider:active'))) {
    renderPending = true;
    updateSetupProgress();
    return;
  }
  renderPending = false;
  stopMeters();
  // Until the walkthrough is finished it is the whole window: no other pages to wander off to.
  const firstRun = !st.settings.onboarded;
  if (firstRun) page = 'start';
  nav.closest('.shell')?.classList.toggle('firstrun', firstRun);
  nav.replaceChildren(
    ...PAGES.map((p) =>
      h(
        'button.navitem',
        {
          'data-active': String(p.id === page),
          onclick: () => openPage(p.id),
        },
        h('span.navicon', {}, p.icon),
        p.label,
      ),
    ),
  );
  const build = { start, general, microphone, cleanup: cleanupPage, vocabulary, history: historyPage, advanced, about }[page];
  const scroll = content.scrollTop;
  content.replaceChildren(h('div.page', {}, actionError ? h('div.warning', {}, actionError) : null, ...build()));
  content.scrollTop = scroll;
  renderedPage = page;
}

dictate.on('dictate:state', (s: State) => {
  st = s;
  // Vocabulary has its own debounced save; leave its local terms alive while typing.
  if (page === 'vocabulary' && document.activeElement?.tagName === 'INPUT') return;
  render();
});
dictate.on('dictate:setup-progress', (setup: State['setup']) => {
  if (!st) return; // Opening Settings during a download still starts with the complete get-state reply.
  st.setup = setup;
  updateSetupProgress();
  document.querySelector('[data-wizdownload]')?.replaceChildren(downloadBlock());
});
dictate.on('dictate:practice-result', (r: NonNullable<typeof practice>) => {
  practice = r;
  if (page === 'start' && step === 'try') render();
});
dictate.on('dictate:navigate', (p: Page) => openPage(p));

/** Opening Getting started from the nav or the tray starts the walkthrough over; finished downloads show as done. */
function openPage(p: Page): void {
  if (page === 'start' && step === 'try' && p !== 'start') void dictate.invoke('dictate:practice', false);
  if (p === 'start' && st.settings.onboarded) {
    step = 'welcome';
    welcomeStartAtLogin = st.settings.startAtLogin;
  }
  page = p;
  render();
}
function flushDeferredRender(): void {
  // A mouse press blurs the input before mouseup/click. Keep its target alive through the click.
  // Keyboard blur has no active pointer and refreshes after the current input event finishes.
  setTimeout(() => { if (renderPending && !pointerActive) render(); }, 0);
}
content.addEventListener('focusout', flushDeferredRender);
document.addEventListener('pointerdown', () => { pointerActive = true; }, true);
for (const event of ['pointerup', 'pointercancel']) document.addEventListener(event, () => {
  pointerActive = false;
  flushDeferredRender();
}, true);

window.addEventListener('blur', () => {
  pointerActive = false;
  flushDeferredRender();
  // Meters only run while the window is in use.
  if (document.hidden) stopMeters();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopMeters();
  else render();
});

void dictate.invoke<State>('dictate:get-state').then(async (s) => {
  st = s;
  if (!s.settings.onboarded) {
    page = 'start';
    step = resumeStep(s.settings.onboardingStep, stepCtx());
    if (step === 'try') void dictate.invoke('dictate:practice', true);
  }
  const requested = await dictate.invoke<Page | null>('dictate:take-page');
  if (requested) openPage(requested);
  else render();
});
