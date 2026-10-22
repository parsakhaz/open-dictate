# Building, testing and QA

Everything you need to work on open-dictate. For how the app is put together, see [architecture](../architecture/README.md).

## Build and run

Node 24 and pnpm 11.10.0 are required.

```sh
pnpm install --frozen-lockfile
pnpm start          # builds, then runs the app from source
pnpm typecheck
pnpm lint
pnpm test           # unit tests (vitest)
pnpm test:scripts   # installer and release script tests (node --test)
pnpm package        # native installers for this OS into dist/
```

`pnpm start` uses your normal data folder. To keep a development run apart from your real settings and history, set `DICTATE_DATA_DIR` (below).

### Linux

Install the graphical and native dependencies before starting. On Ubuntu or Debian (use `libasound2t64` on distributions that renamed `libasound2`):

```sh
sudo apt-get install libgtk-3-0 libnss3 libasound2 libgbm1 libxtst6 libxt6 libxrandr2 libx11-6 xdotool x11-utils
```

Linux ARM64 **source development** also needs `python3 build-essential pkg-config libx11-dev libxtst-dev libxrandr-dev libxt-dev`. The pinned upstream keyboard module mislabeled its ARM64 prebuild; `pnpm install` validates the executable architecture and builds a genuine native binding. Built installers already contain that binding and need only the runtime libraries above.

On Ubuntu 24.04+, prefer the `.deb` if the AppImage is blocked by the desktop's sandbox policy; the package installs its supported sandbox integration. Keep Chromium's sandbox enabled.

## Code layout

| Folder | What lives there |
| --- | --- |
| `src/core/` | Platform-free logic: hotkeys, capture, the cleanup chain and its guard, history, settings, the first-run steps, the hardware chooser, update rules. Pure and unit-tested. |
| `src/native/` | Windows hooks and WASAPI, Mac Quartz/Cocoa, X11 tools and desktop capabilities. |
| `src/engine/` | The streaming recognizer and the llama-server lifecycle. |
| `src/main/` | Electron main: tray, windows, model setup and downloads, the hardware check, output, auto-update. |
| `src/renderer/` | Plain DOM pages (pill, Settings, history picker) and the AudioWorklet capture. |
| `qa/` | Scripts that drive the real app, render screenshots, and build the README media. |
| `fixtures/` | `two-sentences.wav`, a 14 s English recording used by every audio test and the demo. |

## Configuration overrides

| Variable | Effect |
| --- | --- |
| `DICTATE_DATA_DIR` | Settings, history, logs and models go here instead of the normal data folder. |
| `DICTATE_MODELS_DIR` | Where the speech and cleanup models are read from. |
| `DICTATE_LLAMA_SERVER` | The llama-server executable (for example a Vulkan or CUDA build you compiled). |

**Advanced** in Settings accepts custom model and llama-server paths too. The old voice-lab developer paths are recognized only to migrate old settings; a new installation does not depend on them.

## Tests with real models

Unit tests skip anything that needs models. To run the real-model tests, point them at a models folder that has the speech model, Gemma and Emberon, and at a llama-server:

```sh
DICTATE_MODELS_DIR=... DICTATE_LLAMA_SERVER=... DICTATE_LLM_TESTS=1 pnpm vitest run
```

This runs the recognizer on the fixture, the cleanup chain, the end-to-end pipeline and the hardware check (`test/hardware.integration.test.ts`). Latency budgets are off by default; `DICTATE_LLM_MAX_MS=1500` or `DICTATE_E2E_MAX_MS=2500` enforce them. Cleanup that changes a correctly spelled vocabulary term is rejected and keeps its input.

## QA scripts

All of these isolate their data folder and close what they start.

| Script | What it proves | Needs |
| --- | --- | --- |
| `node qa/app-smoke.mjs` | A real WAV through the app's AudioWorklet capture, recognizer, output and history, plus cancel. Synthetic hotkeys, log output. | `DICTATE_MODELS_DIR` |
| `node qa/native-smoke.mjs` | Native clipboard, focus, typing and the physical-key hook. | A desktop session (Xvfb on Linux) |
| `node qa/settings-progress.mjs` | The Settings renderer: Getting started resumes at its step, download progress keeps the buttons, drafts survive state updates. | Nothing |
| `node qa/first-run.mjs` | The real first-run downloads (about 0.7 GB): cut at 30% and resumed, a full disk refused, then the speed check on real servers. `--gemma` also downloads Gemma and times its chain. | Network |
| `node qa/walkthrough.mjs --app <Dictate executable>` | Drives Getting started in a real (installed) app over DevTools on a fresh profile: quit mid-download and resume, speed check, practice dictation, Finish; `--full-disk-profile` on a small volume checks the disk-space refusal. | Network, a desktop session |
| `node qa/pill-input.js` | Windows native mouse clicks on cards, snooze/Undo, inbox shelf, choices and status Undo; focus and empty bounds; saves renderer images and native regions. `--preview` keeps a seeded local card open until Ctrl+C. Run `pnpm build` first. | An unlocked Windows desktop; isolated profile, no speech models needed |
| `node qa/qa.js` | The original Windows desktop driver: Notepad, browser and terminal paste, toggle, cancel, history and mic events. It types on the real keyboard and clipboard: use an isolated session. | An unlocked Windows desktop |

The app also has QA hooks for these scripts:

- `DICTATE_FAKE_MIC=<WAV>` with `DICTATE_CAPTURE=browser` plays a WAV through the real AudioWorklet path.
- `DICTATE_QA_CONTROL=<file>` accepts appended lines: `down` / `up` (the dictation key), `escape`, `focus`, `quit`. This tests the app pipeline, not the native keyboard hook.
- `DICTATE_QA_DEVICES=<JSON file>` simulates microphone hotplug.
- `DICTATE_QA_SINK=none` logs output instead of pasting.
- `DICTATE_SMOKE_TEST=<report.json>` runs the complete startup with a fresh temporary data folder, checks every renderer, the preload, IPC and native bindings, captures Settings, writes the report and quits.

## Screenshots and README media

The images in [docs/media](../media/index.html) are the real windows rendered off-screen, so they can be regenerated after a UI change:

```sh
pnpm build
electron qa/settingsshots.js "Hotkeys & output" Cleanup           # Settings pages → tmp/settings-shots/
electron qa/settingsshots.js --walkthrough=welcome,download,try    # Getting started steps
electron qa/media/media.js                                         # pill, picker, hero and the demo frames
node qa/media/build.mjs                                            # frame, optimise and encode into docs/media/
```

(`electron` is `node_modules/electron/dist/electron.exe` on Windows.) `qa/fixture-timeline.mjs` records the real recognizer's words and the real cleanup for a WAV; the demo replays that file. `build.mjs` needs ffmpeg.

Original UX regression checks: `node qa/ux-baseline-build.cjs`, then run `qa/ux-baseline.cjs` with Electron (hidden offscreen rendering). Compare PNGs under `tmp/verify/ux-restore/visual`. `node qa/ux-restore.js` checks real isolated IPC, toast expiry and native host hiding without OS pointer input.
