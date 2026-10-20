# Coding agents and the pill

Coding agents reach the person through Dictate's pill. A card says where it came from and what the agent needs. The person can open that Pane tab, click an answer, or hold the dictation key over the card and answer by voice. Two things raise cards:

- **Pane.** Dictate follows Pane through its published CLI, `runpane`. A tab that is blocked or finished becomes a card with no change to the agent.
- **The agents themselves,** through six MCP tools: `notify`, `ask`, `status`, `propose_vocabulary`, `list_vocabulary` and `read_history`.

```
 agent (Claude Code, Codex, Cursor, …)
   │ MCP over stdio
   ▼
 dictate-mcp.js  ── the bridge: <data>/agents/, run by Dictate's executable as Node
   │ JSON lines over a named pipe (Windows) or a 0700 Unix socket, after a token
   ▼
 AgentServer ──► AgentHub ──► CardQueue ──► pill (cards)          src/main/agentserver.ts, src/core/agenthub.ts, src/core/cards.ts
                    ▲
 runpane watch ─────┘  (PaneLink: names, last reply, open, send)  src/main/panelink.ts, src/core/panewatch.ts
```

## The bridge and the channel

[src/bridge/dictate-mcp.ts](../../src/bridge/dictate-mcp.ts) is bundled by [build.mjs](../../build.mjs) into one file, `out/bridge/dictate-mcp.js`. At start-up [src/main/agents.ts](../../src/main/agents.ts) copies it into `<data>/agents/`, so agent configs point at a path that survives updates and AppImage remounts. Agents run it as `Dictate.exe <data>/agents/dictate-mcp.js` with `ELECTRON_RUN_AS_NODE=1`.

The bridge implements MCP's stdio transport by hand: `initialize`, `tools/list`, `tools/call`, `ping` and cancellation. There is no SDK dependency. It always lists its tools. When the app isn't running, each call answers "Dictate isn't running", so the agent carries on in text and never hangs.

The channel is local only: a named pipe derived from the data folder on Windows, or `agents.sock` in a `0700` folder elsewhere. The app writes `channel.json` beside the bridge, holding the pipe's path and a fresh 32-byte token. A connection that doesn't present the token in its first line is dropped. Each connection is one **agent session**. With it, the bridge sends the `PANE_SESSION_ID` and `PANE_PANEL_ID` from its environment, its working folder, and the client name from the MCP handshake. Agents never pass these themselves.

Honest limit: other processes running as the same user can read the token. The real gate for history is the person's consent on the pill.

## Cards

[src/core/cards.ts](../../src/core/cards.ts) holds the rules, with no Electron:

- One card per tab (`tab:<panelId>`), or per agent session outside Pane.
- Ranking: consent first, then "needs you", then info; oldest first within each, with "+N" for the rest.
- "Finished" never replaces a card that needs the person, or an agent's own note.
- An agent's `notify` followed by its tab becoming blocked stays one card. It keeps the agent's title and offers Reply.
- Nothing new appears while the person dictates. A held card shows a second after the text goes out. The card being answered by voice is the exception: it stays up through the whole reply, marked "Replying by voice…".
- Paused alerts hold everything. `notify` returns `dnd`, and unpausing drops the info cards.
- Info cards fade after about 4.5 s on screen. The timer waits while the pointer is over the cards, and when it leaves the card stays at least 2 s more. The vocabulary review is info, but it stays until it is reviewed or dismissed, also after the agent disconnects.

On the pill ([src/renderer/cards.ts](../../src/renderer/cards.ts)) the top card shows its source, its whole title and its message; pointing at it adds the buttons. Its body eases to each new height (no motion with reduced motion) and scrolls past 236 px. The pill window is click-through. While a card is up, main polls the pointer against the card's rectangle and takes clicks only over it. On Windows a click-through window gets no pointer moves, so the page can't detect the hover itself ([#9](https://github.com/parsakhaz/open-dictate/issues/9)).

The **source line** is always Dictate's own words. In Pane it is "<Pane name> · <tab>", looked up through runpane from the session's ids. Outside Pane it is "<client> · <folder>". Agent text is untrusted: [src/core/agenttext.ts](../../src/core/agenttext.ts) strips escape codes, control and bidi characters and tags, and applies the caps. Links must be https and open only on a click. A message keeps its line breaks, and tags stay as their characters. On the pill ([src/core/cardtext.ts](../../src/core/cardtext.ts)) a title loses every Markdown mark. A message keeps **bold**, *italic* and `inline code`, built as DOM elements holding text nodes and never as HTML. Headings and list markers become plain lines, and a link becomes its text.

## Pane

[src/main/panelink.ts](../../src/main/panelink.ts) only ever runs the `runpane` CLI, never Pane's daemon socket. On Windows it reads the `runpane.cmd` shim and runs Pane's own executable with the bundled script, so a dictated reply never passes through `cmd.exe`.

The watch is `runpane watch --follow --as dictate --from now --json`. It covers blocked, ready, busy, report, exit and gone. Blocked settles after 5 s and ready after 10 s, with no batching. Lines from the start-up snapshot, or from before the watch attached, are skipped, so a restart never replays old events as cards. While Pane is away, the watch restarts with backoff of at most a minute.

| Event | Card |
| --- | --- |
| `agent.blocked` | "Needs your input", with the agent's last reply (`panels last-message`) |
| `agent.report`, blocked | the report's question as the title, its summary as the message |
| `agent.ready` | "Finished", only while Pane isn't the app in front |
| `agent.busy`, `panel.exited` | the tab's Pane card goes |

Clicking a card runs `runpane links open pane://open?pane=…&panel=… --yes`. On Windows Dictate first calls `AllowSetForegroundWindow`, so Pane can come to the front. Replies use `runpane agents send --panel … --yes`.

## Voice reply

If the pointer is over the top card at key-down, or Reply was clicked, that one dictation goes to the card instead of being pasted. Speech, cleanup and history run as usual. The pill shows "Replying to <tab>…", then previews the cleaned text for 2 s, which Esc cancels. Then the text goes to the tab, or back to the waiting `ask`. A spoken answer that names exactly one of the choices returns that choice. If the reply can't be delivered, Dictate opens the tab and leaves the text on the clipboard.

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

[src/main/instructions.ts](../../src/main/instructions.ts) also keeps a short note in each found agent's user-level instruction file, never a project's: `$CLAUDE_CONFIG_DIR/CLAUDE.md` (else `~/.claude/CLAUDE.md`) and `$CODEX_HOME/AGENTS.md` (else `~/.codex/AGENTS.md`). [src/core/instructions.ts](../../src/core/instructions.ts) holds the text: when to use `notify` (`needs_you`), `ask` and `info`, and the plain-words rule. The full examples stay in the MCP tool descriptions.

- The note sits between `<!-- dictate:begin (managed by Dictate; edits are replaced) -->` and `<!-- dictate:end -->`. It is appended to the end of the file, which is created when missing, and replaced in place afterwards. Nothing outside the markers changes: line endings (LF or CRLF) and an existing byte order mark are kept, and none is added.
- A launch writes only when the note changed. Writes go to a temporary file that is renamed over the original.
- Turning the setting off removes the note and the blank line that set it apart, giving back the file as it was. A file that held only the note is deleted.
- A file that isn't UTF-8, has unpaired markers or is read-only is skipped and logged.
- Settings → Agents shows each file under its agent and whether it holds the note.
- The Windows uninstaller runs `Dictate.exe --remove-agent-setup`, which removes Dictate's MCP entries and notes, then quits. Updates skip it. macOS and Linux have no uninstall hook: turn the setting off before removing the app.

QA and tests never write real configs. Set `DICTATE_AGENT_HOME` to a temporary folder and registration and the notes use it as `HOME`, `CODEX_HOME` and `CLAUDE_CONFIG_DIR`. Development builds, smoke tests and `DICTATE_QA_CONTROL` runs skip registration otherwise.
