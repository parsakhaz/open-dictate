# Architecture

How open-dictate is put together, for contributors. Each claim here points at the code it describes; when they disagree, the code wins and the doc needs fixing.

| Doc | What it covers |
| --- | --- |
| [process-model.md](process-model.md) | Every process and window, how they talk, where data lives, first run, start at login, auto-update. |
| [speech-and-cleanup.md](speech-and-cleanup.md) | The streaming recognizer, live cleanup, the cleanup chain and its guard, llama-server, vocabulary, the speed check, model downloads. |
| [input-and-output.md](input-and-output.md) | The keyboard hook per platform, the hotkey state machine, microphone capture, paste and clipboard, the history picker. |

## Source layout

| Folder | Holds |
| --- | --- |
| [src/main/](../../src/main) | The Electron main process: tray, windows, IPC, model setup, output, auto-update. |
| [src/core/](../../src/core) | Pure logic with no Electron imports: hotkeys, capture sessions, cleanup chain, guard, history, settings. Unit-tested directly. |
| [src/engine/](../../src/engine) | The recognizer (sherpa-onnx) and the llama-server process wrapper. |
| [src/native/](../../src/native) | OS integration through koffi: Windows hook, WASAPI and clipboard; macOS Quartz/Cocoa; X11 via `xdotool`. |
| [src/renderer/](../../src/renderer) | Plain DOM pages (pill, Settings, picker) and the capture AudioWorklet. |

[build.mjs](../../build.mjs) bundles each entry point with esbuild into `out/`; native modules (`sherpa-onnx-node`, `koffi`, `uiohook-napi`) stay external and are unpacked from the ASAR by [electron-builder.cjs](../../electron-builder.cjs).

## Processes at a glance

| Process | Built from | Job |
| --- | --- | --- |
| Electron main | [src/main/main.ts](../../src/main/main.ts) | Owns state: settings, history, the dictation session, tray, IPC, output. |
| Pill renderer | [src/renderer/pill.ts](../../src/renderer/pill.ts) | Transparent, click-through, never focused. Shows status, plays cues, runs browser mic capture and device enumeration. |
| Settings renderer | [src/renderer/settings.ts](../../src/renderer/settings.ts) | Settings pages and the Getting started walkthrough. Created on demand. |
| Picker renderer | [src/renderer/picker.ts](../../src/renderer/picker.ts) | The history picker. On Windows it never takes focus. |
| STT utility process | [src/engine/stt-worker.ts](../../src/engine/stt-worker.ts) → `out/engine/stt-worker.js` | Streaming speech recognition, off the main thread. |
| Keyboard hook worker | [src/native/keyhook-worker.ts](../../src/native/keyhook-worker.ts) | Windows only: a low-level hook on its own thread. macOS and X11 use `uiohook-napi` in main instead. |
| Native mic worker | [src/native/mic-worker.ts](../../src/native/mic-worker.ts) | Windows only: WASAPI capture on its own thread. |
| llama-server ×2 | [src/engine/llama.ts](../../src/engine/llama.ts) | One child process per cleanup model (Gemma, Emberon), on a free port on 127.0.0.1. |
| Lifetime watchdog | [src/native/posix-lifetime.ts](../../src/native/posix-lifetime.ts) | macOS/Linux only: kills the llama-servers if main dies abruptly. Windows uses a job object instead. |

## One dictation, end to end

```
 key down ──► hook ──► HotkeyMachine 'start' ──► capture starts at once (native or browser)
                                                   │ 100 ms chunks over a MessagePort
                                                   ▼
 hold past 250 ms ──► 'mode' ──► pill shows    STT utility process ──► partials ──► main ──► pill
 (or double-tap)                                   │                          └─► live cleanup (optional)
 key up ──► 'stop' ──► flush + 'end' ─────────────►│ pads 0.8 s silence, decodes the rest
                                                   ▼
                                                 final ──► cleanup chain (Gemma → Emberon, guarded)
                                                              ▼
                                                 history.json (saved before delivery)
                                                              ▼
                                                 output: paste via clipboard, or clipboard only
```

1. **Key down.** The hook reports the key; [src/core/hotkeys.ts](../../src/core/hotkeys.ts) emits `start`. Main opens a session and starts capture immediately, so the first word is not lost while it waits to see whether this is a hold or a tap ([src/main/main.ts](../../src/main/main.ts) `onHotkey`).
2. **Capture.** [src/main/capture.ts](../../src/main/capture.ts) routes the session to native WASAPI capture on Windows, or to the pill's AudioWorklet otherwise. Both produce 16 kHz mono, 100 ms chunks tagged with the session id, sent straight to the recognizer over a MessagePort.
3. **Partials.** The recognizer decodes as audio arrives and sends partial text to main, which forwards it to the pill and, when live cleanup is on, to the sentence segmenter ([src/core/live.ts](../../src/core/live.ts)).
4. **Mode.** A hold past `tapMs` (250 ms) is push-to-talk; a double-tap is hands-free. Only now does the pill appear. A lone tap or a shortcut (Right Ctrl+C) cancels the capture silently.
5. **Key up.** Capture flushes its last partial chunk and sends `end`; the recognizer pads 0.8 s of silence and returns the final. Main waits at most 6 s, then falls back to the last partial.
6. **Cleanup.** [src/main/pipeline.ts](../../src/main/pipeline.ts) runs the chain from [src/core/chain.ts](../../src/core/chain.ts). Any step that fails, times out or fails the guard keeps its input, so the transcript is never lost.
7. **History.** The entry is written to `history.json` *before* delivery, so a hung paste or a quit mid-paste keeps the words.
8. **Output.** [src/main/paste.ts](../../src/main/paste.ts) snapshots the clipboard, writes the text, sends Ctrl+V (Cmd+V on macOS) and restores the old clipboard when the target can be confirmed. See [input-and-output.md](input-and-output.md).

Esc cancels at any point until the text starts going out: during recording it stops capture; after release it aborts the cleanup and nothing is pasted.
