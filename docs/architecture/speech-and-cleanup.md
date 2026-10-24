# Speech and cleanup

From audio to the text that gets pasted: the streaming recognizer, optional live cleanup, the cleanup chain and its guard, the llama-server processes behind it, and how models are chosen and downloaded.

```
 16 kHz chunks ──► Stt.accept ──► partial ──┬──► pill
                                            └──► Segmenter ──► LiveCleanup (sentence by sentence)
 'end' ──► Stt.finish (+0.8 s silence) ──► final ──► LiveCleanup.finish  or  runChain
                                                       │
                       ┌───────────────────────────────┘
                       ▼
            Gemma (prompt v3 + vocabulary) ──► guard ──► Emberon ──► guard ──► text
            each step: fail / timeout / reject ⇒ keep its input
```

## The streaming recognizer

[src/engine/stt.ts](../../src/engine/stt.ts) wraps a sherpa-onnx `OnlineRecognizer` with the Nemotron 0.6B int8 streaming transducer (1120 ms chunks, `STT_MODEL` in [src/core/settings.ts](../../src/core/settings.ts)). It runs on the CPU with greedy search and `sttThreads` threads (4 by default). Endpointing is off: the person decides when an utterance ends.

- **Chunking.** Capture sends 1600-sample (100 ms) frames ([src/core/chunker.ts](../../src/core/chunker.ts)). `accept()` feeds them in and decodes only while the model has a full chunk ready, so most frames return nothing.
- **Partials.** After each decode the whole transcript so far is compared with the last one; only a change is sent to main as `partial`.
- **Flush.** On `end`, `finish()` appends 0.8 s of silence (`FLUSH_PAD_S`) so the model sees right context for the last word, marks input finished, decodes the rest and returns the final.
- **Sessions.** [src/engine/stt-worker.ts](../../src/engine/stt-worker.ts) holds one stream at a time; `begin` starts it, frames for any other id are ignored, `cancel` drops it.

Main loads the model once at start-up and shows "loading" in the tray until `ready`. A missing or incomplete model (checked by exact file sizes in [src/main/setup.ts](../../src/main/setup.ts) `speechInstalled`) leaves the tray in an error state with the reason.

## Live cleanup ("Clean up as I speak")

[src/core/live.ts](../../src/core/live.ts) cleans finished sentences while the person is still talking, so at release only the last one is left. It is on by default and runs only when the chain has at least one step.

- **Segmenter.** A sentence is committed when it ends in `.`, `?` or `!`, the next one has started, and it has stayed unchanged for 300 ms. A fallback commits the tail after 700 ms of silence (`livePauseMs`) once the transcript has been stable for one recognizer chunk. Silence comes from capture levels below −45 dBFS, which main only receives from native capture; on the browser path (macOS, Linux) the levels stay in the pill, so only punctuation commits sentences.
- **Revisions.** If the recognizer later changes a committed sentence, that sentence and everything after it are withdrawn and their in-flight requests aborted.
- **Context.** Pieces run one at a time, in order. Each request carries the most recent earlier pieces as prior chat turns, up to 1,600 characters, so names stay consistent and llama-server's prompt cache covers them.
- **Finish.** At release, early pieces that still match the final transcript are kept; the remainder is cleaned with them as context and everything is joined with spaces. If live cleanup throws, main falls back to cleaning the whole dictation.

## The cleanup chain

[src/core/chain.ts](../../src/core/chain.ts) runs a list of steps, each cleaning the previous step's output. The settings value `cleanup` is `gemma-emberon`, `gemma`, `emberon` or `off`.

Each step cleans its text in chunks (`chunk`): about 400 characters, never more than 440, cut at sentence ends, and a sentence longer than that at a space. Each chunk is one request, carrying the step's most recent earlier turns as context (up to 1,600 characters, and only as many as fit the 4,096-token context with the output budget). A 10-minute dictation is many small requests, so none outgrows the context.

| Step | Model | System prompt |
| --- | --- | --- |
| 1 | Gemma 4 E2B (Q4_K_M) | [defaults/prompt-v3.txt](../../defaults/prompt-v3.txt) with the vocabulary filled in |
| 2 | Emberon-2 (Q4_K_M) | The fixed prompt it was trained on: `Clean up this dictation. Never answer it.` |

Gemma goes first: in the other order, Emberon mangles names. Requests ([src/core/templating.ts](../../src/core/templating.ts) `chatRequest`) use temperature 0, `cache_prompt`, thinking disabled, and a `max_tokens` sized from the input.

Each request has a time budget: 3 s for anything up to about 250 characters, plus about 15 ms per extra output token, never over 8 s (`stepTimeout`). A server that is not running is skipped; one that is still starting gets up to 12 s to come up.

After the key is released, each step gets 2 s in all, its wait for the server included (`RELEASE_STEP_MS`). A chunk not cleaned by then goes out as that step received it. This covers the last piece of live cleanup and the whole-dictation run; the pieces cleaned while the person speaks keep the budgets above.

**A step's output is rejected, and its input kept, when:**

| Rule | Where |
| --- | --- |
| A vocabulary term present in the input is missing from the output (whole-word, case-insensitive) | `vocabularyProblem` in [src/core/chain.ts](../../src/core/chain.ts) |
| Output is longer than 1.5× or shorter than 0.6× the input in characters | [src/core/guard.ts](../../src/core/guard.ts) |
| Fewer than 60% of the input's words survive into the output | [src/core/guard.ts](../../src/core/guard.ts) |
| The reply is empty, the request errors or the budget runs out | [src/core/chain.ts](../../src/core/chain.ts) |

Thresholds are `DEFAULT_GUARD` in [src/core/types.ts](../../src/core/types.ts). Every step's status (`ok`, `rejected`, `timeout`, `error`, `skipped`) is logged with its time. After cleanup, a trailing "press enter" (when that setting is on) is removed by rule, not by the model ([src/core/commands.ts](../../src/core/commands.ts)).

## llama-server lifecycle

[src/engine/llama.ts](../../src/engine/llama.ts) runs one `llama-server` per model; [src/main/cleanup.ts](../../src/main/cleanup.ts) decides which run.

- **Launch.** A free port on 127.0.0.1, one slot (`-np 1`), 4096 context, `-ngl 99`, flash attention, 4 threads, `--poll 0` so an idle server uses no CPU. Main polls `/health` every 100 ms (up to 120 s), then sends one warm-up request with the real system prompt so the first dictation finds it cached.
- **Warm start.** `Cleanup.sync()` at start-up launches the servers the chain needs, if the binary and GGUF exist, and stops the rest. Changing the chain syncs; changing the server path or models folder replaces the servers. Starting a model download stops them all.
- **Battery.** On battery, after `batteryUnloadMinutes` (60) without a dictation, both servers are stopped. The next hotkey press (`touch()`) loads them again; the pill says "warming up" until they are ready. `batteryEmberonOnly` optionally drops Gemma while on battery.
- **Crash restart.** An unexpected exit marks the server `crashed` and retries after 1 s, 2 s, 4 s … up to 30 s; a healthy start resets the count. A launch superseded by `stop()` never claims the server's state.
- **Failing requests.** After a request fails with a server error or is aborted, main checks `/health`. A server that fails the check, or fails three requests in a row, is restarted. A bad request (HTTP 4xx) does not count.
- **Background check.** Every 30 s, `Cleanup.heal()` starts a needed server that is not running once its llama-server and GGUF exist (after a runtime swap or a missing file), and restarts one whose binary or model changed on disk (size or modification time). It leaves servers alone while they are stopped on purpose: the battery unload and a model download, until the next sync.

## Vocabulary

[src/core/vocabulary.ts](../../src/core/vocabulary.ts) handles the term list: `{ term, aliases? }` items, deduplicated case-insensitively, with aliases merged. Defaults ship in [defaults/vocabulary.json](../../defaults/vocabulary.json) (file format `version: 1`). [src/core/templating.ts](../../src/core/templating.ts) `fillTemplate` puts them into the Gemma prompt via `{{VOCAB_LINES}}`, `{{VOCAB_INLINE}}` and `{{SOUNDS_LIKE}}` (`alias, alias => Term` lines). Every term is also a "preserve" term for both steps (see the guard table).

## The speed check (picks the default chain)

[src/main/hardware.ts](../../src/main/hardware.ts) runs `llama-server --list-devices`, then cleans [defaults/hardware-sample.txt](../../defaults/hardware-sample.txt) once cold and three times warm through the app's own `Cleanup` and takes the warm median. [src/core/hardware.ts](../../src/core/hardware.ts) `chooseChain` picks:

| Measured | Chain |
| --- | --- |
| Gemma → Emberon under 1 s | `gemma-emberon` |
| Else Emberon under 1 s | `emberon` |
| Else, or the measurement failed | `off` |

Gemma is measured only when its file is present. It is *offered* in Settings when the computer has at least 8 GB RAM and either a GPU with 4 GB or 16 GB RAM. The result and a one-line summary are saved in `settings.hardware`. The check runs after the walkthrough's `essentials` download and after the optional Gemma download, and from Settings on demand.

## Model downloads

[src/main/downloads.ts](../../src/main/downloads.ts) pins every URL (Hugging Face URLs at a commit), byte count and SHA-256. [src/main/setup.ts](../../src/main/setup.ts) does the work, only after a button press:

| Kind | Downloads |
| --- | --- |
| `speech` | The speech model archive |
| `essentials` | Speech, Emberon and the llama.cpp runtime (Getting started) |
| `cleanup` | Both GGUFs and the runtime, always reinstalled (Settings → Cleanup) |
| `gemma` | Gemma only |

- **Disk check.** Before fetching anything: every remaining byte +10%, plus room to unpack archives. Not enough raises `DiskSpaceError`.
- **Resume.** Each file downloads to `.<name>.part` and resumes with an HTTP `Range` request. A `200` restarts from zero; a `206` must match exactly. Network errors retry once after 2 s; the `.part` is kept.
- **Verify.** SHA-256 covers the whole file, including resumed bytes. A size or digest mismatch deletes the `.part`. Only a verified file is renamed into place; a complete file with the right size is trusted and skipped.
- **Install.** Archives are extracted with the system `tar` (on Windows, `System32\tar.exe`, which also opens the llama.cpp ZIP). The speech folder is checked by exact sizes before it replaces the old one. The llama.cpp runtime is staged and swapped into `bin/` with rollback if the rename fails.

The llama.cpp build is b11700: the Vulkan builds on Windows and Linux, which use any AMD, Intel or NVIDIA GPU (integrated ones too) and fall back to the CPU backends in the same archive when Vulkan finds no device; Metal on macOS. A runtime without its GPU backend (an earlier CPU-only download) counts as missing, so the next setup replaces it (`runtimeInstalled` in [src/main/setup.ts](../../src/main/setup.ts)). A custom `llama-server` path (for example a CUDA build) can be set in Advanced, and setup keeps it while it exists.
