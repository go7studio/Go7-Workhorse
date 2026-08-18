# Changelog

Notable changes per release. Entries are written from the commits between
tags, so they describe what shipped rather than what was planned.

Versions follow [semantic versioning](https://semver.org/). Installers for each
release are on the [releases page](https://github.com/go7studio/Go7-Workhorse/releases):
`Go7-Workhorse-Setup-<version>.exe` for Windows and
`Go7-Workhorse-<version>-mac-arm64.dmg` or `-mac-x64.dmg` for macOS.

## [0.5.0](https://github.com/go7studio/Go7-Workhorse/compare/go7-workhorse-v0.4.1...go7-workhorse-v0.5.0) (2026-08-18)


### Features

* a custom bot is a connection with the models you approve on it ([31bac08](https://github.com/go7studio/Go7-Workhorse/commit/31bac08822a09273d621cb70441169b20e113602))
* a custom bot is a connection with the models you approve on it ([3aaae57](https://github.com/go7studio/Go7-Workhorse/commit/3aaae571276edb465671b5176f13adb1dcd84125))
* a person's chat keeps its model unless set to Auto; the desk always routes spawns ([fbf4677](https://github.com/go7studio/Go7-Workhorse/commit/fbf4677660d43b66cf2195d845a8b98babdef797))
* a person's chat keeps its model unless set to Auto; the desk always routes spawns ([bc5c2cd](https://github.com/go7studio/Go7-Workhorse/commit/bc5c2cd6ffc5cd05edbbda76ef59f8d274c3eb44))
* execute and audit orchestrator plans ([bbbb24a](https://github.com/go7studio/Go7-Workhorse/commit/bbbb24a1c662f8263da29769bdb9e3e49e1ee5ec))
* exercise live executable plans ([3d261ea](https://github.com/go7studio/Go7-Workhorse/commit/3d261eaa472fc263b404d90dec5d3390642ef945))
* learning compiler is a custom bot and can backfill a day ([4ecf068](https://github.com/go7studio/Go7-Workhorse/commit/4ecf0685247ab327ce042541fa5f1cd36af66699))
* make agent routing auditable and bounded ([62c4b55](https://github.com/go7studio/Go7-Workhorse/commit/62c4b55933dc0cb7829f1c9ea29d206d4f970ff6))
* pass media into routed agent calls ([2b7cb36](https://github.com/go7studio/Go7-Workhorse/commit/2b7cb360449f4fb734dc0f74efe6088ed90b93ca))
* workers have names and are reused instead of started again ([#31](https://github.com/go7studio/Go7-Workhorse/issues/31)) ([b512a4f](https://github.com/go7studio/Go7-Workhorse/commit/b512a4f26a0399ca605598450701c96ace47fa3a))


### Bug Fixes

* a custom bot is told the conversation, so Kimi and MiniMax remember ([d6d6d66](https://github.com/go7studio/Go7-Workhorse/commit/d6d6d66800af7ad11fd7008a2c4c57a74217807a))
* a custom bot is told the conversation, so Kimi and MiniMax remember ([520f62e](https://github.com/go7studio/Go7-Workhorse/commit/520f62e6c482c2c7b61fb1638af8c7bfc24cded2))
* a lineup can spawn one worker per bot on the desk ([3372a0c](https://github.com/go7studio/Go7-Workhorse/commit/3372a0cea9ec4e69199aa2d29f0700d0b5f7ace5))
* a Mac installer can install the GitHub update it found ([1004e41](https://github.com/go7studio/Go7-Workhorse/commit/1004e41dbc71e7d8b04662e83d512bdf17c90227))
* a Mac installer can install the GitHub update it found ([c678eaa](https://github.com/go7studio/Go7-Workhorse/commit/c678eaae5854632234196e32fc4071bab7f96514))
* a worker the desk interrupted can be picked up again ([5a21341](https://github.com/go7studio/Go7-Workhorse/commit/5a213415b65780d34ef0878eb5d185b93b9807ab))
* a worker the desk interrupted can be picked up again ([472d855](https://github.com/go7studio/Go7-Workhorse/commit/472d85548854d28bc69c8d88ce5cb20e3889315a))
* a worker's usage files under its bot, not its orchestrator's vendor ([b71cda9](https://github.com/go7studio/Go7-Workhorse/commit/b71cda9c836227529f5d85569aef0ca75f9df49c))
* a worker's usage files under its bot, not its orchestrator's vendor ([d207402](https://github.com/go7studio/Go7-Workhorse/commit/d20740294c9881b9bd901dcf14919698d0fc0f23))
* Changes list shows real +/- and stops crowding the row ([6ee7114](https://github.com/go7studio/Go7-Workhorse/commit/6ee71148b98ecc7a2b7411a7f7919b2a615b413b))
* chat stamps say minutes, one hour, two days ([503da5a](https://github.com/go7studio/Go7-Workhorse/commit/503da5a8884441bf576dd73cfbd05952582a0d76))
* Claude launches when the CLI is not on PATH ([a7a69c3](https://github.com/go7studio/Go7-Workhorse/commit/a7a69c3ff70cc658af34b1f5d842d8230b911089))
* composer grows to half the pane ([2d16321](https://github.com/go7studio/Go7-Workhorse/commit/2d1632179fbe181f320b59981c3b3de515918083))
* Cursor's tools find git and node from a packaged build ([e7acfc8](https://github.com/go7studio/Go7-Workhorse/commit/e7acfc856c36915a39cb411cfeaf90b659864343))
* cut a release when the version changes, not when package.json is touched ([446ba27](https://github.com/go7studio/Go7-Workhorse/commit/446ba274028ceaabfeebac7ff5c57d26ae39fd71))
* cut a release when the version changes, not when package.json is touched ([3c61328](https://github.com/go7studio/Go7-Workhorse/commit/3c61328101b5d4461081d3d45e9d833412dbe903))
* Intel Macs get an installer ([5f0a747](https://github.com/go7studio/Go7-Workhorse/commit/5f0a7477050156ce8775d9090734e352c732a0cc))
* keep development runs out of Keychain ([ef4f0e5](https://github.com/go7studio/Go7-Workhorse/commit/ef4f0e53a2de54fd42c542ba558cd8df1a8a067c))
* keep eval target synced with releases ([e494675](https://github.com/go7studio/Go7-Workhorse/commit/e4946755014f220ed882e512642395252fa17741))
* keep release validation synchronized ([19c3687](https://github.com/go7studio/Go7-Workhorse/commit/19c368788da752f2c54123283466b47e8447d498))
* let macOS updates recognize mounted disk images ([6dde2ca](https://github.com/go7studio/Go7-Workhorse/commit/6dde2ca401ad0353f32246d3d4885077d9e95d05))
* local packages stop opening the production Keychain ([e26dd7b](https://github.com/go7studio/Go7-Workhorse/commit/e26dd7b3ea101892e1042b681b534eef40756e54))
* mac updater recognizes the mounted disk image ([f88e8e2](https://github.com/go7studio/Go7-Workhorse/commit/f88e8e2731eb073d56066eaf309df1e9bc4689ad))
* meter tokens by where each count came from, not by how big it is ([8274810](https://github.com/go7studio/Go7-Workhorse/commit/8274810c873801110c39ed853f7d8620acaca373))
* meter tokens by where each count came from, not by how big it is ([6c5ae48](https://github.com/go7studio/Go7-Workhorse/commit/6c5ae48b93a65fee6d76be79f2ae1c2952c4fd59))
* one join per lineup when the orchestrator awaits its workers ([c1437e2](https://github.com/go7studio/Go7-Workhorse/commit/c1437e216b425627447a9e17eef9e11d5e76056e))
* publishing can move the release label it is told to move ([f76e41c](https://github.com/go7studio/Go7-Workhorse/commit/f76e41c8e8e73b0ba1b2a52a919e397929c7339d))
* release-please can open the next release pull request ([7017711](https://github.com/go7studio/Go7-Workhorse/commit/7017711a70ef53e5e96fbba6bc8d66177485c610))
* say Auto when routing picks the model, and list loose-chat workers ([8f4e7b8](https://github.com/go7studio/Go7-Workhorse/commit/8f4e7b8be180df9184930b1084e4a8fa241a4547))
* say Auto when routing picks the model, and list loose-chat workers ([a7e212d](https://github.com/go7studio/Go7-Workhorse/commit/a7e212d2140e7779bf20f7693672d90e0d85871c))
* Settings → Routing is the desk's own routing, on by default; new chats are manual ([08e710d](https://github.com/go7studio/Go7-Workhorse/commit/08e710dc2bda8c0bbc0356689dc1cf2596c94fc8))
* Settings → Routing is the desk's own routing, on by default; new chats are manual ([4e5c861](https://github.com/go7studio/Go7-Workhorse/commit/4e5c861625900b9a2025c31fc0210ea0b8d1d9a3))
* Settings reads like System Settings, and Routing explains itself ([40c411b](https://github.com/go7studio/Go7-Workhorse/commit/40c411b6a51113ab8294ec7f786c2b38402959f8))
* Settings reads like System Settings, and Routing explains itself ([da18923](https://github.com/go7studio/Go7-Workhorse/commit/da189235ec459e7575ac7858c530b3d5850037c2))
* stop calling a working turn "finished without a visible reply" ([4ea8efb](https://github.com/go7studio/Go7-Workhorse/commit/4ea8efb108f6656ab3ea416789ac09bf60688a53))
* stop calling a working turn "finished without a visible reply" ([f091cac](https://github.com/go7studio/Go7-Workhorse/commit/f091cacaeeb3f07836c68d9e3085c9b29e222fd9))
* the chip that actually renders says Auto; the setup panel's slider steps aside ([960a3c1](https://github.com/go7studio/Go7-Workhorse/commit/960a3c1c4a09e064d79d7c5ce755497a6c9524fb))
* the join fires on its own after the workers finish ([74111a1](https://github.com/go7studio/Go7-Workhorse/commit/74111a172bd171a791776dc8ec29f84b64b9bb3d))
* the macOS install script actually installs ([a146fb5](https://github.com/go7studio/Go7-Workhorse/commit/a146fb5c5f35b9210c2f92cbb623b89a8c7aa807))

## [0.4.1](https://github.com/go7studio/Go7-Workhorse/compare/v0.4.0...v0.4.1) (2026-08-18)


### Bug Fixes

* let macOS updates recognize mounted disk images ([6dde2ca](https://github.com/go7studio/Go7-Workhorse/commit/6dde2ca401ad0353f32246d3d4885077d9e95d05))
* mac updater recognizes the mounted disk image ([f88e8e2](https://github.com/go7studio/Go7-Workhorse/commit/f88e8e2731eb073d56066eaf309df1e9bc4689ad))

## [0.4.0](https://github.com/go7studio/Go7-Workhorse/compare/v0.3.2...v0.4.0) (2026-08-18)


### Features

* learning compiler is a custom bot and can backfill a day ([4ecf068](https://github.com/go7studio/Go7-Workhorse/commit/4ecf0685247ab327ce042541fa5f1cd36af66699))


### Bug Fixes

* Changes list shows real +/- and stops crowding the row ([6ee7114](https://github.com/go7studio/Go7-Workhorse/commit/6ee71148b98ecc7a2b7411a7f7919b2a615b413b))
* chat stamps say minutes, one hour, two days ([503da5a](https://github.com/go7studio/Go7-Workhorse/commit/503da5a8884441bf576dd73cfbd05952582a0d76))
* composer grows to half the pane ([2d16321](https://github.com/go7studio/Go7-Workhorse/commit/2d1632179fbe181f320b59981c3b3de515918083))

## [0.3.2](https://github.com/go7studio/Go7-Workhorse/compare/v0.3.1...v0.3.2) (2026-08-18)


### Bug Fixes

* a Mac installer can install the GitHub update it found ([1004e41](https://github.com/go7studio/Go7-Workhorse/commit/1004e41dbc71e7d8b04662e83d512bdf17c90227))
* a Mac installer can install the GitHub update it found ([c678eaa](https://github.com/go7studio/Go7-Workhorse/commit/c678eaae5854632234196e32fc4071bab7f96514))
* keep development runs out of Keychain ([ef4f0e5](https://github.com/go7studio/Go7-Workhorse/commit/ef4f0e53a2de54fd42c542ba558cd8df1a8a067c))
* local packages stop opening the production Keychain ([e26dd7b](https://github.com/go7studio/Go7-Workhorse/commit/e26dd7b3ea101892e1042b681b534eef40756e54))

## [0.3.1](https://github.com/go7studio/Go7-Workhorse/compare/v0.3.0...v0.3.1) (2026-08-17)


### Bug Fixes

* a custom bot is told the conversation, so Kimi and MiniMax remember ([d6d6d66](https://github.com/go7studio/Go7-Workhorse/commit/d6d6d66800af7ad11fd7008a2c4c57a74217807a))
* a custom bot is told the conversation, so Kimi and MiniMax remember ([520f62e](https://github.com/go7studio/Go7-Workhorse/commit/520f62e6c482c2c7b61fb1638af8c7bfc24cded2))

## [0.3.0](https://github.com/go7studio/Go7-Workhorse/compare/v0.2.0...v0.3.0) (2026-08-17)


### Features

* workers have names and are reused instead of started again ([#31](https://github.com/go7studio/Go7-Workhorse/issues/31)) ([b512a4f](https://github.com/go7studio/Go7-Workhorse/commit/b512a4f26a0399ca605598450701c96ace47fa3a))


### Bug Fixes

* a worker the desk interrupted can be picked up again ([5a21341](https://github.com/go7studio/Go7-Workhorse/commit/5a213415b65780d34ef0878eb5d185b93b9807ab))
* a worker the desk interrupted can be picked up again ([472d855](https://github.com/go7studio/Go7-Workhorse/commit/472d85548854d28bc69c8d88ce5cb20e3889315a))
* publishing can move the release label it is told to move ([f76e41c](https://github.com/go7studio/Go7-Workhorse/commit/f76e41c8e8e73b0ba1b2a52a919e397929c7339d))

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
