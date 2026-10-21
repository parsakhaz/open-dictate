Fully local dictation: hold a key, speak, and clean text appears where you type. Nothing leaves your computer.

## What's new in 0.2.1

Security update: the bundled desktop runtime is now Electron 44.9.2, which rejects the compromised eMudhra certificate chains ([#36](https://github.com/parsakhaz/open-dictate/pull/36)). Install this patch to receive the updated runtime; updating Node on your computer does not update an existing Dictate installation.

## What's new in 0.2.0

Agents reach you in more ways, and you can reach them. Everything is in Settings → **Agents**.

- **Several questions in one card** ([#16](https://github.com/parsakhaz/open-dictate/pull/16)). An agent with a few related choices asks them together. Click the chips, or hold your key over the card and answer in one sentence: "staging, and once then email". When the options come with a preview, a wider sheet shows each one side by side.
- **Approve a plan** ([#16](https://github.com/parsakhaz/open-dictate/pull/16)). One click approves, or say what to change and the agent gets your words. For risky plans only a click approves.
- **Cards wait while you work** ([#19](https://github.com/parsakhaz/open-dictate/pull/19)). A card that arrives while you type, dictate or present (Windows) waits behind a quiet "3 waiting", with no chime.
- **Clear them in a round** ([#19](https://github.com/parsakhaz/open-dictate/pull/19)). Ctrl+Alt+Space opens the waiting cards one at a time right above the pill. Use the number keys, Enter, S and →, or just say "approve", "next" or "snooze ten" while it's open. Undo takes back the last one.
- **Snooze** ([#19](https://github.com/parsakhaz/open-dictate/pull/19)). Click 3m, 5m or 10m on a card, or press Ctrl+Alt+Z. It comes back by itself, tagged "Back from snooze". The agent always learns what happened to its card.
- **Talk to your agents** ([#17](https://github.com/parsakhaz/open-dictate/pull/17)). Hold Ctrl+Win and say what you want. It goes to a "Voice" orchestrator in Pane, created the first time you use it, which hands the work to the right agent and answers on the pill. If its chat already holds a draft, nothing is sent and a card tells you.
- **Pick from a lineup** ([#21](https://github.com/parsakhaz/open-dictate/pull/21)). An agent lines up two to six mockups, images or texts. Star your favourites in order, open one full size, or say "two and four, two first".
- **Peek at a page** ([#20](https://github.com/parsakhaz/open-dictate/pull/20)). An agent shows you a localhost page, a local report or an https site you allowed. It arrives as a card; click Peek to dock it, then hold your key over a button and talk. The agent gets your words, the element and a crop. Pages run sandboxed and can't leave the page without asking you.
- **Point and say, on Windows** ([#18](https://github.com/parsakhaz/open-dictate/pull/18)). Choose a point key, hold it over anything on screen and say "fix this". You always see the crop and the text before it goes, with secrets masked. It does nothing over password managers, and captures are deleted after 24 hours. The point key is off until you pick one.

Agents are told when each new kind of card fits better than a plain question, in the short note Dictate keeps in `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`.

## What's new in 0.1.2

Automatic gain ([#11](https://github.com/parsakhaz/open-dictate/pull/11)): Dictate now raises a quiet voice by itself instead of applying one fixed boost, aiming at a normal speech level without turning up the room hiss in every pause. It is on by default in Settings → **Microphone**, up to each mic's **Maximum boost**; a boost you had set before becomes that maximum.

Agent cards on the pill ([#9](https://github.com/parsakhaz/open-dictate/issues/9)):

- Agents are told how to write a card you can act on: what the work is for, what just happened and what they need from you, in plain words and plain text, with good and bad examples.
- Pane's own "Needs your input" and "Finished" alerts no longer show on the pill by default, so they don't double up with Pane's notifications. Turn them back on in Settings → Agents → **Show Pane's agent alerts on the pill**. Cards your agents send are unchanged.

## What's new in 0.1.1

Agent cards on the pill ([#9](https://github.com/parsakhaz/open-dictate/issues/9)):

- Clicking a card's buttons works. On Windows the pill never noticed the pointer over a card, so clicks fell through to the window behind it, and the hidden pill also swallowed clicks in the middle of the button row.
- A card shows its whole title and message, so you can read it at a glance. Its buttons ease in when you point at it.
- Agents' Markdown reads cleanly: **bold**, *italic* and `code` are styled, and other marks are dropped instead of showing raw.
- While you hold the key to answer a card by voice, the card stays up, marked "Replying by voice…".
- Info cards stay for about 4.5 s, never go while you point at them, and stay 2 s more after you move away. The vocabulary review card stays until you review or dismiss it, even after the agent disconnects.

## Install

| Computer | Download |
| --- | --- |
| Windows 10/11 (x64) | `Dictate-<version>-windows-x64-setup.exe` |
| Mac with Apple Silicon | `Dictate-<version>-macos-arm64.dmg` |
| Intel Mac | `Dictate-<version>-macos-x64.dmg` |
| Linux x64 or ARM64 | `.deb`, or the `.AppImage` |

The builds are not code-signed, so your system asks once before opening them:

- **Windows:** SmartScreen says "Windows protected your PC". Click **More info**, then **Run anyway**. The installer is per-user and needs no admin rights.
- **macOS:** if Gatekeeper blocks it, open **System Settings → Privacy & Security** and click **Open Anyway**.

On first launch, Getting started downloads the speech and cleanup models (about 0.7 GB), checks how fast cleanup runs on your computer, then walks you through your mic, your key and a practice dictation.

`SHA256SUMS` lists the checksum of every file here. The one-line installers in `scripts/` verify it for you.
