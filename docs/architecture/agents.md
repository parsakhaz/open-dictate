# Coding agents and the pill

Coding agents reach the person through Dictate's pill. A card says where it came from and what the agent needs. The person can open that Pane tab, click an answer, or hold the dictation key over the card and answer by voice. The person can also reach the agents: holding the agent key, or on Windows the point key, sends what they say to a Pane "Voice" orchestrator ([Talk to agents](#talk-to-agents), [Point and say](#point-and-say-windows)). Two things raise cards:

- **The agents themselves,** through eleven MCP tools:
  - `notify` and `ask`: a message, or a question with up to four choices.
  - `decide` and `approve`: several related questions in one card, or a plan to approve ([below](#decide-and-approve)).
  - `lineup`: options the agent made, for the person to pick from ([below](#lineup)).
  - `peek`: a local page or report the person can point at and talk about ([below](#peek)).
  - `status` and `card_status`: whether Dictate is free, and where a card is now ([below](#the-inbox-held-snoozed-and-the-round)).
  - `propose_vocabulary`, `list_vocabulary` and `read_history`.
- **Pane, only when the person turns it on.** With Settings → Agents → "Show Pane's agent alerts on the pill" on, Dictate follows Pane through its published CLI, `runpane`, and a tab that is blocked or finished becomes a card with no change to the agent. It is off by default, also for profiles from before 0.1.2: these generic cards competed with Pane's own notifications and say less than an agent's own `notify` ([#9](https://github.com/parsakhaz/open-dictate/issues/9)). Off, no watch runs, so Pane sees no consumer and keeps its own notifications.

The server instructions and the description of every tool that raises a card carry the maintainer's rule for writing a card, with good and bad examples ([src/core/agenttools.ts](../../src/core/agenttools.ts)): say what the work is for, what just happened and what you need, in plain words and plain text, and leave out where you are. The Markdown subset the pill renders (below) is for agents that don't follow it.

```
 agent (Claude Code, Codex, Cursor, …)
   │ MCP over stdio
   ▼
 dictate-mcp.js  ── the bridge: <data>/agents/, run by Dictate's executable as Node
   │ JSON lines over a named pipe (Windows) or a 0700 Unix socket, after a token
   ▼
 AgentServer ──► AgentHub ──► CardQueue ──► pill (cards)          src/main/agentserver.ts, src/core/agenthub.ts, src/core/cards.ts
                    ▲              │
                    │              └──► sheet window (decide, lineup, peek, round)   src/main/sheet.ts
 runpane watch ─────┘  (PaneLink: names, last reply, open, send)  src/main/panelink.ts, src/core/panewatch.ts

 agent key, point key ──► VoiceOrchestrator ──(PaneLink send)──► the "Voice" Session's chat   src/main/voiceorch.ts
```

The six tools from before 0.2.0 (`notify`, `ask`, `status`, `propose_vocabulary`, `list_vocabulary` and `read_history`) are defined in [src/core/agenttools.ts](../../src/core/agenttools.ts). Each newer one lives in its own module under [src/core/tools/](../../src/core/tools/) and its behaviour in one feature module under [src/main/features/](../../src/main/features/). [src/core/tools/index.ts](../../src/core/tools/index.ts) is the list the bridge returns from `tools/list` and the hub dispatches. Every result of a tool that raises a card carries its `card_id`.

## The bridge and the channel

[src/bridge/dictate-mcp.ts](../../src/bridge/dictate-mcp.ts) is bundled by [build.mjs](../../build.mjs) into one file, `out/bridge/dictate-mcp.js`. At start-up [src/main/agents.ts](../../src/main/agents.ts) copies it into `<data>/agents/`, so agent configs point at a path that survives updates and AppImage remounts. Agents run it as `Dictate.exe <data>/agents/dictate-mcp.js` with `ELECTRON_RUN_AS_NODE=1`.

The bridge implements MCP's stdio transport by hand: `initialize`, `tools/list`, `tools/call`, `ping` and cancellation. There is no SDK dependency. It always lists its tools. When the app isn't running, each call answers "Dictate isn't running", so the agent carries on in text and never hangs.

The channel is local only: a named pipe derived from the data folder on Windows, or `agents.sock` in a `0700` folder elsewhere. The app writes `channel.json` beside the bridge, holding the pipe's path and a fresh 32-byte token. A connection that doesn't present the token in its first line is dropped. Each connection is one **agent session**. With it, the bridge sends the `PANE_SESSION_ID` and `PANE_PANEL_ID` from its environment, its working folder, and the client name from the MCP handshake. Agents never pass these themselves.

Honest limit: other processes running as the same user can read the token. The real gate for history is the person's consent on the pill.

## Cards

[src/core/cards.ts](../../src/core/cards.ts) holds the rules, with no Electron:

- One card per tab (`tab:<panelId>`), or per agent session outside Pane.
- Ranking: point and say's review card first, then consent, then "needs you", then info; oldest first within each, with "+N" for the rest.
- "Finished" never replaces a card that needs the person, or an agent's own note.
- An agent's `notify` followed by its tab becoming blocked stays one card. It keeps the agent's title and offers Reply.
- The log has one line per card raised, answered, dismissed, snoozed, expired or cancelled, with its id, kind and source, and never its words. A round's line says what started it: a click, the shortcut or the summary. Agent connections are logged only when a call fails.
- Nothing new appears while the person is busy (see [the inbox](#the-inbox-held-snoozed-and-the-round)). The card being answered by voice is the exception: it stays up through the whole reply, marked "Replying by voice…".
- Paused alerts hold everything. `notify` returns `dnd`, and unpausing drops the info cards.
- Info cards fade after about 4.5 s on screen. The timer waits while the pointer is over the cards, and when it leaves the card stays at least 2 s more. The vocabulary review is info, but it stays until it is reviewed or dismissed, also after the agent disconnects.

On the pill ([src/renderer/cards.ts](../../src/renderer/cards.ts)) the top card shows its source, its whole title and its message; pointing at it adds the buttons. Its body eases to each new height (no motion with reduced motion) and scrolls past 236 px. The pill window is click-through. While a card is up, main polls the pointer against the card's rectangle and takes clicks only over it. On Windows a click-through window gets no pointer moves, so the page can't detect the hover itself ([#9](https://github.com/parsakhaz/open-dictate/issues/9)).

The **source line** is always Dictate's own words. In Pane it is "<Pane name> · <tab>", looked up through runpane from the session's ids. Outside Pane it is "<client> · <folder>". Agent text is untrusted: [src/core/agenttext.ts](../../src/core/agenttext.ts) strips escape codes, control and bidi characters and tags, and applies the caps. Links must be https and open only on a click. A message keeps its line breaks, and tags stay as their characters. On the pill ([src/core/cardtext.ts](../../src/core/cardtext.ts)) a title loses every Markdown mark. A message keeps **bold**, *italic* and `inline code`, built as DOM elements holding text nodes and never as HTML. Headings and list markers become plain lines, and a link becomes its text.

### The inbox: held, snoozed and the round

[src/core/cards.ts](../../src/core/cards.ts) and [src/core/flowguard.ts](../../src/core/flowguard.ts) hold the rules, [src/main/features/inbox.ts](../../src/main/features/inbox.ts) the wiring.

- **Held for focus.** A new card waits while the person dictates, typed in the last 6 s, or Windows reports them busy (full screen or presenting, through `SHQueryUserNotificationState` in [src/native/win32.ts](../../src/native/win32.ts)). Only key-down times are kept, never which key. macOS and Linux have no busy probe yet. The pill shows a quiet "3 waiting" capsule with no chime, or "Held while you talk · 2" while dictating. A card already on screen stays when typing starts.
- **What the agent sees.** `notify` returns `held` instead of `queued`. `status` adds `focus` (`free`, `dictating` or `focused`) and `waiting`. Time a card spent held before it was first seen, and time it spent snoozed, doesn't count against a waiting call's `timeout_s`, up to 600 s from the call; Codex allows 660 s, so the call always returns first.
- **Snooze.** Every expanded card except consent has a 3m · 5m · 10m row. Ctrl+Alt+Z snoozes the top card for 3 min, and pressing it again while the toast shows steps to 5, then 10. That key is taken only while a card, the toast or a round is up, so other apps get it the rest of the time. "1 snoozed" opens the shelf with countdown rings, Now and ✕. A card comes back tagged "Back from snooze", on top or quietly into the inbox. Settings → Agents → **Inbox and snooze** sets the round key, the snooze key, one to three lengths and where cards return.
- **A snoozed `ask`.** If a snooze outlasts the 600 s ceiling, `ask` returns at once with `{answered:false, reason:"snoozed", until, card_id}` and the card stays. A later answer goes to its Pane tab as a message, or outside Pane waits in `card_status`.
- **`card_status({card_id})`** answers `held`, `shown`, `snoozed` (with `until`), `answered` (with `answer`), `dismissed`, `expired`, `cancelled` or `gone`, and `unknown` for an id it never saw.
- **The round.** Ctrl+Alt+Space, or a click on "3 waiting", opens the waiting cards one at a time in the sheet window, right above the pill, 480 px wide with nothing dimmed. Each chip names the card's Pane tab, the session a remote agent named in its origin, or the agent. Keys: 1–4 choose, Enter does what its button names, S snoozes, → skips, Esc leaves and gives focus back. Enter and "approve" never pick a choice the person didn't see named:
  - A question with one choice names it on the button, and Enter sends it. With two or more, Enter does nothing and the round says "Pick 1–4".
  - A decision shows every question with its choices. 1–4 pick for the first question without a pick, a click picks any, and Enter sends once every question has a pick. Spoken words fill what they match, and send the decision once every question has a pick, as on its card.
  - An approval shows its plan, and Enter or "approve" goes through the approve handler. On a high-risk plan only Enter approves. Other words are the changes asked for.

  The round never records on its own. Holding the dictation key records one utterance for the current card: on release, a whole utterance of "approve", "next", "skip", "open", "snooze ten" or a number is a command, and anything else is the answer. The round then shows the next card and waits for a key. The round ends with a summary: each card's question and the answer sent, and Undo. The summary stays 8 s, longer while the pointer is on it. An answer is held back until the next action or until the summary goes, so Undo really takes it back.

## The sheet window

The pill window is click-through and never takes focus, so the bigger surfaces share one more window: [src/main/sheet.ts](../../src/main/sheet.ts), a frameless window right above the pill with the cards' material. It shows one surface at a time, with a page per kind under [src/renderer/sheet/](../../src/renderer/sheet/): the decision sheet, the lineup grid, the docked peek and the round. It opens without focus when it only shows something, and takes focus when keys must reach it (a round, a lineup, a region to confirm). Esc closes it and leaves its card on the pill.

## Decide and approve

[src/core/tools/decide.ts](../../src/core/tools/decide.ts), [src/core/tools/approve.ts](../../src/core/tools/approve.ts) and [src/main/features/decide.ts](../../src/main/features/decide.ts).

- **`decide`** asks one to four questions, each with two to four options, in one grown card. The person clicks chips, or holds the key over the card and says it in one sentence ("staging, and once then email"). [src/core/decidematch.ts](../../src/core/decidematch.ts) maps the sentence onto the questions in order by labels, ordinals, numbers and yes or no. It is deterministic, no model, and `raw` always comes back. Words that match nothing go to the first open question's "Other". A sentence that answers everything sends after the usual 2 s preview; a partial one waits for Send, and blank questions come back with `picked: []`. On a timeout or dismissal the result carries `partial`.
- **Expanded.** Expand on the card opens it in the sheet, 760 px wide and as tall as its questions: every question with its options as numbered tiles and their descriptions. A click, a number key (for the highlighted question, ↑ ↓ to move) or voice over the sheet answers, and Enter sends. Expand is remembered in `settings.decide.expanded`: later decision cards open expanded, without focus, also after a restart. Until the person clicks such a sheet, its keys reach the app in front, so its foot says "Click to use keys" in place of the key hint. Shrink goes back to the compact card and turns it off; Esc or ✕ shrinks only that card. A card with previews always opens its comparison, and there Expand and Shrink affect only that card.
- **Previews.** When an option has a text or code preview, the sheet opens with question tabs, the options on the left and the hovered option's preview on the right. Hovering changes only the preview; a click, a number or voice changes the answer.
- **One surface.** The sheet shows a decision card only while it is the pill's top card, and the pill draws no card meanwhile. When another card takes the top, the sheet closes and that card shows on the pill.
- **`approve`** shows a plan in up to six lines with Approve. A spoken change shows for 2 s and returns `{approved:false, changes, raw}`. With `risk: "high"`, only a click approves.

## Lineup

[src/core/tools/lineup.ts](../../src/core/tools/lineup.ts), [src/main/features/lineup.ts](../../src/main/features/lineup.ts) and [src/main/features/lineupimages.ts](../../src/main/features/lineupimages.ts).

`lineup` shows two to six candidates, each an image file or a short text. `pick` is `many` (favourites, the default), `one` or `rank`. The card shows a strip of numbered thumbnails; the sheet shows the grid, where 1–6 or a click star candidates in order and Enter sends, and a lightbox for full size (H hearts, arrows page through). Said aloud, "two and four, two first, make the button bigger" gives picks in that order and the rest of the words as `comment`. Picks come back as the agent's own ids, in order; "None of these" returns `picks: []` with `none: true`.

Images are read by main, never by a page. A path must resolve, after links, inside the session's working folder or the system temp folder. The type is checked from the file's bytes (PNG, JPEG, WebP, GIF or SVG), at most 10 MB each. URLs aren't accepted yet. An SVG is only ever drawn as an image, so its scripts never run.

## Peek

[src/core/tools/peek.ts](../../src/core/tools/peek.ts), [src/main/features/peek.ts](../../src/main/features/peek.ts) and [src/main/features/peekview.ts](../../src/main/features/peekview.ts). This is the one place Dictate shows pages it didn't write.

`peek` shows a page: http(s) on localhost (any port), an `.html` file inside the agent's working folder, or an https host from Settings → Agents → **Peek** (a host covers its subdomains; the default list is `rungrain.com`). It arrives as a card with a live thumbnail. **Peek** docks it at 760 × 480 above the pill without taking focus. Holding the dictation key over the docked page outlines the element under the pointer, and the agent gets the words, the element's selector, role, text and box, the URL, and a PNG crop path. Holding and dragging marks a region, which waits in a confirm strip until Enter. With `wait: false` the call returns at once and the words go later to the agent's Pane tab. `keep_open` leaves the page docked for the agent's next look.

| Rule | How |
| --- | --- |
| Only allowed pages | No `file://`, no plain http to other computers, no paths outside the folder. Only the person adds hosts. |
| Local files stay in their folder | A `dictate-peek://` protocol serves only that folder, under a random host name, and resolves links before checking. |
| No leaving the page | Another origin is held at a "This page wants to go to … · Allow once · Stay" strip. `window.open` is denied. |
| No powers | Sandboxed, context-isolated, no Node, no devtools. Every permission is denied, downloads are cancelled and form posts stopped. |
| Its own cookies | A persistent session of its own (`persist:peek`), so a Grain sign-in lasts and the default session never sees these pages. Settings clears it with **Forget peek sign-ins**. |
| Pointing out of the page's reach | The outline runs in an isolated world in a closed shadow root. The agent gets selector, role, text and box, never HTML. |

The crop is returned as a file path, not yet as an MCP image block.

## Captures

Peek's crops and point and say's screenshots go to `<data>/agents/captures/`. A capture is taken only while the person holds a key over something. Each feature deletes its own files older than 24 h at start-up; point and say also hourly, and when a press is cancelled or gets no words.

## Pane

[src/main/panelink.ts](../../src/main/panelink.ts) only ever runs the `runpane` CLI, never Pane's daemon socket. On Windows it reads the `runpane.cmd` shim and runs Pane's own executable with the bundled script, so a dictated reply never passes through `cmd.exe`.

The watch runs only while "Show Pane's agent alerts on the pill" is on; turning it off stops the watch and drops the cards it made. It is `runpane watch --follow --as dictate --from now --json`. It covers blocked, ready, busy, report, exit and gone. Blocked settles after 5 s and ready after 10 s, with no batching. Lines from the start-up snapshot, or from before the watch attached, are skipped, so a restart never replays old events as cards. While Pane is away, the watch restarts with backoff of at most a minute.

| Event | Card |
| --- | --- |
| `agent.blocked` | "Needs your input", with the agent's last reply (`panels last-message`) |
| `agent.report`, blocked | the report's question as the title, its summary as the message |
| `agent.ready` | "Finished", only while Pane isn't the app in front |
| `agent.busy`, `panel.exited` | the tab's Pane card goes |

A Pane Session's own orchestrator chat sits in a hidden owner pane (Pane's word for a workspace of tabs) that `panes list` doesn't show, so Dictate also looks panels up in `runpane sessions list`, and a card from one reads "Session · <name>".

Clicking a card runs `runpane links open pane://open?pane=…&panel=… --yes`. On Windows Dictate first calls `AllowSetForegroundWindow`, so Pane can come to the front. Replies use `runpane agents send --panel … --yes`.

## Voice reply

If the pointer is over the top card, an expanded decision sheet or a docked peek at key-down, or "Hold to reply" was clicked, that one dictation goes to the card instead of being pasted. "Hold to reply" lasts one dictation: the next press uses it up, whichever card it answers. Speech, cleanup and history run as usual. While the key is held, the line above the pill says "Answering: <card title>", then the pill previews the cleaned text for 2 s, which Esc cancels. Then the text goes to the tab, or back to the waiting `ask`. A spoken answer that names exactly one of the choices returns that choice. If the reply can't be delivered, Dictate opens the tab and leaves the text on the clipboard.

## Talk to agents

[src/main/voiceorch.ts](../../src/main/voiceorch.ts), [src/main/features/voice.ts](../../src/main/features/voice.ts) and [src/core/voicesession.ts](../../src/core/voicesession.ts).

Holding the **agent key** (Ctrl+Win by default; never Right Ctrl, the dictation key) records as usual, but the pill shows the accent colour and "To orchestrator…", and nothing is pasted. After the 2 s preview ("Sending to orchestrator in 2 s · Esc cancels") the words go to one dedicated Pane Session named **Voice**, prefixed `[Dictate · voice]`. Its orchestrator routes them to the right tab and answers on the pill with `notify`, or `ask` when unsure. Dictate never routes between agents itself.

- **The Session.** Dictate uses the id saved in settings, else a Session named "Voice", else creates one with `runpane sessions create`, whose goal and profile tell it to route and answer through Dictate. An archived Session doesn't count. A stopped chat is resumed with `panels resume --wait-ready` first; meanwhile the pill says "Starting the Voice orchestrator…".
- **The draft guard.** If the orchestrator's composer already holds text, nothing is sent and a "Voice has a draft" card quotes the words, with Open, Try again and Hold to reply.
- **Delivery.** `runpane agents send --panel …`. Messages past 2000 characters go as a file pointer, which Pane writes to a file and the agent reads. Sends run one at a time, so two quick ones create one Session and arrive in order.
- **Without Pane** the key isn't bound, so other apps still get it, and Dictate checks for Pane again every 30 s.
- Settings → Agents → **Talk to agents** rebinds or turns off the key and shows the Session. **Start over** forgets only the saved id; the Session stays in Pane.

## Point and say (Windows)

[src/main/features/point.ts](../../src/main/features/point.ts), [src/main/features/pointhelper.ts](../../src/main/features/pointhelper.ts), [src/main/features/pointglow.ts](../../src/main/features/pointglow.ts) and [src/core/pointsay.ts](../../src/core/pointsay.ts).

Holding the **point key** over anything on screen and speaking sends the Voice orchestrator a crop of what was under the pointer, the text Dictate could read there, and the words. The point key is unset until the person picks one in Settings → Agents → **Point and say**, so nothing captures by accident. It is Windows only; elsewhere the feature isn't registered and the section says so.

- **The helper.** [src/native/pointhelper/pointhelper.ps1](../../src/native/pointhelper/pointhelper.ps1) is a separate PowerShell process hosting .NET UI Automation, so COM crashes and slow accessibility trees stay out of Dictate. It answers one JSON line per request with the element's name, role, rectangle and text, its process and window. It ships in `resources/pointhelper/`, unsigned, and starts with the app only when a point key is set.
- **While the key is down,** an edge glow, a "Capturing" capsule and an outline tagged "Role · name" show, and nothing else. Holding the left button and dragging marks a region instead. Elevated windows can't be read, so the target falls back to the area around the pointer with no text.
- **On release** the crop is taken with Dictate's own windows content-protected, so they never appear in it. The text goes through `redact()` from [src/core/historyaccess.ts](../../src/core/historyaccess.ts), keeping a key's prefix (`sk-live-••••••`).
- **The review card always shows,** above every other card and at once, also while new cards are held: the crop, the masked text, "You said …" and the target. It sends after 3 s on screen, pausing while pointed at, or waits for Send if Settings says so. Enter sends; Esc, ✕ or Cancel cancel and delete the crop. Dictate takes Enter and Esc from other apps only while that countdown runs on screen.
- **Excluded apps.** Over a program on the never-capture list (by default 1Password, Bitwarden, KeePass and KeePassXC) the key does nothing. If the app under the pointer can't be identified, nothing is captured either.
- Delivery uses the same send as the agent key, prefixed `[Dictate · point]`; text past 1,200 characters goes as a file pointer.

## History, with consent

`read_history` is off until the person turns on Settings → Agents → "Let agents read my dictation history". Each request then shows a consent card with three answers:

- **Allow once.**
- **Allow for this session.** This lasts as long as that agent's connection, at most 8 h. It is held in memory only and lost on restart.
- **Deny.** Sixty seconds without an answer counts as a deny.

Reads use the history search and the clamps: 20 entries and 7 days at most. They are redacted by [src/core/historyaccess.ts](../../src/core/historyaccess.ts) and wrapped as data. Every read, refused or not, goes to `<data>/agents/access-log.json` (the last 100) and to the log file, never with the text.

## Registration

[src/main/registration.ts](../../src/main/registration.ts) writes the person's user-level configs for Claude Code, Codex and Cursor on each launch of a packaged build:

- **Claude Code:** only through `claude mcp add`.
- **Codex:** `config.toml` is edited as text and parsed again before it is written. The entry passes `env_vars` for the Pane ids, which Codex otherwise strips, and sets `tool_timeout_sec = 660` for `ask`.
- **Cursor:** `mcp.json`.

Dictate's entries carry `DICTATE_MCP=1`. A `dictate` entry without that marker is the person's own and is never touched. Turning "Let coding agents use Dictate" off removes only Dictate's entries. Other agents get "Copy setup" snippets on the Agents page.

### Instructions

[src/main/instructions.ts](../../src/main/instructions.ts) also keeps a short note in each found agent's user-level instruction file, never a project's: `$CLAUDE_CONFIG_DIR/CLAUDE.md` (else `~/.claude/CLAUDE.md`) and `$CODEX_HOME/AGENTS.md` (else `~/.codex/AGENTS.md`). A `CODEX_HOME` inside a `.cache` folder or the `TEMP`, `TMP` or `TMPDIR` folder is a temporary one that an agent's shell passed down when it launched Dictate, so the note and the Codex registration go to `~/.codex` instead. [src/core/instructions.ts](../../src/core/instructions.ts) holds the text. It says when to use `notify` (`needs_you`), `ask` and `info`, and when `decide`, `approve`, `lineup` or `peek` fits better. It says that `held` or `snoozed` isn't an answer, and `card_status` follows up. Last comes the plain-words rule. The full examples stay in the MCP tool descriptions.

- The note sits between `<!-- dictate:begin (managed by Dictate; edits are replaced) -->` and `<!-- dictate:end -->`. It is appended to the end of the file, which is created when missing, and replaced in place afterwards. Nothing outside the markers changes: line endings (LF or CRLF) and an existing byte order mark are kept, and none is added.
- A launch writes only when the note changed. Writes go to a temporary file that is renamed over the original.
- Turning the setting off removes the note and the blank line that set it apart, giving back the file as it was. A file that held only the note is deleted.
- A file that isn't UTF-8, has unpaired markers or is read-only is skipped and logged.
- Settings → Agents shows each file under its agent and whether it holds the note.
- The Windows uninstaller runs `Dictate.exe --remove-agent-setup`, which removes Dictate's MCP entries and notes, then quits. Updates skip it. macOS and Linux have no uninstall hook: turn the setting off before removing the app.

QA and tests never write real configs. Set `DICTATE_AGENT_HOME` to a temporary folder and registration and the notes use it as `HOME`, `CODEX_HOME` and `CLAUDE_CONFIG_DIR`. Development builds, smoke tests and `DICTATE_QA_CONTROL` runs skip registration otherwise.
