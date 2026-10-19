# Decisions and measurements

Why open-dictate is the way it is. Each entry says what was decided, why, and what would make us revisit it.

## Measurements

### The speed check (picks the default cleanup)

After the first download, the app times one cold and three warm cleanups of a bundled 5-second sample ([defaults/hardware-sample.txt](../../defaults/hardware-sample.txt)) and uses the warm median. Measured with the production code (`test/hardware.integration.test.ts`, `qa/first-run.mjs`), 2026-10-18:

| Computer | llama.cpp backend | Emberon | Gemma → Emberon | Chosen |
| --- | --- | --- | --- | --- |
| Ryzen AI Max+ 395, Radeon 8060S | Vulkan | 87 ms | 588 ms | Gemma → Emberon |
| Same, Vulkan hidden | CPU | 165 ms | 1,337 ms | Emberon only |
| Apple M1 Pro, 32 GB | Metal | 59 ms alone; 192 ms with Gemma loaded | 657 ms | Gemma → Emberon |

The Windows download is llama.cpp's portable CPU build, so most Windows PCs measure **Emberon only**. Gemma (3.1 GB) is offered when the computer has a 4 GB GPU or 16 GB of RAM, and used only if it measures under 1 s.

### Dictation speed

| What | Measured |
| --- | --- |
| Key release to text, Emberon, M1 Pro (Metal), the 14 s fixture | 244–254 ms |
| Recognizer flush after release | 76–130 ms |
| Cleanup, Gemma → Emberon, the 14 s fixture, Radeon 8060S (Vulkan) | 791–856 ms |
| Idle CPU, models loaded, nothing polling | about 0.6% of one core (Windows laptop) |

### First-run download

The essentials are about 0.68 GB (speech model 464 MB, Emberon 200 MB, llama.cpp 12–20 MB). On the M1 Pro over home Wi-Fi it downloaded at a median 8.8 MB/s and installed in about a minute; a download cut at 30% resumed from the same byte.

## Model choices

| Model | Why | Licence |
| --- | --- | --- |
| Nemotron Speech Streaming 0.6B, int8, 1120 ms chunks (sherpa-onnx) | Streams words while you talk, runs on a CPU, English. | NVIDIA Open Model License |
| Emberon-2 Q4_K_M | 350M parameters, 200 MB, fast on a CPU: punctuation, fillers, polish. | LFM Open License v1.0 |
| Gemma 4 E2B Q4_K_M | Better with names from your vocabulary; needs a GPU or a fast computer. Optional. | Apache-2.0 |
| llama.cpp b11700 | Runs the cleanup models. The portable CPU build covers every PC; a custom Vulkan or CUDA build can be pointed at in Advanced. | MIT |

Models are never bundled: the app downloads them from their official sources on first run, checks each file's pinned SHA-256, and shows every licence and required notice first ([THIRD_PARTY.md](../../THIRD_PARTY.md)). Other languages wait for a multilingual streaming model.

## Product decisions

- **Local only.** No dictation text, audio, history or vocabulary leaves the computer. The network is used only to download models and to check GitHub Releases for updates, and the update check can be turned off.
- **Cleanup never loses words.** Any step that fails, times out, rewrites too much or damages a vocabulary term keeps its input.
- **The default chain is measured, not guessed** (above).
- **Licences are shown, not clicked through.** One "Models and licences" step before the download lists each model's licence, source and size; the same list is in Settings → About.
- **Getting started can always be reopened** from Settings and the tray, and resumes where it was closed. Downloads run in the background, so only the practice dictation waits for them.
- **The practice box** takes a dictation only while Settings is in front, so a dictation into another app still goes there.
- **Auto-update installs only when idle** (on quit or after 10 minutes without dictating), never during a recording, cleanup or download.
- **No code signing**, for now. SmartScreen's "More info → Run anyway" is documented instead. Revisit if Smart App Control blocks installs, or the prompt stops people installing.
- **No silent learning.** Vocabulary is yours to edit; nothing is added without asking.
- **AGPL-3.0.** It keeps a free alternative from becoming a closed paid clone.
- **Nothing polls while idle.** Timers are one-shot; the mic opens only when you press the key (unless you ask Windows to keep it ready).
