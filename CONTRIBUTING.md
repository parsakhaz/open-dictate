# Contributing to open-dictate

Thanks for helping. Bug reports, fixes and small focused features are all welcome.

## Reporting a bug

Open an issue with the **Bug report** template. The most useful things to include:

- your OS and version, and the computer (CPU, GPU, RAM)
- the **speed check** line from Settings → Cleanup (for example "This computer: Apple M1 Pro (Metal), 32 GB RAM. Emberon cleaned the sample in 0.06 s.")
- what you did, what happened, and what you expected
- the relevant lines of the log (tray → **Open log**). The log never contains what you dictated, but check before you paste.

## Sending a change

1. Read [docs/development](docs/development/README.md) to build and run it, and [docs/architecture](docs/architecture/README.md) for where things live.
2. Branch from `main`. Keep a pull request to one change.
3. Write the test first where you can: `src/core/` is pure and every behaviour there has a unit test.
4. Before opening the pull request:

   ```sh
   pnpm typecheck && pnpm lint && pnpm test && pnpm test:scripts
   ```

5. For UI changes, include a before/after screenshot. `qa/settingsshots.js` renders Settings and Getting started off-screen.
6. CI builds and smoke-tests every OS; a pull request needs it green on all of them.

## Checklist

- [ ] Tests cover the new behaviour, and the four commands above pass.
- [ ] Nothing new leaves the computer, and nothing new polls while idle.
- [ ] A failure keeps the person's words (cleanup keeps its input; output falls back to the clipboard and history).
- [ ] New windows and prompts do not take focus from the app being typed into.
- [ ] Docs updated when behaviour changes (README for people, `docs/` for contributors).

By contributing you agree that your contribution is licensed under the [AGPL-3.0](LICENSE).
