# dictate

[![Dictate CI](https://github.com/parsakhaz/experiments/actions/workflows/dictate.yml/badge.svg)](https://github.com/parsakhaz/experiments/actions/workflows/dictate.yml)

Local English dictation for **Windows, macOS and Linux**. Hold a dictation key, speak, and release to transcribe. Optional local cleanup fixes punctuation and vocabulary. Speech recognition and cleanup run on your computer; setup downloads the models once.

## Install and test

This branch adds native build artifacts to [Dictate CI](https://github.com/parsakhaz/experiments/actions/workflows/dictate.yml). Until a `dictate-v…` release is published, open the successful run for PR #19 and download the artifact for your computer:

| Computer | Build | Install |
| --- | --- | --- |
| Windows 10/11 x64 | `dictate-package-win-x64-…` | Run the NSIS `.exe`. Windows ARM can use x64 emulation; there is no native ARM64 Windows build. |
| Apple Silicon Mac | `dictate-package-mac-arm64-…` | Open the DMG and drag Dictate to Applications, or unzip the application. |
| Intel Mac | `dictate-package-mac-x64-…` | Same installation, using the Intel artifact. |
| Linux x64 or ARM64 | `dictate-package-linux-<arch>-…` | Install the `.deb`, or make the AppImage executable and run it. X11 requires `xdotool`, `libXtst`, GTK3 and a desktop session. |

macOS test builds are unsigned unless signing credentials are configured. Open the application through Finder's **Open** action and approve it in **System Settings → Privacy & Security** when macOS asks. Microphone, Accessibility and Input Monitoring permissions are required for global dictation and paste. Restart Dictate after changing keyboard permissions. Signing/notarization is separate from native build verification.

1. Open Dictate. **Welcome → Download speech model** installs the 443 MB English streaming model into your own application-data folder. Downloads check the pinned byte count and SHA-256 before installation. `tar` must be available (standard on Windows 10+, macOS and supported Linux distributions).
2. On Mac, use **Enable access** to request microphone/keyboard permissions. Enable Dictate in the permissions settings indicated above.
3. Select a microphone and verify that its meter moves. Press **Get started**. **Start at login** is optional and can be changed later.
4. In another application's text field, hold **Right Ctrl** on Windows/Linux X11 or **Right Option** on Mac, speak, then release. Wait for the live meter/start sound before speaking if your microphone wakes slowly.
5. Optional: **Cleanup → Download cleanup models** installs Gemma, Emberon and the appropriate pinned llama.cpp binary (about 3.2 GB). New installations start with raw transcription; existing Windows cleanup settings are preserved.

Use **Start dictation / Finish dictation** in the tray or **Hotkeys & output** if your keyboard shortcut is unavailable. **Clipboard only** output works without permission to type into another application.

## Platform behavior

| Capability | Windows x64 | macOS x64 / ARM64 | Linux X11 x64 / ARM64 | Linux Wayland |
| --- | --- | --- | --- | --- |
| Streaming microphone capture | Native WASAPI, WebAudio fallback | WebAudio | WebAudio | WebAudio |
| Hold / double-tap dictation key | Native keyboard hook | With keyboard permissions | With X11 input access | Desktop does not expose raw key-up events |
| Start / finish from app or tray | Yes | Yes | Yes | Yes |
| Desktop toggle shortcut | Configurable hook binding | Configurable hook binding | Configurable hook binding | **Enable desktop shortcut** requests the compositor's portal; availability depends on the desktop |
| Automatic paste | Ctrl+V / SendInput | Cmd+V / Quartz with Accessibility | XTest through `xdotool`; terminals use Ctrl+Shift+V | Clipboard only; paste manually |
| Consume dictation/picker keys | Yes | Listener observes keys without consuming them | Listener observes keys without consuming them | Not available |
| History picker | Does not take focus | Focused window with local keys | Focused window with local keys | Focused window; copy from history |
| Start at login | Native login item | Native login item | XDG autostart | XDG autostart |

On Mac/Linux X11, choose an unused dictation key: other applications also receive the key. The Windows-only default history shortcut Right Ctrl+V is disabled on fresh Mac/Linux installs so it cannot also trigger another application's paste. Open history through the tray or **Hotkeys & output**. Custom global combinations also reach the focused app on these platforms.

Wayland's isolation is intentional: Dictate does not pretend XWayland grants access to native Wayland apps. The settings page explains copy-only output and offers an explicit portal toggle registration. If the compositor has no working global-shortcut portal, use the app/tray controls. A successful X11 CI run does not prove a particular Wayland compositor's portal.

The clipboard is restored only when the target can be confirmed. On X11, or a Mac control that does not expose a text role, the text remains copied after the paste attempt so it is recoverable. A key-injection success cannot prove the target accepted text. Every transcript also goes to local history. Windows privacy formats exclude transient text from Windows cloud/history; Mac uses concealed/transient pasteboard hints. Linux clipboard managers and Mac Universal Clipboard may retain ordinary copied text according to their own settings.

## Using it

- **Hold** the dictation key for push-to-talk; **double-tap** for hands-free and tap again to finish. A lone tap or an early shortcut cancels speculative capture.
- **Esc** cancels a recording or cleanup. On Mac/Linux the focused application can also receive Esc.
- Add up to four dictation bindings in **Hotkeys & output**. For a programmable mouse, map a button to F13–F24, then add that key. A dedicated key's single tap toggles dictation.
- **History** lets you search, pin, copy, paste or use the raw transcript. Arrow keys navigate, Enter pastes, Shift+Enter uses raw text, Tab expands the raw view, and Esc closes.
- **Say “press enter” to send** is off by default. When enabled, a final “press enter” requests Enter after confirmed delivery. It does not send Enter on an unconfirmed target.
- Closing Settings keeps Dictate in the tray/menu bar. **Quit dictate** also stops its recognizer and cleanup servers.

Microphones are remembered in preference order. Unplugging one falls back to another or to system default; returning devices offer an Undo notice. A recording does not switch to a better device midway. If its mic disappears, captured audio is kept and Dictate tries the default input. Input gain is per microphone name.

**Keep the mic ready** is a Windows native-capture feature; WebAudio releases its stream after each recording on Mac/Linux. Warm Bluetooth headset capture can reduce playback quality, so leave it off unless needed.

## Configuration and models

| OS | Default settings/history/log/models location |
| --- | --- |
| Windows | `%APPDATA%\dictate\` |
| macOS | `~/Library/Application Support/dictate/` |
| Linux | `$XDG_CONFIG_HOME/dictate/` (normally `~/.config/dictate/`) |

The folder contains `settings.json`, `history.json`, `logs/dictate.log`, `models/` and downloaded `bin/` tools. Upgrades keep it. Uninstalling the application does not delete your dictations or multi-gigabyte model downloads.

**Advanced** accepts custom model and llama-server paths. `DICTATE_DATA_DIR`, `DICTATE_MODELS_DIR` and `DICTATE_LLAMA_SERVER` override paths for isolated testing. The old voice-lab developer paths are recognized only to migrate old settings; a new installation does not depend on them. The legacy `startWithWindows` preference is migrated to `startAtLogin`.

Pinned setup sources and digests live in [`src/main/downloads.ts`](src/main/downloads.ts):

- [sherpa-onnx Nemotron streaming model](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models): 0.6B int8, 1120 ms chunks, CPU recognizer.
- [Gemma 4 E2B GGUF](https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF) and its [model license](https://ai.google.dev/gemma/docs/gemma_4_license).
- [Emberon-2](https://huggingface.co/PromethicLabs/Emberon-2) and its [model license](https://huggingface.co/PromethicLabs/Emberon-2/blob/main/LICENSE).
- [llama.cpp b11700](https://github.com/ggml-org/llama.cpp/releases/tag/b11700): portable CPU binaries on Windows/Linux and Metal-enabled binaries on Mac, with adjacent native libraries preserved. Custom Vulkan/GPU builds remain usable through the configured path.

Model licenses are separate from Dictate's application license. Setup contacts GitHub and Hugging Face to retrieve the pinned files; runtime transcription and cleanup use local processes.

## Release system

The [workflow](../.github/workflows/dictate.yml) checks, builds and smoke-launches the real application on native Windows x64, Mac ARM64/Intel and Linux x64/ARM64 runners. Installer artifacts contain native installers, checksum-verifying scripts and SHA-256 checksums. Separate `dictate-evidence-<platform>-<arch>-…` artifacts contain startup reports/screenshots, native input checks and the app audio/cancel journey. Native dependencies are unpacked from Electron's ASAR archive; a real fixture is also transcribed by the packaged recognizer utility process. Startup smoke does not grant OS permissions or exercise a physical microphone.

PRs and ordinary branch pushes always use `--publish never`. A release requires a `dictate-v<package version>` tag, or explicit authorized dispatch, and all native jobs must succeed before publication. Checksums are generated after builds. No feature branch becomes a stable release merely because CI passed.

After releases exist, the portable installers in [`scripts/install.sh`](scripts/install.sh) and [`scripts/install.ps1`](scripts/install.ps1) select the correct OS/architecture and verify the release checksum. They select Dictate releases rather than unrelated experiments releases. See their help for an exact version, a custom location and private-repository authentication. Re-running the installer upgrades the application and preserves its data.

## Development and validation

Node 24 and pnpm 11.10.0 are required. From this directory:

```sh
pnpm install --frozen-lockfile
pnpm start
pnpm typecheck
pnpm lint
pnpm test
pnpm test:scripts
pnpm package
```

On Linux, install the graphical/native dependencies before starting. On Ubuntu 24.04+, prefer the `.deb` if the AppImage is blocked by the desktop’s sandbox policy; the package installs its supported sandbox integration. Keep Chromium’s sandbox enabled. Ubuntu/Debian (use `libasound2t64` on distributions that renamed `libasound2`):

```sh
sudo apt-get install libgtk-3-0 libnss3 libasound2 libgbm1 libxtst6 libxt6 libxrandr2 libx11-6 xdotool x11-utils
```

Linux ARM64 **source development** also needs `python3 build-essential pkg-config libx11-dev libxtst-dev libxrandr-dev libxt-dev`. The pinned upstream keyboard module mislabeled its ARM64 prebuild; installation validates the executable architecture and builds a genuine native binding. Built installers already contain that binding and need only the runtime libraries above.

`src/core/` holds shared hotkey, capture, cleanup, history and settings logic. `src/native/` isolates Windows hooks/WASAPI, Mac Quartz/Cocoa, X11 tools and desktop capabilities. `src/engine/` hosts recognition and llama-server lifecycle. `src/main/` owns tray, windows, model setup and output; `src/renderer/` is plain DOM plus AudioWorklet capture.

Real-model tests run when `DICTATE_MODELS_DIR` contains the model files. Set `DICTATE_LLAMA_SERVER` and `DICTATE_LLM_TESTS=1` to run real cleanup too. Their latency measurements originated on a Ryzen AI Max+ PRO 395/Vulkan Windows laptop; they are not cross-platform performance promises. Set `DICTATE_LLM_MAX_MS=1500` or `DICTATE_E2E_MAX_MS=2500` to enforce the original hardware benchmark budgets. Cleanup that changes a correctly spelled vocabulary term is rejected and keeps its input. CI's ordinary unit tests explicitly skip missing model prerequisites. See the PR's evidence for the actual model checks performed on this revision.

For isolated application QA:

- `DICTATE_DATA_DIR=<temporary folder>` isolates settings/history/logs.
- `DICTATE_FAKE_MIC=<WAV>` with `DICTATE_CAPTURE=browser` plays the fixture through the real AudioWorklet path.
- `DICTATE_QA_CONTROL=<file>` accepts appended `down` / `up` lines for a synthetic hotkey journey; this tests the app pipeline, not the native keyboard hook.
- `DICTATE_QA_DEVICES=<JSON file>` simulates microphone hotplug.
- `DICTATE_SMOKE_TEST=<report.json>` runs the complete startup with a fresh temporary data folder, checks all renderers/preload/IPC and native bindings, captures Settings, writes the report and quits.

`node qa/app-smoke.mjs --report tmp/app-smoke/report.json` runs a real WAV through the application’s AudioWorklet capture, recognizer transport, output/history, and cancel flow using `DICTATE_MODELS_DIR`. It uses synthetic hotkeys and a log output sink; native input is tested separately with `node qa/native-smoke.mjs --report tmp/native-input.json` (Linux needs a graphical session or Xvfb). Both isolate their data and close their own processes.

The original Windows desktop driver `qa/qa.js` still covers Notepad, browser and terminal paste, toggle, cancel, history and mic events on an unlocked Windows desktop. It interacts with the actual keyboard/clipboard, so use an isolated test session and read its setup before running. Its previous 49/49 result predates this portability change; new per-OS evidence belongs to the current PR/CI run.

## Troubleshooting

- **Missing speech model:** use the download button or correct **Advanced → Models folder**. A failed checksum leaves prior files intact; retry after checking available disk space and network access.
- **Mac shortcut does nothing:** enable Dictate under Accessibility and Input Monitoring, enable Microphone, then restart. Use **Start dictation** to separate shortcut permissions from microphone/model problems.
- **Linux shortcut or paste unavailable:** check the displayed capability reason. X11 needs `xdotool` and XTest; Wayland uses portal toggle/copy-only. A headless shell is not a desktop session.
- **Windows elevated application:** Windows may block injected input. The text stays in clipboard/history.
- **Silent or slow-starting mic:** check the meter/gain and wait for the start cue. Reconnect the device or select system default.
- **Cleanup changes too much or cannot run:** select **Off** to keep raw text, use history's raw view and add spellings under Vocabulary. CPU cleanup can be slower than a GPU build.
- **No tray icon:** your Linux desktop may need a tray/AppIndicator extension. Launch Dictate again to reopen Settings without starting a second instance.
- **Diagnosis:** tray → **Open log**. Startup failures and denied native features are logged instead of silently claiming success.

## Licence

AGPL-3.0. Copyright (c) 2026 Dcouple Inc. See [LICENSE](LICENSE).
