# Changelog

Notable changes per release. Entries are written from the commits between
tags, so they describe what shipped rather than what was planned.

Versions follow [semantic versioning](https://semver.org/). Installers for each
release are on the [releases page](https://github.com/go7studio/Go7-Workhorse/releases):
`Go7-Workhorse-Setup-<version>.exe` for Windows and
`Go7-Workhorse-<version>-mac-arm64.dmg` or `-mac-x64.dmg` for macOS.

## [0.2.0](https://github.com/go7studio/Go7-Workhorse/compare/v0.1.10...v0.2.0) (2026-08-17)


### Features

* a custom bot is a connection with the models you approve on it ([31bac08](https://github.com/go7studio/Go7-Workhorse/commit/31bac08822a09273d621cb70441169b20e113602))
* a custom bot is a connection with the models you approve on it ([3aaae57](https://github.com/go7studio/Go7-Workhorse/commit/3aaae571276edb465671b5176f13adb1dcd84125))


### Bug Fixes

* cut a release when the version changes, not when package.json is touched ([446ba27](https://github.com/go7studio/Go7-Workhorse/commit/446ba274028ceaabfeebac7ff5c57d26ae39fd71))
* cut a release when the version changes, not when package.json is touched ([3c61328](https://github.com/go7studio/Go7-Workhorse/commit/3c61328101b5d4461081d3d45e9d833412dbe903))
* release-please can open the next release pull request ([7017711](https://github.com/go7studio/Go7-Workhorse/commit/7017711a70ef53e5e96fbba6bc8d66177485c610))
* the macOS install script actually installs ([a146fb5](https://github.com/go7studio/Go7-Workhorse/commit/a146fb5c5f35b9210c2f92cbb623b89a8c7aa807))

## [0.1.10](https://github.com/go7studio/Go7-Workhorse/compare/v0.1.9...v0.1.10) (2026-08-17)


### Bug Fixes

* Intel Macs get an installer ([5f0a747](https://github.com/go7studio/Go7-Workhorse/commit/5f0a7477050156ce8775d9090734e352c732a0cc))
* Settings → Routing is the desk's own routing, on by default; new chats are manual ([08e710d](https://github.com/go7studio/Go7-Workhorse/commit/08e710dc2bda8c0bbc0356689dc1cf2596c94fc8))
* Settings → Routing is the desk's own routing, on by default; new chats are manual ([4e5c861](https://github.com/go7studio/Go7-Workhorse/commit/4e5c861625900b9a2025c31fc0210ea0b8d1d9a3))
* stop calling a working turn "finished without a visible reply" ([4ea8efb](https://github.com/go7studio/Go7-Workhorse/commit/4ea8efb108f6656ab3ea416789ac09bf60688a53))
* stop calling a working turn "finished without a visible reply" ([f091cac](https://github.com/go7studio/Go7-Workhorse/commit/f091cacaeeb3f07836c68d9e3085c9b29e222fd9))
* the chip that actually renders says Auto; the setup panel's slider steps aside ([960a3c1](https://github.com/go7studio/Go7-Workhorse/commit/960a3c1c4a09e064d79d7c5ce755497a6c9524fb))

## [0.1.9](https://github.com/go7studio/Go7-Workhorse/compare/v0.1.8...v0.1.9) (2026-08-17)


### Bug Fixes

* a lineup can spawn one worker per bot on the desk ([3372a0c](https://github.com/go7studio/Go7-Workhorse/commit/3372a0cea9ec4e69199aa2d29f0700d0b5f7ace5))
* Claude launches when the CLI is not on PATH ([a7a69c3](https://github.com/go7studio/Go7-Workhorse/commit/a7a69c3ff70cc658af34b1f5d842d8230b911089))
* Cursor's tools find git and node from a packaged build ([e7acfc8](https://github.com/go7studio/Go7-Workhorse/commit/e7acfc856c36915a39cb411cfeaf90b659864343))
* meter tokens by where each count came from, not by how big it is ([8274810](https://github.com/go7studio/Go7-Workhorse/commit/8274810c873801110c39ed853f7d8620acaca373))
* meter tokens by where each count came from, not by how big it is ([6c5ae48](https://github.com/go7studio/Go7-Workhorse/commit/6c5ae48b93a65fee6d76be79f2ae1c2952c4fd59))
* one join per lineup when the orchestrator awaits its workers ([c1437e2](https://github.com/go7studio/Go7-Workhorse/commit/c1437e216b425627447a9e17eef9e11d5e76056e))
* Settings reads like System Settings, and Routing explains itself ([40c411b](https://github.com/go7studio/Go7-Workhorse/commit/40c411b6a51113ab8294ec7f786c2b38402959f8))
* Settings reads like System Settings, and Routing explains itself ([da18923](https://github.com/go7studio/Go7-Workhorse/commit/da189235ec459e7575ac7858c530b3d5850037c2))
* the join fires on its own after the workers finish ([74111a1](https://github.com/go7studio/Go7-Workhorse/commit/74111a172bd171a791776dc8ec29f84b64b9bb3d))

## [0.1.8] — 2026-08-17

- A turn’s work popout keeps thinking and tool calls in the order they
  happened: think, tool, think. Finished hops close so the open fold is
  the current phase; click a finished dot to expand it again.
- Profile shows Your Workhorse as tiny moving blobs of the bots you have
  called. Spend sets how many of each color; they merge in space without
  mixing into a new one.
- Project home Edited opens the file on disk. Rows keep who and when, and
  drop git `+/−` counts that read as thousands of adds on a folder that is
  not a repo.
- Chat rows and turns show when you last sent a prompt.
- A private learning store lives on your own disk, and the public desk no
  longer ships a Go7 Play Billing skill.
- Cursor models stay in step with the live CLI, including Auto.
- Mac releases require notarization, and the installer removes the old
  Workhorse.app name.

## [0.1.7] — 2026-08-16

Cut so that Windows has an installer again: 0.1.6 published only a dmg,
because its Windows job failed on the Cursor tests before packaging.

- Cursor discovery tests declare the platform they mean, so they pass on
  Windows as well as here. The adapter was always right; the tests inherited
  whichever machine ran them.
- Repository moved to the Go7 Studio organization. The update checker pointed
  at the old owner, so an installed build asked a personal account about
  releases the organization publishes.
- CI runs build, test and a secret scan on Linux, Windows and macOS for every
  push and pull request, instead of only when the version changes.
- Release artifact matching survives the rename to Go7 Workhorse.
- MIT licence, CODEOWNERS, a launch checklist, an architecture diagram, and a
  README that leads with what the desk is for.
- A macOS install script that reads the releases API.
- Mac folder grants are kept, and Cursor skills are listed on the desk.

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

[0.1.8]: https://github.com/go7studio/Go7-Workhorse/releases/tag/v0.1.8
[0.1.7]: https://github.com/go7studio/Go7-Workhorse/releases/tag/v0.1.7
[0.1.6]: https://github.com/go7studio/Go7-Workhorse/releases/tag/v0.1.6
[0.1.5]: https://github.com/go7studio/Go7-Workhorse/releases/tag/v0.1.5
[0.1.4]: https://github.com/go7studio/Go7-Workhorse/releases/tag/v0.1.4
[0.1.2]: https://github.com/go7studio/Go7-Workhorse/releases/tag/v0.1.2
[0.1.1]: https://github.com/go7studio/Go7-Workhorse/releases/tag/v0.1.1
