# Input and output

How a key press becomes a recording, how audio is captured, and how text reaches the focused app. User-facing platform differences are summarised in the [README](../../README.md#platform-behavior).

## The keyboard hook

Every platform feeds the same `{ type: 'key', vk, down, t }` events into main's `onHook` ([src/main/main.ts](../../src/main/main.ts)). Key codes are Windows virtual-key codes everywhere; side-specific modifiers (Right Ctrl is `0xA3`) are what make Right Ctrl usable as a dictation key. [src/native/platform.ts](../../src/native/platform.ts) `platformCapabilities()` reports what the current desktop allows, with a human-readable `reason` when something is missing.

| Desktop | Source | Can swallow keys | Notes |
| --- | --- | --- | --- |
| Windows | `WH_KEYBOARD_LL` in a worker thread ([src/native/keyhook-worker.ts](../../src/native/keyhook-worker.ts)) | Yes | Ignores its own injected keys by `dwExtraInfo` (`DICTATE_EXTRA`). Drops the fake Left Ctrl that AltGr layouts send with Right Alt (`AltGrFilter`). A mouse hook runs only while the picker is open. |
| macOS | `uiohook-napi` in main ([src/native/portable-keyhook.ts](../../src/native/portable-keyhook.ts)) | No | Needs Accessibility and Input Monitoring; a restart is usually needed after granting. Scan codes are mapped to VK codes in [src/native/keymap.ts](../../src/native/keymap.ts). |
| Linux X11 | `uiohook-napi` in main | No | Same as macOS. Focus and paste go through `xdotool` ([src/native/x11.ts](../../src/native/x11.ts)). |
| Linux Wayland | None | — | The compositor does not expose global key-up events. An optional desktop shortcut is registered with `globalShortcut` (the portal) and can only toggle. |

On macOS and X11, events that arrive within 100 ms of Dictate's own injected keystrokes are ignored ([src/native/generated-input.ts](../../src/native/generated-input.ts)), so a paste cannot retrigger a Cmd or Ctrl dictation key. The tray's Start/Finish and the Settings buttons work on every desktop and share the hotkey machine's toggle state.

**What the Windows hook swallows** (configured from main with `config`, `recording` and `capture` messages):

- the last key of the picker and toggle combos, so Right Ctrl+V never pastes into the app;
- dedicated dictation keys (F13–F24, Pause, Scroll Lock, Insert, Menu);
- Esc while a recording or a post-release cleanup is cancellable;
- every non-modifier key while the picker is open, except Alt and Win combos.

A key whose down was swallowed has its up swallowed too. When a binding uses a lone Alt or Win key, the hook injects an unassigned key (`0xE8`) while it is down, so releasing it does not open a menu bar or Start (`menuMaskKeys` in [src/core/hotkeys.ts](../../src/core/hotkeys.ts)).

## The hotkey state machine

[src/core/hotkeys.ts](../../src/core/hotkeys.ts) `HotkeyMachine` turns raw downs and ups into `start`, `mode`, `stop`, `cancel` and `picker`. It is pure, with injected timers.

```
 idle ──down──► press1 ──held 250 ms──► push-to-talk ──up──► stop
                  │ up (tap)
                  ▼
               tapped ──down within 350 ms──► press2 ──up (tap)──► toggle ──next press──► stop
                  │ timeout                     └──held──► push-to-talk (keeps the first tap's audio)
                  ▼
               cancel (lone tap)
```

- `start` fires on the first key down, so capture begins before anyone knows whether it is a hold. The pill only appears on `mode`.
- Another key during `press1`/`press2` means a shortcut (Right Ctrl+C): `cancel`, nothing typed. During push-to-talk the same applies for the first 1.5 s (`KEEP_WORDS_MS`); after that the dictation is finished and kept.
- Up to four dictation bindings (`settings.hotkeys`), plus an optional toggle combo and the picker combo. A dedicated key toggles hands-free on a single tap, since mouse software may only send taps.
- Esc cancels any recording. After release, main handles Esc itself and aborts every dictation still transcribing or cleaning. Either way the words heard go to history, uncleaned, and nothing is pasted.
- Timings are `tapMs` (250) and `doubleTapMs` (350), both settings. `clearKeys()` runs after unlock and resume, since key-ups during a locked session are never seen.

Defaults ([src/main/config.ts](../../src/main/config.ts)): Right Ctrl on Windows and Linux, Right Option on macOS. The picker combo Right Ctrl+V is Windows-only, because elsewhere the hook cannot swallow the V.

## Microphone capture

[src/main/capture.ts](../../src/main/capture.ts) `CaptureRouter` picks a path per recording. Both paths run the same session logic, [src/core/capture.ts](../../src/core/capture.ts) `CaptureController`: one queue for start, stop, cancel and device switch, so a new recording never overlaps the previous flush, and every chunk is tagged with its session id, so audio never leaks between recordings.

| | Windows (native) | Browser path (macOS, Linux, Windows fallback) |
| --- | --- | --- |
| Code | [src/native/mic-worker.ts](../../src/native/mic-worker.ts), [src/native/wasapi.ts](../../src/native/wasapi.ts), [src/main/nativemic.ts](../../src/main/nativemic.ts) | [src/renderer/capture.ts](../../src/renderer/capture.ts), [src/renderer/worklet.ts](../../src/renderer/worklet.ts) in the pill |
| Device API | WASAPI shared mode, device mix format, event-driven | `getUserMedia` with echo cancellation, noise suppression and AGC off |
| To 16 kHz | [src/core/resample.ts](../../src/core/resample.ts) | `AudioContext({ sampleRate: 16000 })` |
| Chunking | `Chunker` on the mic thread | `Chunker` in the AudioWorklet |
| To recognizer | main's MessagePort | the pill's MessagePort |
| Keep warm | `micWarm`: off, 30 s or always (on AC) ([src/core/warm.ts](../../src/core/warm.ts)) | Stream closed after each recording |

Native capture opens the endpoint whose name matches the browser's device label. If it cannot open the chosen mic, that recording moves to the browser path. `DICTATE_CAPTURE=browser` forces the browser path. A warm stream closes on lock, sleep, battery saver and device changes. The default is always on AC, because a cold mic can take about 1 s to open and clip the first words; until the person picks a value (`micWarmSet`), a Bluetooth headset is left closed, because a held-open headset mic stays in call mode.

Gain is applied in the `Chunker` by [src/core/agc.ts](../../src/core/agc.ts), the same on both paths. With `autoGain` (the default) it is automatic gain control: 20 ms frames above a slowly rising noise floor count as speech, and only speech may raise the gain, slowly (0.75 s), towards -20 dBFS; anything too loud lowers it fast (75 ms), a boosted peak past the limiter's knee lowers it at once, and silence holds it. `gainDb` (per mic, keyed by normalised label) is its maximum boost, or the fixed gain when `autoGain` is off. Each level message carries the applied gain; at the end of a dictation main saves it to `agcGainDb`, where the next dictation on that mic starts. A silence watch drives the pill's "Can't hear you" hint.

**Mic preference** ([src/core/mics.ts](../../src/core/mics.ts) `MicSelector`). Devices are enumerated in the pill and sent to main as `dictate:devices`. Picking a mic moves it to the top of `micOrder`. If the active mic disconnects, capture switches at once to the next preference or the system default; mid-recording, it keeps what was heard and continues on the default. If a more-preferred mic reappears, the switch waits until the recording ends and shows an Undo toast; undoing declines that mic until it is unplugged. Identical USB mics are told apart by `groupId` within a session.

## Paste and output

[src/main/pipeline.ts](../../src/main/pipeline.ts) saves history, then calls the sink. Dictations get a trailing space unless they end in whitespace or an opening bracket/quote. [src/main/paste.ts](../../src/main/paste.ts) holds the rules with injected ports; [src/main/output.ts](../../src/main/output.ts) wires the real clipboard and input. Deliveries run one at a time.

| Output mode | Behaviour |
| --- | --- |
| `paste` (default) | Snapshot every clipboard format → write text → Ctrl+V / Cmd+V → after 350 ms restore the snapshot, only if the clipboard still holds our text. |
| `both` | Same, without the restore. |
| `clipboard` | Copy only. |

**When the text stays on the clipboard instead of being restored:**

- No text field in focus (desktop, taskbar, Dictate's own windows; always on Wayland): copied, not pasted.
- The paste keystroke was blocked (an elevated window, the secure desktop).
- The target cannot be confirmed to take text. Windows confirms by a caret, or trusts Chromium, Firefox and terminal windows, which never show a Win32 caret. macOS confirms by the focused element's Accessibility role (text field, text area, combo box, search field). X11 never confirms, so text always stays copied there.

If the clipboard cannot be read in full, or cannot be written, the text is typed as key events instead, leaving the clipboard alone (X11 types ASCII only). Before pasting, the sink waits up to 1 s for held modifiers to be released. "press enter" sends Enter only after a confirmed paste.

**Privacy formats** ([src/native/platform.ts](../../src/native/platform.ts) `writeClipboardText`). Windows writes `CanUploadToCloudClipboard = 0` on every write, and for paste-and-restore text also `CanIncludeInClipboardHistory = 0` and `ExcludeClipboardContentFromMonitorProcessing` ([src/native/win32.ts](../../src/native/win32.ts)). macOS marks text `ConcealedType`, plus `TransientType` for paste-and-restore. Linux writes plain text.

## The history picker

[src/main/picker.ts](../../src/main/picker.ts) `PickerController` owns the lifecycle; [src/renderer/picker.ts](../../src/renderer/picker.ts) renders search, pin, delete, paste and raw view. It opens from the picker combo, the tray or Settings, placed under the caret when the app reports one, else at the mouse ([src/main/windows.ts](../../src/main/windows.ts) `placePicker`).

- **Windows.** The window never takes focus. The hook captures keys and main forwards them as `dictate:picker-key`. It closes on Alt/Win combos, a click outside (mouse hook), or when the foreground window changes (checked every 200 ms). Every close path turns key capture off first.
- **macOS and Linux.** The window takes focus and handles keys itself; it closes on blur. Before pasting, main re-activates the original app and waits up to about 500 ms for it to be in front ([src/main/focus.ts](../../src/main/focus.ts)); if that fails, the entry is copied instead.

A pick goes through the same sink as a dictation ([src/main/pick.ts](../../src/main/pick.ts)): pasted with a trailing space, or copied exactly.
