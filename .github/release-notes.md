Fully local dictation: hold a key, speak, and clean text appears where you type. Nothing leaves your computer.

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
