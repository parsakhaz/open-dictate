Fully local dictation: hold a key, speak, and clean text appears where you type. Nothing leaves your computer.

## What's new in 0.1.2

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
