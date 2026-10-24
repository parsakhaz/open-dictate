# Process model

What runs where, why it is separate, and how the pieces talk. For the flow of one dictation, see the [overview](README.md).

```
                         ┌──────────────────── Electron main ─────────────────────┐
                         │ settings · history · session · tray · IPC · output     │
                         │ uiohook (macOS/X11)                                    │
                         └──┬────────┬─────────┬──────────┬──────────┬────────────┘
             ipc dictate:*  │        │         │ worker   │ worker   │ spawn (HTTP on 127.0.0.1)
          ┌─────────────────┤        │         ▼          ▼          ▼
          ▼                 ▼        │   keyhook worker  mic worker  llama-server (Gemma)
   Settings renderer   Picker        │   (Windows)       (Windows)   llama-server (Emberon)
                       renderer      │                      │
          Pill renderer ◄────────────┤ utilityProcess.fork  │ audio via main's port
          (browser capture)          ▼                      ▼
               └──── MessagePort ──► STT utility process ◄──┘
```

## Processes

| Process | Why it is separate |
| --- | --- |
| **Main** ([src/main/main.ts](../../src/main/main.ts)) | Owns every piece of state. Pure rules live in `src/core/` and are injected, so main is mostly wiring. |
| **STT utility process** ([src/engine/stt-worker.ts](../../src/engine/stt-worker.ts)) | Decoding is CPU-heavy; in its own process it never delays hotkeys or the UI. Forked with `utilityProcess.fork` from `out/engine/stt-worker.js`. If it exits, main restarts it after 1 s. |
| **Pill renderer** ([src/renderer/pill.ts](../../src/renderer/pill.ts)) | Needs a browser for `getUserMedia`, the AudioWorklet and `enumerateDevices`. It is created once at start-up, with `backgroundThrottling: false` so capture keeps running while hidden. If it crashes, main recreates it and restarts the recognizer so both ends get fresh ports. |
| **Settings renderer** ([src/renderer/settings.ts](../../src/renderer/settings.ts)) | An ordinary window, created on demand and destroyed on close. |
| **Picker renderer** ([src/renderer/picker.ts](../../src/renderer/picker.ts)) | Created at start-up and kept hidden, so it opens instantly. |
| **Keyboard hook worker** ([src/native/keyhook-worker.ts](../../src/native/keyhook-worker.ts)) | Windows only. A `WH_KEYBOARD_LL` hook must answer fast; on its own thread a busy main process never delays typing. Restarted with backoff (0.5 s doubling to 10 s) by [src/main/keyhook.ts](../../src/main/keyhook.ts). |
| **Native mic worker** ([src/native/mic-worker.ts](../../src/native/mic-worker.ts)) | Windows only. WASAPI capture blocks on an event handle, so it gets a thread. |
| **llama-server ×2** ([src/engine/llama.ts](../../src/engine/llama.ts)) | Upstream llama.cpp binaries, one per cleanup model, talked to over HTTP. See [speech-and-cleanup.md](speech-and-cleanup.md). |
| **Lifetime watchdog** ([src/native/posix-lifetime.ts](../../src/native/posix-lifetime.ts)) | macOS/Linux. A small Node process (Electron as Node) that kills enrolled llama-servers when main's IPC channel closes, even after a crash. On Windows each server joins a job object with `KILL_ON_JOB_CLOSE` ([src/native/win32.ts](../../src/native/win32.ts) `killWithUs`). |

## How they talk

**Renderer ↔ main.** One preload, [src/main/preload.ts](../../src/main/preload.ts), exposes `window.dictate` with `send`, `invoke` and `on`. It refuses any channel that does not start with `dictate:`. Renderers run with `contextIsolation: true`. Main registers every channel in `registerIpc()`: `invoke` for requests that return the new state (`dictate:set-settings`, `dictate:setup-models`, `dictate:hardware-check` …), `send` for events (`dictate:capture-started`, `dictate:devices`, `dictate:picker-choose` …). Main pushes the full state to Settings on `dictate:state` and status to the pill on `dictate:pill`.

**Audio → recognizer.** Audio never passes through main's event loop on the browser path. Main creates a `MessageChannelMain`, posts one end to the STT process (`attach`) and the other to the pill (`dictate:stt-port`). MessagePorts cannot cross the context bridge, so the preload hands the port to the page with `window.postMessage`. [src/main/sttlink.ts](../../src/main/sttlink.ts) makes the link only once both the recognizer is running and the pill has said `dictate:pill-ready`, because a port posted before the page listens is silently lost. Native capture uses a second port that main itself holds.

**Main ↔ STT.** `init` / `attach` / `probe` in; `ready`, `partial`, `final`, `cancelled`, `error` out, on the utility process's `parentPort`. On the audio port: `begin`, `frame`, `end`, `cancel`, each with the session id.

**Main ↔ workers.** `worker_threads` with a `MessageChannel`. The hook thread sits in `GetMessageW`; after posting config main sends `WM_APP_WAKE` to that thread so it reads its port.

## Windows

[src/main/windows.ts](../../src/main/windows.ts) creates three windows:

| Window | Focus | Notes |
| --- | --- | --- |
| Pill | Never activates: `WS_EX_NOACTIVATE` on Windows (Chromium drops clicks on a `focusable: false` window there), shown with `showInactive()` | Transparent, frameless, always on top at `screen-saver` level, ignores the mouse except over a card, an inbox control or the mic toast's Undo. At the Settings → Pill position spot (bottom centre by default) of the display under the cursor, inside its work area. |
| Picker | `focusable: false` on Windows; focusable elsewhere | On Windows the hook captures its keys, so the app being typed into keeps focus. On macOS/Linux the hook cannot swallow keys, so the picker takes focus and closes on blur. |
| Settings | Normal | Mica title bar on Windows. |

## Lifecycle

- **Single instance.** `app.requestSingleInstanceLock()`; a second launch quits and the first opens Settings.
- **Tray.** The app lives in the tray (menu bar on macOS, dock icon hidden). Left-click opens Settings; the menu has Start/Finish, history, microphone, cleanup chain, output mode, sounds, Getting started, log and Quit. Closing Settings does not quit (`window-all-closed` is a no-op).
- **Quit.** `before-quit` flushes settings and history, cancels downloads, stops the hook, mic worker, llama-servers and recognizer.
- **Start at login.** [src/main/startup.ts](../../src/main/startup.ts): Electron login items on Windows and macOS, an XDG autostart `.desktop` file on Linux. Off by default; the last walkthrough step asks.
- **Media permission.** Only Dictate's own `file:` pages may get audio-only media access.

## Where data lives

`app.setName('dictate')` puts user data in `%APPDATA%\dictate`, `~/Library/Application Support/dictate` or `~/.config/dictate`. `DICTATE_DATA_DIR` overrides it.

| Path | Written by |
| --- | --- |
| `settings.json` | [src/main/store.ts](../../src/main/store.ts) via a 300 ms debounced writer; atomic (temp file, then rename). An unparseable file is kept as `settings.json.bad` and defaults are used. |
| `history.json` | Same writer. Pinned items are never evicted; the rest are capped at `historyLimit` (200) ([src/core/history.ts](../../src/core/history.ts)). |
| `logs/dictate.log` | [src/main/log.ts](../../src/main/log.ts). Renderer errors are forwarded here too. |
| `models/` | The speech model folder and the two GGUFs. Archives stage in `models/.downloads/`; partial files are `.<name>.part`. |
| `bin/` | The llama.cpp runtime (`llama-server` and its libraries). |

## First run: Getting started

[src/core/onboarding.ts](../../src/core/onboarding.ts) defines the steps: welcome, licences, download, hardware, microphone, hotkey, try, done. Settings renders them and saves `onboardingStep`, so a quit resumes where it stopped; the licences step can't be skipped. The download step starts the `essentials` install (speech model, Emberon and llama.cpp) in the background; the hardware step runs the speed check that picks the default chain. The "try" step sets `practicing`, and a dictation finished while Settings has focus goes to the practice box instead of being pasted. Settings opens automatically until `onboarded` is true.

## Auto-update

[src/core/updates.ts](../../src/core/updates.ts) holds the rules; [src/main/updater.ts](../../src/main/updater.ts) runs them.

| Build | Mode | Behaviour |
| --- | --- | --- |
| Windows (NSIS), Linux AppImage | `install` | `electron-updater` downloads from GitHub Releases in the background and installs on quit, or after 10 idle minutes. |
| macOS, `.deb` | `notify` | Asks the GitHub releases API for the latest tag and links to the release page. |
| Unpackaged | `off` | Never checks. |

The first check is a minute after start, then daily. An install never starts during a recording, cleanup, download or speed check; whatever is running restarts the idle clock when it ends. Settings → About → Automatic updates (`autoUpdate`, on by default) turns it off.
