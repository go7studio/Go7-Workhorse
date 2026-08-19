# Changelog

Notable changes per release. Entries are written from the commits between
tags, so they describe what shipped rather than what was planned.

Versions follow [semantic versioning](https://semver.org/). Installers for each
release are on the [releases page](https://github.com/go7studio/Go7-Workhorse/releases):
`Go7-Workhorse-Setup-<version>.exe` for Windows and
`Go7-Workhorse-<version>-mac-arm64.dmg` or `-mac-x64.dmg` for macOS.

## [0.6.4](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.3...v0.6.4) (2026-08-19)


### Bug Fixes

* keep a slowly loading chat pinned to the latest turn ([#74](https://github.com/go7studio/Go7-Workhorse/issues/74)) ([806b4c9](https://github.com/go7studio/Go7-Workhorse/commit/806b4c97790e00ea3f195ffc2bbce23c76340475))


### Performance Improvements

* keep large desks responsive ([c67910a](https://github.com/go7studio/Go7-Workhorse/commit/c67910a522d0598fbab190c4a878d1ef9518305f))

## [0.6.3](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.2...v0.6.3) (2026-08-19)


### Features

* add adaptive goal and mission loops ([c37dbd2](https://github.com/go7studio/Go7-Workhorse/commit/c37dbd23f2ccd657fd7e86adb06134996c883397))
* surface available updates beside settings ([838c729](https://github.com/go7studio/Go7-Workhorse/commit/838c729eca0636c3ecf673bc0db65555508649b1))
* Windows installs a newer desk from inside Workhorse ([#68](https://github.com/go7studio/Go7-Workhorse/issues/68)) ([31e9a98](https://github.com/go7studio/Go7-Workhorse/commit/31e9a9838e9b6b1089413f1e1e73dbc058f3c5c8))


### Bug Fixes

* paint a long chat across frames instead of locking the desk ([#73](https://github.com/go7studio/Go7-Workhorse/issues/73)) ([c4878ea](https://github.com/go7studio/Go7-Workhorse/commit/c4878eaaed6207bd9c60d251c243f79ac7f75c92))
* scope delegated missions to their worker wave ([eec9b09](https://github.com/go7studio/Go7-Workhorse/commit/eec9b096baa9bcfbf4e7ae2d822e14983d6d73eb))
* selecting a long chat no longer freezes the desk ([#72](https://github.com/go7studio/Go7-Workhorse/issues/72)) ([cb35479](https://github.com/go7studio/Go7-Workhorse/commit/cb35479c066deb8bc1df4d80cea733a1ef0ac4e5))
* the Harnesses card reads at a glance instead of as a paragraph ([f5b754b](https://github.com/go7studio/Go7-Workhorse/commit/f5b754b2363567bdc237434c6a52affda9bfdeab))
* the Harnesses card reads at a glance instead of as a paragraph ([6e93b82](https://github.com/go7studio/Go7-Workhorse/commit/6e93b82566a678f3222d882679c7c38936330e96))

## [0.6.2](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.1...v0.6.2) (2026-08-18)


### Features

* put user copy, fork and edit under the bubble and keep them visible


### Bug Fixes

* make the whole Changes capsule the expand target
* keep Changes clipped while it folds, then ease width on close
* pin Changes above the message field so image thumbs do not lift it
* hide extra Changes metadata when the card is squeezed
* score Changes +/- without walking the project tree
* play each usage ring intro only once


## [0.6.1](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.0...v0.6.1) (2026-08-18)


### Features

* count what a vendor's own subagent spends ([fc6364a](https://github.com/go7studio/Go7-Workhorse/commit/fc6364a6aaf3a898bc32ff170a7dbf49f0f82f45))
* count what a vendor's own subagent spends ([f7973f2](https://github.com/go7studio/Go7-Workhorse/commit/f7973f2456c765fca0132cccf3667efececbbd73))
* FileViewer and Changes stay honest ([68a7606](https://github.com/go7studio/Go7-Workhorse/commit/68a760648f269f1927d6166d543fa24837dc7327))
* keep FileViewer and Changes honest so the desk can ship as 0.5.1 ([4e8b49c](https://github.com/go7studio/Go7-Workhorse/commit/4e8b49cca9640ed51b4f343bdd5c6428ded878a3))


### Bug Fixes

* a worker is launched with worker rules and offered only worker tools ([1b3e7a2](https://github.com/go7studio/Go7-Workhorse/commit/1b3e7a2afbc56e063e02092a15a62590add21c89))
* a worker is launched with worker rules and offered only worker tools ([cf75122](https://github.com/go7studio/Go7-Workhorse/commit/cf75122e5b9469b916f7b529cd68ca9f1487355e))
* keep pre-1.0 releases on patch cadence ([b2f069e](https://github.com/go7studio/Go7-Workhorse/commit/b2f069e230a48c1604ae95d9fecf17949e84ea89))
* keep pre-1.0 releases on patch cadence ([2ef8aff](https://github.com/go7studio/Go7-Workhorse/commit/2ef8affd4a1c1b9b8a7f8f4650462a46b040674e))
* keep Windows-cited paths intact on POSIX hosts ([820ed31](https://github.com/go7studio/Go7-Workhorse/commit/820ed31bf091a44c6098c1fc910c232a7f464205))
* make harness delegation execution-first ([58c9d35](https://github.com/go7studio/Go7-Workhorse/commit/58c9d35a3326131645023f90769a83b040adfc2f))
* roll long work timelines into an Earlier fold ([ff8e729](https://github.com/go7studio/Go7-Workhorse/commit/ff8e7298786ba3753d080943a22f186c6ff18a59))
* show tool names instead of a stack of 1 tool folds ([331d87d](https://github.com/go7studio/Go7-Workhorse/commit/331d87d64e8230d14f69bc0d7785cdda8bb52e01))
* typecheck FileViewer after rebase onto main ([f6b5d38](https://github.com/go7studio/Go7-Workhorse/commit/f6b5d38d886c3551e6dced4e1e12fcd909a6334e))

## [0.6.0](https://github.com/go7studio/Go7-Workhorse/compare/v0.5.1...v0.6.0) (2026-08-18)


### Features

* a try desk packs the current tree beside production ([745f090](https://github.com/go7studio/Go7-Workhorse/commit/745f090d289ec39ab4e1e60eae85121dce8ff7d8))
* a try desk packs the current tree beside production ([264a164](https://github.com/go7studio/Go7-Workhorse/commit/264a16446d98f296b6a6a995536e5424fe413f23))
* OpenClaw and Hermes join as agent systems ([a265fba](https://github.com/go7studio/Go7-Workhorse/commit/a265fba9e8505db5bb9a65fa9a0fb9fa45cfe24f))


### Bug Fixes

* Mac release tests cannot hang on a dead bridge ([fa64d3d](https://github.com/go7studio/Go7-Workhorse/commit/fa64d3d4d170bc0f02117cad440971070547ada6))
* Mac release tests cannot hang on a dead bridge ([49c662a](https://github.com/go7studio/Go7-Workhorse/commit/49c662a4873e5598a1832d486b6e4eeea22e431a))
* prevent concurrent worker name collisions ([88a3d55](https://github.com/go7studio/Go7-Workhorse/commit/88a3d55996730956a48b44686296017be2d4a9a6))

## [0.5.1](https://github.com/go7studio/Go7-Workhorse/compare/v0.5.0...v0.5.1) (2026-08-18)


### Bug Fixes

* a goal that asks for bots gets desk workers ([56ddcc0](https://github.com/go7studio/Go7-Workhorse/commit/56ddcc0fd99975a588c736b46b46e256164065ad))
* a goal that asks for bots gets desk workers, and vendor subagents are named ([be02c25](https://github.com/go7studio/Go7-Workhorse/commit/be02c257815d0833ef066d3b578fb7c022756692))
* contain live work and changes ([ec3edf9](https://github.com/go7studio/Go7-Workhorse/commit/ec3edf90e747a20443a216ecffe967cab593e567))
* keep consecutive tool calls in one work fold ([51e6425](https://github.com/go7studio/Go7-Workhorse/commit/51e6425c96ae7007e6b71fadce2e8f92d400a3c1))
* keep consecutive tool calls in one work fold ([7f690f6](https://github.com/go7studio/Go7-Workhorse/commit/7f690f6b2f56c9c0f320b390200532adf084d333))
* name a vendor's own subagent instead of losing it ([ae6da98](https://github.com/go7studio/Go7-Workhorse/commit/ae6da982515ffac35f97f5b254955d50ae594692))
* typing no longer rewrites every saved chat ([2bed53a](https://github.com/go7studio/Go7-Workhorse/commit/2bed53a95e5f4094f76bb8b804511333ed0ed72f))
* typing no longer rewrites every saved chat ([4e8012d](https://github.com/go7studio/Go7-Workhorse/commit/4e8012d7bbc4fad95ed600291ad36a52ffc5d6f8))

## [0.5.0](https://github.com/go7studio/Go7-Workhorse/compare/v0.4.1...v0.5.0) (2026-08-18)


### Features

* add agent and mismatch intelligence lanes ([77b601e](https://github.com/go7studio/Go7-Workhorse/commit/77b601e6bd9956fc8508457efd820776ffc11ce0))


### Bug Fixes

* make chat timestamps compact ([2285547](https://github.com/go7studio/Go7-Workhorse/commit/2285547309b5d7fedf62dff17d530cae7b685558))
* make learning consume the private event index ([6146f4b](https://github.com/go7studio/Go7-Workhorse/commit/6146f4bafdc66ee69fdb25204c045b9c209cc637))
* reject empty intelligence for explicit rules ([b562ac5](https://github.com/go7studio/Go7-Workhorse/commit/b562ac56ba7a9161353bef79697e467d39d62071))
* separate human intelligence from agent evidence ([bcac556](https://github.com/go7studio/Go7-Workhorse/commit/bcac556e552379113369676126408498dfefdf0e))

## [0.4.1](https://github.com/go7studio/Go7-Workhorse/compare/v0.4.0...v0.4.1) (2026-08-18)


### Bug Fixes

* keep eval target synced with releases ([e494675](https://github.com/go7studio/Go7-Workhorse/commit/e4946755014f220ed882e512642395252fa17741))
* keep release validation synchronized ([19c3687](https://github.com/go7studio/Go7-Workhorse/commit/19c368788da752f2c54123283466b47e8447d498))
* let macOS updates recognize mounted disk images ([6dde2ca](https://github.com/go7studio/Go7-Workhorse/commit/6dde2ca401ad0353f32246d3d4885077d9e95d05))
* mac updater recognizes the mounted disk image ([f88e8e2](https://github.com/go7studio/Go7-Workhorse/commit/f88e8e2731eb073d56066eaf309df1e9bc4689ad))
* preserve the existing release tag format ([d11c133](https://github.com/go7studio/Go7-Workhorse/commit/d11c133ecb507069f0d0765227c8857e7a11c4e1))
* preserve the existing release tag format ([e142073](https://github.com/go7studio/Go7-Workhorse/commit/e14207353bd13b717f48a20aaa8e888262944e6f))
* restore the published release baseline ([a444eaa](https://github.com/go7studio/Go7-Workhorse/commit/a444eaaea070ff075d5a0db234c6e44c095ed472))
* restore the published release baseline ([5c099b8](https://github.com/go7studio/Go7-Workhorse/commit/5c099b8350a11e9c66d6d3bb79493cfac890a8c9))

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
