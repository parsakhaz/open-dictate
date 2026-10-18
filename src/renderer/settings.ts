// The settings window, in the style of Windows 11 Settings: a welcome page on first run, then pages for
// hotkeys, microphone, cleanup, vocabulary, history and advanced paths.
import { dbfs, defaultGainDb } from '../core/audio';
import type { MicDevice } from '../core/mics';
import { micKey, micName } from '../core/mics';
import type { Binding, CleanupChain, OutputMode, Settings, VocabTerm } from '../core/types';
import { dictate, h } from './bridge';

interface State {
  settings: Settings;
  labels: { hotkey: string; toggle: string; picker: string };
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
}

type Page = 'welcome' | 'general' | 'microphone' | 'cleanup' | 'vocabulary' | 'history' | 'advanced';

const PAGES: { id: Page; label: string; icon: string }[] = [
  { id: 'welcome', label: 'Welcome', icon: '' },
  { id: 'general', label: 'Hotkeys & output', icon: '' },
  { id: 'microphone', label: 'Microphone', icon: '' },
  { id: 'cleanup', label: 'Cleanup', icon: '' },
  { id: 'vocabulary', label: 'Vocabulary', icon: '' },
  { id: 'history', label: 'History', icon: '' },
  { id: 'advanced', label: 'Advanced', icon: '' },
];

let st: State;
let page: Page = 'general';
const nav = h('nav.nav');
const content = h('main.content');
document.getElementById('root')!.append(h('header.titlebar', {}, h('span.appicon', {}, ''), h('span', {}, 'dictate')), h('div.shell', {}, nav, content));

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
  const input = h('input', { type: 'checkbox', checked: on, onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked) });
  return h('label.toggle', {}, h('span.toggletext', {}, on ? 'On' : 'Off'), input, h('span.track', {}, h('span.thumb')), label ? h('span.sr', {}, label) : null);
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

function bindingControl(which: 'hotkey' | 'toggle' | 'picker', canClear: boolean): HTMLElement {
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
const V = 0x56;
const same = (a: Binding | null, b: Binding) => !!a && a.keys.length === b.keys.length && a.keys.every((k, i) => k === b.keys[i]);

/**
 * One key for dictation: Right Ctrl or Right Alt (for keyboards without Right Ctrl). The picker moves along with
 * it while it is still that key + V.
 */
function useKey(key: number): Promise<void> {
  const other = key === R_ALT ? R_CTRL : R_ALT;
  const picker = st.settings.picker;
  const follow = !picker || same(picker, { keys: [other, V] });
  return set({ hotkey: { keys: [key] }, ...(follow ? { picker: { keys: [key, V] } } : {}) });
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
        { 'data-active': String(same(st.settings[which], b)), onclick: () => (which === 'hotkey' ? useKey(b.keys[0] as number) : set({ picker: b })) },
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
  if (document.hidden) return;
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

// ---------- pages ----------

function welcome(): Node[] {
  const startWin = { on: true };
  const meter = meterEl();
  const mic = st.mic?.label ?? st.defaultMicLabel;
  void startMeter(st.mic?.deviceId ?? null, mic, meter);
  return [
    h('div.hero', {}, h('div.heroicon', {}, ''), h('h1', {}, 'Welcome to dictate'), h('p.lead', {}, 'Speak anywhere you can type. Everything runs on this laptop: nothing you say leaves it.')),
    h(
      'div.steps',
      {},
      h('div.step', {}, h('div.stepnum', {}, '1'), h('div', {}, h('div.cardtitle', {}, 'Hold to talk'), h('div.carddesc', {}, 'Hold ', keycap(st.labels.hotkey), ', speak, and let go. The text is typed where your cursor is.'))),
      h('div.step', {}, h('div.stepnum', {}, '2'), h('div', {}, h('div.cardtitle', {}, 'Double-tap for hands-free'), h('div.carddesc', {}, 'Double-tap ', keycap(st.labels.hotkey), ' to keep listening; tap it again to finish. ', keycap('Esc'), ' cancels.'))),
      h('div.step', {}, h('div.stepnum', {}, '3'), h('div', {}, h('div.cardtitle', {}, 'Find anything you said'), h('div.carddesc', {}, keycap(st.labels.picker), ' opens your dictation history, like ', keycap('Win + V'), '.'))),
    ),
    card(
      'Your dictation key',
      st.settings.hotkey && same(st.settings.hotkey, { keys: [R_ALT] }) ? 'Right Alt it is. You can change it any time in Hotkeys & output.' : 'No Right Ctrl on your keyboard? Use Right Alt.',
      h('div.bindingrow', {}, keycap(st.labels.hotkey)),
      presets('hotkey'),
    ),
    card('Microphone', 'Say something: the bar should move into the middle.', micSelect(), meter),
    card('Start with Windows', 'dictate waits quietly in the tray, using no CPU until you press the key.', toggle(startWin.on, (v) => (startWin.on = v))),
    h(
      'div.actionsrow',
      {},
      h(
        'button.button.accent',
        {
          onclick: async () => {
            st = await dictate.invoke<State>('dictate:finish-onboarding', startWin.on);
            page = 'general';
            render();
          },
        },
        'Get started',
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
    h('h2', {}, 'Hotkeys'),
    card('Dictation key', 'Hold to talk, release to finish. Double-tap to keep listening hands-free; tap again to finish. No Right Ctrl on your keyboard? Use Right Alt.', bindingControl('hotkey', false), presets('hotkey')),
    card('History picker', 'Opens your dictation history at the cursor.', bindingControl('picker', true), presets('picker')),
    card('Toggle combo', 'Optional: a separate shortcut that starts and stops hands-free dictation.', bindingControl('toggle', true)),
    h('h2', {}, 'Output'),
    card(
      'When a dictation is done',
      null,
      null,
      radios<OutputMode>('output', s.output, [
        ['paste', 'Paste into the focused app', 'Your clipboard is put back afterwards.'],
        ['clipboard', 'Copy to the clipboard only', 'Paste it yourself with Ctrl+V.'],
        ['both', 'Paste, and keep it on the clipboard', ''],
      ], (v) => set({ output: v })),
    ),
    card('Show what you say', 'The live words in the pill while you speak. Off leaves just the waveform.', toggle(s.pillText, (v) => set({ pillText: v }))),
    card('Sounds', 'A soft cue when dictation starts, stops or is cancelled.', toggle(s.sounds, (v) => set({ sounds: v }))),
    card('Start with Windows', 'Start dictate in the tray when you sign in.', toggle(s.startWithWindows, (v) => set({ startWithWindows: v }))),
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
          h('label.radio', {}, h('input', { type: 'radio', name: 'mic', checked: active, onchange: () => void pickMic(d.deviceId) }), h('span.radiodot'), h('span.radiotext', {}, h('span', {}, d.name), h('span.radiodesc', {}, d.deviceId ? d.label : 'Follows the Windows default input'))),
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
    card(
      'Keep the mic ready after a dictation',
      h(
        'span',
        {},
        'A follow-up dictation then starts with no delay, and Windows shows the mic as in use for that time. A Bluetooth headset stays in call mode while its mic is open, which lowers music and call quality: leave this Off if you use one.',
        st.settings.micWarm !== 'off' && st.micBluetooth ? h('div.warnline', {}, 'Your mic is a Bluetooth headset: it stays in call mode while the mic is kept ready.') : null,
      ),
      select<Settings['micWarm']>(st.settings.micWarm, [
        ['off', 'Off'],
        ['30s', 'For 30 seconds'],
        ['always', 'Always, while plugged in'],
      ], (v) => void set({ micWarm: v })),
    ),
  ];
}

function cleanupPage(): Node[] {
  const s = st.settings;
  const status = (name: string, state: string) => h('span.status', { 'data-state': state }, h('span.dot'), `${name}: ${state === 'ready' ? 'ready' : state === 'starting' ? 'loading…' : state === 'crashed' ? 'restarting…' : 'not running'}`);
  return [
    h('h1', {}, 'Cleanup'),
    h('p.lead', {}, 'After transcription, small local language models fix punctuation, fillers and the names in your vocabulary. If a step fails or rewrites too much, its input is kept, so you never lose words.'),
    card(
      'Cleanup',
      h('span.statusrow', {}, status('Gemma 4 E2B', st.servers.gemma), status('Emberon-2', st.servers.emberon)),
      null,
      radios<CleanupChain>('chain', s.cleanup, [
        ['gemma-emberon', 'Gemma, then Emberon', 'Best: names from your vocabulary, then a final polish. About 0.3 s.'],
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
              }, ''),
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
    const input = h('input.textbox.wide', { value: s[key], onchange: (e: Event) => set({ [key]: (e.target as HTMLInputElement).value } as Partial<Settings>) });
    return card(label, desc, null, input);
  };
  const num = (key: 'tapMs' | 'doubleTapMs' | 'sttThreads', label: string, desc: string, min: number, max: number, step: number) =>
    card(label, desc, h('input.textbox.num', { type: 'number', min: String(min), max: String(max), step: String(step), value: String(s[key]), onchange: (e: Event) => set({ [key]: Number((e.target as HTMLInputElement).value) } as Partial<Settings>) }));
  return [
    h('h1', {}, 'Advanced'),
    h('h2', {}, 'Models'),
    path('modelsDir', 'Models folder', 'Holds the Nemotron speech model and the Gemma and Emberon GGUFs. DICTATE_MODELS_DIR overrides it.'),
    path('llamaServer', 'llama-server.exe', 'llama.cpp b11700 Vulkan. DICTATE_LLAMA_SERVER overrides it.'),
    card('Speech model', st.stt === 'ready' ? 'Nemotron Speech Streaming 0.6B, 1120 ms chunks: loaded.' : st.stt === 'error' ? `Failed: ${st.sttError}` : 'Loading…'),
    num('sttThreads', 'Recognizer threads', 'CPU threads for speech recognition. 4 is the measured sweet spot.', 1, 16, 1),
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
  stopMeters();
  const pages = st.settings.onboarded ? PAGES.filter((p) => p.id !== 'welcome') : PAGES;
  if (!pages.some((p) => p.id === page)) page = 'general';
  nav.replaceChildren(
    ...pages.map((p) =>
      h(
        'button.navitem',
        {
          'data-active': String(p.id === page),
          onclick: () => {
            page = p.id;
            render();
          },
        },
        h('span.navicon', {}, p.icon),
        p.label,
      ),
    ),
  );
  const build = { welcome, general, microphone, cleanup: cleanupPage, vocabulary, history: historyPage, advanced }[page];
  const scroll = content.scrollTop;
  content.replaceChildren(h('div.page', {}, ...build()));
  content.scrollTop = scroll;
}

dictate.on('dictate:state', (s: State) => {
  const focusInVocab = page === 'vocabulary' && document.activeElement?.tagName === 'INPUT';
  st = s;
  // Do not rebuild under the person's typing.
  if (!focusInVocab && !document.querySelector('.slider:active')) render();
});

window.addEventListener('blur', () => {
  // Meters only run while the window is in use.
  if (document.hidden) stopMeters();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopMeters();
  else render();
});

void dictate.invoke<State>('dictate:get-state').then((s) => {
  st = s;
  if (!s.settings.onboarded) page = 'welcome';
  render();
});
