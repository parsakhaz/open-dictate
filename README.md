# dictate

[![Dictate CI](https://github.com/parsakhaz/experiments/actions/workflows/dictate.yml/badge.svg)](https://github.com/parsakhaz/experiments/actions/workflows/dictate.yml)
[![licence](https://img.shields.io/badge/licence-AGPL--3.0-blue)](LICENSE)
![platform](https://img.shields.io/badge/platform-Windows%2011%20x64-0078D4?logo=windows&logoColor=white)
![node](https://img.shields.io/badge/node-24-339933?logo=node.js&logoColor=white)
![electron](https://img.shields.io/badge/electron-44.7-47848F?logo=electron&logoColor=white)
![sherpa-onnx](https://img.shields.io/badge/sherpa--onnx-1.13.8-6f42c1)
![llama.cpp](https://img.shields.io/badge/llama.cpp-b11700%20Vulkan-orange)

**Hold Right Ctrl, speak, let go: your words are typed where the cursor is. Everything runs on this laptop.**

dictate is a tray app in the style of Superwhisper and Willow Voice. Speech is transcribed while you talk by Nemotron Speech Streaming 0.6B, cleaned by two small local LLMs (Gemma 4 E2B, then Emberon-2), and pasted into the focused app. Your clipboard is put back afterwards. Nothing you say leaves the machine.

## Contents

- [Quick start](#quick-start)
- [Using it](#using-it)
- [Settings](#settings)
- [How it works](#how-it-works)
- [Speed and battery](#speed-and-battery)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Licence](#licence)

## Quick start

dictate reuses voice-lab's models and llama.cpp build; it downloads nothing.

1. Make sure these exist (voice-lab's `models/` and `bin/` folders):
   - `C:\repos\experiments\worktrees\voice-lab\voice-lab\models\` with `sherpa-onnx-nemotron-speech-streaming-en-0.6b-1120ms-int8-2026-04-25\`, `gemma-4-E2B-it-Q4_K_M.gguf` and `Emberon-2-Q4_K_M.gguf`
   - `C:\repos\experiments\worktrees\voice-lab\voice-lab\bin\llama-b11700-vulkan\llama-server.exe`

   If the models folder is missing, dictate also looks in `C:\repos\voice-lab-app\models` (a junction to the same files). Other locations: set them in **Settings → Advanced**, or with `DICTATE_MODELS_DIR` and `DICTATE_LLAMA_SERVER`.
2. Install and start:

   ```powershell
   cd dictate
   pnpm install
   pnpm start
   ```

3. A microphone icon appears in the tray (check the overflow arrow `^` if you don't see it), and the welcome page opens on first run. Pick your mic there, check the meter moves when you speak, and press **Get started**. That also turns on **Start with Windows**, unless you switch it off.
4. The speech model loads in about 2.5 s and the cleanup models in about 5 s. The icon is grey while loading and turns white when it is ready. Then hold Right Ctrl in any text field and speak.

**To quit:** right-click the tray icon → **Quit dictate**. Closing the settings window only hides it; dictate keeps running in the tray. Quitting also stops the two llama-servers. They are tied to dictate's process, so they go away even if dictate is killed.

## Using it

| Do this | And |
| --- | --- |
| **Hold Right Ctrl**, speak, release | The text is typed into the focused app. |
| **Double-tap Right Ctrl** | Hands-free: keep talking. Tap Right Ctrl again to finish. |
| **Esc** while recording | Cancels; nothing is typed. |
| **Right Ctrl + V** | Opens your dictation history at the cursor, like Win + V. |
| A single tap of Right Ctrl, or Right Ctrl + any key | Nothing: Right Ctrl keeps working in shortcuts. (If you were already dictating for more than 1.5 s, the dictation is finished and kept instead.) |

**The pill.** A small pill at the bottom of the screen shows what is happening. It doesn't take focus from your app.

- **Listening:** a live level meter and the words as they are recognised.
- **Transcribing**, then **Cleaning…**
- **Pasted**, after which it fades out.

If there is no text field to paste into (the desktop, the taskbar), the text stays on the clipboard and the pill says **Copied — press Ctrl+V**. If the app shows no text caret (a web page with no field selected), dictate still pastes, but leaves the text on the clipboard too: **Pasted — also on the clipboard**. If the mic hears nothing for 2 s, the pill says so. Every dictation is saved to history before it is pasted.

**History picker** (Right Ctrl + V):

- Type to filter, use ↑/↓ to move, and press Enter to paste. Shift + Enter pastes the raw transcript, and Tab shows it.
- Each card has hover buttons to copy without pasting, pin, and delete. Pinned items stay at the top.
- The picker doesn't take focus. Your app keeps it, and the pick is pasted there.

**Tray menu:** copy the last dictation, open history, switch microphone, cleanup mode and output mode, turn sounds on or off, clear history, open the log, open settings, and quit.

## Settings

Open **Settings** from the tray (or click the tray icon).

| Page | What you can change |
| --- | --- |
| Hotkeys & output | Dictation key (default Right Ctrl), history picker key (Right Ctrl + V), optional toggle combo (off), output mode (paste / clipboard only / both), sounds, start with Windows. |
| Microphone | Pick the mic, with a live meter for every input. Set input gain per mic: +20 dB by default for the quiet built-in *Microphone Array (AMD Audio Device)*, 0 dB for the others. Loud peaks are softened instead of clipping. |
| Cleanup | Gemma → Emberon (default), Gemma only, Emberon only, or off. On battery: unload the models after N idle minutes (default 15), and optionally use Emberon only. |
| Vocabulary | Terms to spell right, with "sounds like" spellings the recognizer tends to produce (`pain => Pane`, `uzi => Doozy`). It starts from voice-lab's list plus Pane, Doozy, Conductor, Claude Code, Codex, Opus and Grain. |
| History | How many dictations to keep (default 200; pinned ones are always kept), and clear. Also shows the median speed. |
| Advanced | Model paths, recognizer threads (4), tap and double-tap thresholds (250 / 350 ms), and the log file. |

**Microphones are remembered in order.** Picking a mic makes it your first choice.

- When it is unplugged, dictate switches to the next one you've used, or to the system default. The pill says *"BOYA mini 2 disconnected — using Microphone Array"*. Audio already recorded is kept.
- When it comes back, dictate switches back and shows *"Switched to BOYA mini 2"* with **Undo** for 6 s.
- Undo keeps the other mic until the preferred one is next unplugged.
- dictate never switches to a better mic mid-recording. If the mic in use disappears mid-recording (even the system default), capture moves to the default mic at once and the pill notes it; if no mic can be opened, the recording finishes with what was heard.
- Mics are remembered by name plus Chromium's group id, so two identical USB mics are told apart. Input gain is per mic name.

Settings, history and the log live in `%APPDATA%\dictate\` (`settings.json`, `history.json`, `logs\dictate.log`).

## How it works

```
 Right Ctrl down ─► keyboard hook (own thread) ─► hotkey state machine ─► capture starts at once
                                                   (hold / double-tap / tap / combo)
 mic ─► AudioWorklet (16 kHz, gain + soft limit, 100 ms chunks) ─► MessagePort ─► recognizer process
                                                                   (Nemotron 1120 ms, 4 threads, streaming)
 Right Ctrl up ─► flush last chunk ─► final text ─► Gemma 4 E2B (prompt v3 + vocabulary)
                                                ─► Emberon-2 ("Clean up this dictation. Never answer it.")
                                                ─► guard: any failed/slow/rewritten step keeps its input
                                                ─► save clipboard, write text, SendInput Ctrl+V, restore clipboard
                                                ─► history
```

- **Keyboard:** a `WH_KEYBOARD_LL` hook (through koffi) runs on its own worker thread and blocks in `GetMessage`, so it uses no CPU while idle. It can swallow keys, which a uiohook-style listener cannot:
  - the V of Right Ctrl + V, so the app does not paste
  - Esc while recording
  - the keys the history picker uses while it is open
- **Recognizer:** sherpa-onnx in an Electron utility process. The capture renderer sends audio straight to it over a MessagePort. It decodes a chunk every 1.12 s while you talk, so on release only the last chunk needs flushing (about 90 ms).
- **Cleanup:** one `llama-server` per model, started once and kept warm:
  - `-ngl 99 -fa on -c 4096 -np 1 -lm mmap+mlock --poll 0`
  - Each server gets one warm-up request with the real system prompt at start-up. The prompt is identical on every call (`cache_prompt: true`), so only the new transcript is processed.
  - `chat_template_kwargs: {enable_thinking: false}`, temperature 0, and `max_tokens` capped near the input length.
  - Each step has 3 s for a dictation up to ~250 characters; longer ones get ~15 ms per expected output token on top, never more than 8 s. A step that errors, times out, comes back empty, or fails voice-lab's length/overlap guard keeps its input text.
  - Gemma runs first: run the other way round, Emberon mangles names like "Doozy".
- **Output:**
  1. Wait until modifiers are released.
  2. Save the clipboard.
  3. Write the text and send Ctrl+V with `SendInput`.
  4. After 350 ms, restore the clipboard, unless something else changed it in the meantime.

  If the clipboard cannot be read (so it could not be put back) or written, dictate never overwrites it: the text is typed as Unicode key events instead. If the focused control shows no caret, the paste may have landed nowhere, so the text stays on the clipboard rather than being restored over.
- **Robustness:**
  - single instance
  - llama-servers restart after a crash (1 s, 2 s, 4 s … backoff), and so do the recognizer and the hook
  - the servers sit in a kill-on-close Job object, so they die with dictate even if it is killed
  - log file at `%APPDATA%\dictate\logs\dictate.log`

## Speed and battery

Measured on the target laptop (Ryzen AI Max+ PRO 395, Radeon 8060S iGPU, 128 GB), on AC:

| What | Measured |
| --- | --- |
| Speech model load | 2.4 s |
| Gemma 4 E2B load + warm-up | 3.9–4.9 s + 0.35 s |
| Emberon-2 load + warm-up | 0.5–1.1 s + 0.06 s |
| Recognizer flush after release | ~90 ms |
| Cleanup chain, warm, 1-sentence dictation | 280 ms (Gemma 230 ms + Emberon 47 ms) |
| Fixture (14 s, 2 sentences) → STT flush → Gemma → Emberon → sink | 1085 ms |
| Release-to-paste, median of 5 real dictations | not measured yet: desktop QA is deferred (see [Desktop QA](#desktop-qa)); the median is shown in **Settings → History** once you have dictated |
| Idle CPU, whole process tree, 60 s | 0.6 % of one core (375 ms CPU per minute) |
| Memory, whole process tree | 4.7 GB working set (Gemma's mlocked weights are 3.2 GB) |

Before dictate's tuning, the same chain measured about 1.1 s + 0.23 s in voice-lab. Flash attention, `-np 1`, and a byte-identical cached system prompt bring it to about 0.3 s.

What keeps the battery cost down:

- Nothing runs in a loop while idle: no polling, and no idle decoding.
- The mic is open only while the key is held.
- The audio graph is suspended between dictations.
- llama-server runs with `--poll 0`, so it does not busy-wait.
- On battery, the models unload after 15 idle minutes (configurable). They reload on the next key press, and the pill says *Warming up…*.
- Optionally, cleanup is Emberon only on battery.
- On AC, everything stays resident.

## Troubleshooting

- **Nothing happens on Right Ctrl.**
  - Is the tray icon grey? The speech model is still loading.
  - Is it orange? Hover it for the error. Usually the models folder is wrong; fix it in **Settings → Advanced**.
- **Text is not pasted into an app running as administrator.** Windows blocks input from normal apps into elevated ones. The text is still on the clipboard and in history.
- **Words are cut at the start.** The mic opens when the key goes down, which takes about 100–200 ms. Start speaking just after pressing.
- **The mic is too quiet.** Raise its gain in **Settings → Microphone** until speech reaches the middle of the meter.
- **The cleanup changed a word it shouldn't have.** Open history (Right Ctrl + V), press Tab to see what was heard, and Shift + Enter to paste the raw transcript. Add the word to **Vocabulary**.
- **Logs:** tray → **Open log**.

## Development

```powershell
pnpm start        # build and run
pnpm test         # unit tests + integration tests (the integration tests skip without models)
pnpm typecheck
pnpm lint
$env:DICTATE_LLM_TESTS = '1'; pnpm test   # also run cleanup on real llama-servers
```

- `src/core/`: pure logic, unit-tested:
  - hotkey state machine
  - cleanup chain and guard
  - prompt templating
  - mic preference resolver
  - history store
  - gain
  - settings
- `src/engine/`: the recognizer and llama-server management (Node, no Electron).
- `src/native/`: Win32 through koffi (SendInput, the keyboard hook thread, the foreground window and caret, the Job object).
- `src/main/`: the Electron main process (tray, windows, the dictation flow, output).
- `src/renderer/`: the pill (and mic capture), the history picker, and settings. Plain DOM, no framework.

For QA without a microphone, use `DICTATE_FAKE_MIC=path\to\file.wav`. It plays the WAV through the real capture path at every key press. `DICTATE_DATA_DIR` points settings, history and logs at a scratch folder. `DICTATE_QA_DEVICES=path\to\devices.json` replaces the mic list with a file you can edit, to simulate plugging and unplugging mics.

### Desktop QA

`qa/qa.js` drives the real app on an unlocked desktop. It injects key presses and opens and types into Notepad, an Edge window and a terminal, so don't use the machine while it runs. It has not been run yet: the machine was locked throughout development.

```powershell
pnpm build
node qa/qa.js                 # every scenario
node qa/qa.js ptt picker      # some: ptt toggle esc tap picker browser body terminal crash mic
```

It covers hold-to-talk five times (with release-to-paste timing and the clipboard restored), double-tap toggle, Esc, a lone tap and Right Ctrl shortcuts, the history picker, an Edge text field, an Edge page with no field, a terminal, a Gemma crash, and a simulated mic unplug. It also records which targets show a text caret. Results go to `tmp/qa/out/summary.json` with screenshots, and its app data goes to `tmp/qa-data`, not your settings.

## Licence

AGPL-3.0. Copyright (c) 2026 Dcouple Inc. See [LICENSE](LICENSE).
