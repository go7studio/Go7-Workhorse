# Changelog

Notable changes per release. Entries are written from the commits between
tags, so they describe what shipped rather than what was planned.

Versions follow [semantic versioning](https://semver.org/). Installers for each
release are on the [releases page](https://github.com/go7studio/Go7-Workhorse/releases):
`Go7-Workhorse-Setup-<version>.exe` for Windows and
`Go7-Workhorse-<version>-mac.dmg` for macOS.

## [0.1.6] — 2026-08-16

- Cursor ACP detection and its smoke test hardened.
- Recovered work calls show elapsed time.
- Eval coverage extended over production regressions.

## [0.1.5] — 2026-08-16

- Plan orchestration hardened: multi-wave wakeups repaired, nested helpers
  routed from live capacity, completed plan work can reopen, and executable
  plans continue after a worker joins.
- Agent reasoning effort is routed by task, and the sidebar shows each worker's
  model, effort and state.
- Cross-platform Electron packaging fixed.

## [0.1.4] — 2026-08-16

- Agent goals, orchestration and runtime updates integrated.
- Custom-bot provider catalog added.
- Source lookup searches beyond the current folder, and tool rows shorten long
  paths while stored text keeps them whole.
- Working rules written into `AGENTS.md`, with a test that fails on any tracked
  symlink.
- Several tests stopped depending on the machine running them.

## [0.1.2] — 2026-08-15

First release built for both platforms from one commit.

- **macOS support.** Electron-builder mac target, app icon, hardened-runtime
  entitlements, and `dist:mac`.
- **Vendor lookups follow the machine.** One definition of the per-user data
  root — `%LOCALAPPDATA%`, `~/Library/Application Support`, `$XDG_DATA_HOME` —
  instead of a Windows path built on every platform.
- **Claude runs from a packaged build.** The ACP script inside `app.asar` runs
  on Electron's own binary; a system node cannot read an archive and failed with
  `MODULE_NOT_FOUND`.
- **A missing vendor CLI is named**, rather than surfacing as `spawn ENOTDIR`.
- **Login state is honest.** Credential expiry is checked, and on macOS the
  login keychain is read, where the CLI actually stores it.
- **The desk holds its own Claude token** via `setup-token`, so signing in here
  no longer signs the person out of Claude Code.
- **Effort reaches the agent.** Sent as a session config option — the channel
  the agent reads — with Claude's real scale, plus Fast mode and agent persona.
- **CI builds and tests on Windows and macOS**, publishing both installers.

## [0.1.1] — 2026-08-14

- Windows desktop shell with Grok, Codex and Claude adapters, projects and
  chats, the permission bar, and the NSIS installer.

[0.1.6]: https://github.com/go7studio/Go7-Workhorse/releases/tag/v0.1.6
[0.1.5]: https://github.com/go7studio/Go7-Workhorse/releases/tag/v0.1.5
[0.1.4]: https://github.com/go7studio/Go7-Workhorse/releases/tag/v0.1.4
[0.1.2]: https://github.com/go7studio/Go7-Workhorse/releases/tag/v0.1.2
[0.1.1]: https://github.com/go7studio/Go7-Workhorse/releases/tag/v0.1.1
