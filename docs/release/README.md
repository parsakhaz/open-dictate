# Packaging, releases and platform notes

## How a release is made

The [CI workflow](../../.github/workflows/ci.yml) checks, builds and smoke-launches the real application on native Windows x64, macOS Apple Silicon and Intel, and Linux x64 and ARM64 runners. On every run:

- unit and platform tests, then the real speech model and cleanup runtime installed through the production setup code, and a real fixture transcribed on that OS
- native clipboard, focus, typing and keyboard-hook checks (Windows and Linux), framework and permission checks (macOS)
- installers built with `--publish never`, launched, and on Linux the `.deb` installed with the Chromium sandbox on
- the app's audio, recognizer, output and cancel journey (`qa/app-smoke.mjs`) and the Settings regression (`qa/settings-progress.mjs`)
- on Windows, a real-pointer click on an agent card's choice (`qa/cards-pointer.js`)

Each job uploads `dictate-package-<platform>-<arch>-<sha>` (installers, `SHA256SUMS`, the checksum-verifying install scripts, update metadata) and `dictate-evidence-<platform>-<arch>-<sha>` (startup reports, screenshots, native input checks).

**Publishing** needs a `dictate-v<package version>` tag on `main` (or an explicit dispatch on such a tag), and every native job must pass. The release job then collects the artifacts with `scripts/release.mjs collect`, which fails unless every installer and the auto-update metadata (`latest.yml`, the Windows `.blockmap`, `latest-linux.yml`, `latest-linux-arm64.yml`) are present, writes an aggregate `SHA256SUMS`, and creates the release with the notes in [.github/release-notes.md](../../.github/release-notes.md). No feature branch becomes a release because its CI passed.

```sh
pnpm release:check          # validate the version and tag
pnpm release:checksums      # SHA256SUMS for dist/
```

## Installers

| Platform | Artifacts | Notes |
| --- | --- | --- |
| Windows x64 | `Dictate-<v>-windows-x64-setup.exe` (NSIS) | Per-user, no admin. Starts the app when it finishes. The uninstaller asks whether to delete settings, history and models; updates and silent uninstalls keep them ([build/installer.nsh](../../build/installer.nsh)). Windows ARM can use x64 emulation. |
| macOS | `Dictate-<v>-macos-<arch>.dmg` and `.zip` | Ad-hoc signed unless signing credentials are configured. Gatekeeper asks once: **System Settings → Privacy & Security → Open Anyway**. |
| Linux | `Dictate-<v>-linux-<arch>.AppImage` and `.deb` | X11 needs `xdotool`, `libXtst`, GTK3 and a desktop session. |

The one-line installers [scripts/install.sh](../../scripts/install.sh) and [scripts/install.ps1](../../scripts/install.ps1) pick the right file for the OS and architecture from `parsakhaz/open-dictate` releases, verify its checksum, and upgrade in place, keeping data. See their help for an exact version or a custom location.

**No code signing (decided).** Windows SmartScreen shows "Windows protected your PC" for each new unsigned installer: **More info → Run anyway**. On a PC with Smart App Control switched on, unsigned apps are blocked with no Run anyway; that is the trigger to revisit signing.

**Testing builds before a release:** open a successful CI run and download the `dictate-package-…` artifact for your computer.

## Auto-update

Builds carry `app-update.yml` pointing at this repository. Windows (NSIS) and AppImage builds download updates in the background and install them on quit or after 10 idle minutes, never during a dictation, cleanup or download. An unsigned Mac app cannot replace itself and a `.deb` belongs to its package manager, so those builds only say a new version is out and link to it. The rules are in [src/core/updates.ts](../../src/core/updates.ts).

## Platform behaviour

| Capability | Windows x64 | macOS x64 / ARM64 | Linux X11 x64 / ARM64 | Linux Wayland |
| --- | --- | --- | --- | --- |
| Streaming microphone capture | Native WASAPI, WebAudio fallback | WebAudio | WebAudio | WebAudio |
| Hold / double-tap dictation key | Native keyboard hook | With keyboard permissions | With X11 input access | Desktop does not expose raw key-up events |
| Start / finish from app or tray | Yes | Yes | Yes | Yes |
| Desktop toggle shortcut | Configurable hook binding | Configurable hook binding | Configurable hook binding | **Enable desktop shortcut** requests the compositor's portal; availability depends on the desktop |
| Automatic paste | Ctrl+V / SendInput | Cmd+V / Quartz with Accessibility | XTest through `xdotool`; terminals use Ctrl+Shift+V | Clipboard only; paste manually |
| Consume dictation/picker keys | Yes | The listener observes keys without consuming them | The listener observes keys without consuming them | Not available |
| History picker | Does not take focus | Focused window with local keys | Focused window with local keys | Focused window; copy from history |
| Start at login | Native login item | Native login item | XDG autostart | XDG autostart |

On Mac and Linux X11, choose an unused dictation key: other applications also receive the key. The Windows default history shortcut Right Ctrl+V is off on fresh Mac and Linux installs so it cannot also trigger another app's paste; open history from the tray or **Hotkeys & output**.

Wayland's isolation is intentional: dictate does not pretend XWayland grants access to native Wayland apps. Settings explains copy-only output and offers a portal toggle. If the compositor has no working global-shortcut portal, use the app or tray controls. A passing X11 CI run does not prove a particular Wayland compositor.

The clipboard is restored only when the paste target can be confirmed. On X11, or a Mac control that does not expose a text role, the text stays copied after the paste so it can be recovered, because a successful key injection cannot prove the target accepted text. Every transcript also goes to history. Windows privacy formats keep transient text out of Win+V history and the cloud clipboard; on a Mac, concealed/transient pasteboard hints are set. Linux clipboard managers and Mac Universal Clipboard may keep ordinary copied text according to their own settings.

**Keep the mic ready** is a Windows native-capture feature; WebAudio releases its stream after each recording on Mac and Linux.
