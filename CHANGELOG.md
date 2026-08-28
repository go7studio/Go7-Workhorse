# Changelog

Notable changes per release. Entries are written from the commits between
tags, so they describe what shipped rather than what was planned.

Versions follow [semantic versioning](https://semver.org/). Installers for each
release are on the [releases page](https://github.com/go7studio/Go7-Workhorse/releases):
`Go7-Workhorse-Setup-<version>.exe` for Windows and
`Go7-Workhorse-<version>-mac-arm64.dmg` or `-mac-x64.dmg` for macOS.

## [0.6.44](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.43...v0.6.44) (2026-08-28)


### Bug Fixes

* hide usage alerts on project info ([ba5dab3](https://github.com/go7studio/Go7-Workhorse/commit/ba5dab35735a0f2c1cf4122487a9695f453e4811))
* never spawn a worker onto a vendor with no leftover ([cb0231f](https://github.com/go7studio/Go7-Workhorse/commit/cb0231f3210bc8358971eae6e44a71d287acb86e))
* never spawn a worker onto a vendor with no leftover ([687a48a](https://github.com/go7studio/Go7-Workhorse/commit/687a48a464d23d038eddac429959e201031a20c4))
* only ever launch Cursor with a slug it listed ([4a328d8](https://github.com/go7studio/Go7-Workhorse/commit/4a328d8c953dafd33b2bd1fc2897dd6bb30724ae))
* only ever launch Cursor with a slug it listed ([84e7a06](https://github.com/go7studio/Go7-Workhorse/commit/84e7a065c9e1c7aee19fe8049435b517b3afe287))
* recover updated runtimes and quiet project info ([6e1f8eb](https://github.com/go7studio/Go7-Workhorse/commit/6e1f8eb39bb2ffbcace5948e43ad75cf27b8805b))
* recover vendor runtimes after updates ([e0127a2](https://github.com/go7studio/Go7-Workhorse/commit/e0127a2880cd887373e5daba551bbb2208adcb26))

## [0.6.43](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.42...v0.6.43) (2026-08-28)


### Bug Fixes

* condense simultaneous usage alerts ([adfacc6](https://github.com/go7studio/Go7-Workhorse/commit/adfacc6bd8690be5d2a539182ea410470e4c76ae))
* condense simultaneous usage alerts ([e375ef4](https://github.com/go7studio/Go7-Workhorse/commit/e375ef446c06e727c488ff1db4a8adceb829a1bb))
* make failed chat forks retryable ([36d0530](https://github.com/go7studio/Go7-Workhorse/commit/36d0530ca8def43648f56bf0b08d5477dcf3cb4d))
* make failed chat forks retryable ([f94270d](https://github.com/go7studio/Go7-Workhorse/commit/f94270d5e516a285c4a5c3ff6d10b072263fa478))

## [0.6.42](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.41...v0.6.42) (2026-08-27)


### Bug Fixes

* launch Cursor families with valid model slugs ([907b445](https://github.com/go7studio/Go7-Workhorse/commit/907b445343504a274c69e82065eeb84f6075a77b))
* launch Cursor families with valid model slugs ([a5d339e](https://github.com/go7studio/Go7-Workhorse/commit/a5d339e3f07e84339231aa5bffb722457b90d30d))

## [0.6.41](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.40...v0.6.41) (2026-08-27)


### Features

* make skills and chat identity feel native ([9b3f0ec](https://github.com/go7studio/Go7-Workhorse/commit/9b3f0ecf236de36c155e5bc460a587c28f7277bb))
* surface matching skills from natural prompts ([87c0ca4](https://github.com/go7studio/Go7-Workhorse/commit/87c0ca42f58f08c037a6b5b03b023fd7dd411341))


### Bug Fixes

* an offloaded picture still resizes, and one dead blob no longer ends a chat ([e90aef6](https://github.com/go7studio/Go7-Workhorse/commit/e90aef6950c48e7a00016b5a55d9242c43e6a8a3))
* keep pictures out of the hot state JSON, verifiably ([0d8c09b](https://github.com/go7studio/Go7-Workhorse/commit/0d8c09b4c9aa279cb3a8b73478f0ee10211706b5))
* pin the blame boundary, tag the save's tail, and correct the numbers ([3706d15](https://github.com/go7studio/Go7-Workhorse/commit/3706d1546a1c2eb17bdda03b3032ea230ee9b685))
* show Codex allowance remaining ([a10764f](https://github.com/go7studio/Go7-Workhorse/commit/a10764ffce48c64ebeefd99b93f49a914f342b89))
* the resized picture can leave the canvas, and a history turn is never empty ([e31cea7](https://github.com/go7studio/Go7-Workhorse/commit/e31cea72aae61ab65f1fdc51f812520a1faf0d9c))
* the stall recorder blames the right window, and the chain cannot die ([f1e1803](https://github.com/go7studio/Go7-Workhorse/commit/f1e18035fd9bdb335aea9571b362ef9578ef95b4))
* the worker token ceiling counts what a worker actually spends ([7d437d0](https://github.com/go7studio/Go7-Workhorse/commit/7d437d0c9907bae96ae6fdce3629d4768ab1145a))
* the worker token ceiling counts what a worker actually spends ([3367069](https://github.com/go7studio/Go7-Workhorse/commit/3367069017d880e15a033a1a0f18a787534a3dfe))
* title vendor chats from user prompts ([ca3fdd0](https://github.com/go7studio/Go7-Workhorse/commit/ca3fdd0c85e2fb2958053fb3ccad480a37dc6d6c))


### Performance Improvements

* record main-process stalls, and stop holding the loop for the disk ([503eb58](https://github.com/go7studio/Go7-Workhorse/commit/503eb58be3256598dd975f2ebffa19c03845df78))
* record main-process stalls, and stop holding the loop for the disk ([7ae4a44](https://github.com/go7studio/Go7-Workhorse/commit/7ae4a4429be8e9ae580b5dd5c0708e44ad19f387))

## [0.6.40](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.39...v0.6.40) (2026-08-26)


### Bug Fixes

* drop idle worker CLIs and parse desk state once per Link request ([9e88028](https://github.com/go7studio/Go7-Workhorse/commit/9e880287c538e0bc1e6954b1c0b30b9b0907049a))
* keep pictures and clones out of the hot state JSON ([28bbf17](https://github.com/go7studio/Go7-Workhorse/commit/28bbf17f55de83e98d211768b77108ae9aeefef3))
* shrink desk state and stop idle workers holding RAM ([e1abc55](https://github.com/go7studio/Go7-Workhorse/commit/e1abc55d0bfc7feb325b82074cf6bc1b37c06f89))
* the worktree sweep must not delete a worker's only copy ([#184](https://github.com/go7studio/Go7-Workhorse/issues/184)) ([8c52290](https://github.com/go7studio/Go7-Workhorse/commit/8c52290dda6cc274686877c2ad7afaed0edb5b6a))
* verify a picture is on disk before dropping the only copy ([334285f](https://github.com/go7studio/Go7-Workhorse/commit/334285f21e46b4b4f3130dd440a8d6a531b6b2f0))

## [0.6.39](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.38...v0.6.39) (2026-08-25)


### Features

* one call shows the whole worker board ([97d0b6d](https://github.com/go7studio/Go7-Workhorse/commit/97d0b6dacd759edf4df7b4bca223a3fb6240751a))
* one call shows the whole worker board ([7fb49f6](https://github.com/go7studio/Go7-Workhorse/commit/7fb49f6937fea2b7c6914e54d54a40293a42169b))
* **routing:** a bot is local because of its address, not its name ([50f5016](https://github.com/go7studio/Go7-Workhorse/commit/50f501677702b570c6533d8a2fb4bf2a276629a1))
* **routing:** a bot is local because of its address, not its name ([d2ea952](https://github.com/go7studio/Go7-Workhorse/commit/d2ea9521e83c00db8a933570b3fe17dff1cd573d))
* tell a harness when its worker finished ([8444de3](https://github.com/go7studio/Go7-Workhorse/commit/8444de3a973606eec777a1edc47617263efab6b3))
* tell a harness when its worker finished ([b55bd80](https://github.com/go7studio/Go7-Workhorse/commit/b55bd80afe1ba7649b0b52a458d96bccb3883ec8))


### Bug Fixes

* a host at capacity is asking for a wait, not reporting a failure ([7d5581b](https://github.com/go7studio/Go7-Workhorse/commit/7d5581bacb3922a649ae335501e39b72dd4bb737))
* a host at capacity is asking for a wait, not reporting a failure ([bfb9621](https://github.com/go7studio/Go7-Workhorse/commit/bfb96213462ec6440b249e48f81d0f0999092739))
* being smarter is free, paying more for it is not ([e41ba61](https://github.com/go7studio/Go7-Workhorse/commit/e41ba6173ac3154d8741110d28a5f439088a54bc))
* being smarter is free, paying more for it is not ([94595af](https://github.com/go7studio/Go7-Workhorse/commit/94595af417580d325b03dd15ca400f0fddcbc97a))
* buffer notifications until the host's framing is known ([af76551](https://github.com/go7studio/Go7-Workhorse/commit/af765518b722871eedd601c6a38eea420b1c8971))
* forbidding a bot is not naming it ([0142817](https://github.com/go7studio/Go7-Workhorse/commit/0142817affbf503b9acb2c0cad1adf57d370a925))
* forbidding a bot is not naming it ([63ad34f](https://github.com/go7studio/Go7-Workhorse/commit/63ad34f965a1cbef0620e195197fa1bfc703ebd2))
* latch the settled flush, and stop racing fs.watch in a test ([f99a6ab](https://github.com/go7studio/Go7-Workhorse/commit/f99a6ab7f41df109ee35499c11f59911fe4e6755))
* the completion notification stops promising a report it never sent ([907893e](https://github.com/go7studio/Go7-Workhorse/commit/907893e68c6104700ece7449da8b747ba295bf7b))
* the completion notification stops promising a report it never sent ([39eb1fe](https://github.com/go7studio/Go7-Workhorse/commit/39eb1fe7a9ee05a1f226b55f98ac8f4db7457455))

## [0.6.38](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.37...v0.6.38) (2026-08-25)


### Bug Fixes

* keep Grok Bot shim registered across updates ([1a788ca](https://github.com/go7studio/Go7-Workhorse/commit/1a788ca6778f637ab5a51fa138a8096bd9f37425))
* keep Grok Bot shim registered across updates ([f2c5a7c](https://github.com/go7studio/Go7-Workhorse/commit/f2c5a7cb7357c984b5d84778ed8c4fb12efb4d7a))

## [0.6.37](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.36...v0.6.37) (2026-08-25)


### Bug Fixes

* make Grok Bot webhook replies durable ([8465683](https://github.com/go7studio/Go7-Workhorse/commit/8465683aef2b80c881fde95de6ddea6ae2430be2))
* make Grok Bot webhook replies durable ([77c9beb](https://github.com/go7studio/Go7-Workhorse/commit/77c9bebea3ef413de291dc36f310da9e2cd32ccd))

## [0.6.36](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.35...v0.6.36) (2026-08-25)


### Bug Fixes

* preserve Grok Bot identity through Link delegation ([9386df6](https://github.com/go7studio/Go7-Workhorse/commit/9386df6d503d50b62c61a0e62f033d906b630ea4))

## [0.6.35](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.34...v0.6.35) (2026-08-25)


### Features

* add durable local capability plane ([9af01b9](https://github.com/go7studio/Go7-Workhorse/commit/9af01b91529abaf8ff08687eaee4f2598655d88b))
* connect Grok Bot instant chats ([b2033cd](https://github.com/go7studio/Go7-Workhorse/commit/b2033cd56f607818ebcee99e7f7ee875882a2f63))
* expose scoped MCP tools to local models ([5f05206](https://github.com/go7studio/Go7-Workhorse/commit/5f052064f609da3f6b051ef1dab4b4a2981ef8da))


### Bug Fixes

* collapsing a project hides its worker list ([d832059](https://github.com/go7studio/Go7-Workhorse/commit/d83205998eddaa791f1f703280c6f60dab2752bc))
* collapsing a project hides its worker list ([473b91a](https://github.com/go7studio/Go7-Workhorse/commit/473b91a1e0993b206c29b4f2bc38917cbca376b2))
* keep Grok Bot instant replies optional ([97cc859](https://github.com/go7studio/Go7-Workhorse/commit/97cc859c46235e10f514075034b7e9993ae02f49))
* keep walkthrough media out of the app ([7e0ae17](https://github.com/go7studio/Go7-Workhorse/commit/7e0ae175b00a64df6e71c628e66b43b7936fa1d4))
* Link accepts Grok Bot handoff spelling ([351b389](https://github.com/go7studio/Go7-Workhorse/commit/351b389996f54d06e872f04c7d94b5393cec3340))
* queued prompts stay on Next, not in the transcript ([0387326](https://github.com/go7studio/Go7-Workhorse/commit/0387326984aa03ad23080c260b3616749c657d15))
* queued prompts stay on Next, not in the transcript ([f4efc02](https://github.com/go7studio/Go7-Workhorse/commit/f4efc027e54bf8d08a8b81e607f69ae711ecf3fe))

## [0.6.34](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.33...v0.6.34) (2026-08-24)


### Features

* record trustworthy routing evidence ([13b5a10](https://github.com/go7studio/Go7-Workhorse/commit/13b5a10ccb87be00695c04f5c69381cce01b1311))


### Bug Fixes

* Grok 4.6 is ACP Grok, not Grok Bot ([9ef2f08](https://github.com/go7studio/Go7-Workhorse/commit/9ef2f08738489dd29c45873e12e3286e51678adb))
* Grok Bot is a calling harness, not an inherited worker ([a62c81c](https://github.com/go7studio/Go7-Workhorse/commit/a62c81c67e3413fb35c9ac170a2d5c3ae9add564))
* honor explicit worker model identity ([650c082](https://github.com/go7studio/Go7-Workhorse/commit/650c08277570318938d2d9eb3d2c42950ab73318))
* keep Grok 4.6 off Grok Bot and idle parents off Failed ([8d05d0d](https://github.com/go7studio/Go7-Workhorse/commit/8d05d0d103dd797611a8d7b91d1cc4cd46eb8720))
* keep worker routing identity truthful ([ed66d2f](https://github.com/go7studio/Go7-Workhorse/commit/ed66d2f7f37a65a05b6bc19f958948d8ddd414e1))
* nested Auto spawn cannot allocate grok-bot ([9f6e23b](https://github.com/go7studio/Go7-Workhorse/commit/9f6e23b8a57cc98cd1784802570680879ba784a3))
* separate Grok client from model identity ([dd620c0](https://github.com/go7studio/Go7-Workhorse/commit/dd620c01fa49a1679244ac6ff665e65940920936))

## [0.6.33](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.32...v0.6.33) (2026-08-23)


### Bug Fixes

* a desk on an isolated profile must not take over the shim keepalive ([1adecc5](https://github.com/go7studio/Go7-Workhorse/commit/1adecc515e20246fe8f2db91531e102bb549a72d))
* a desk on an isolated profile must not take over the shim keepalive ([428ac2d](https://github.com/go7studio/Go7-Workhorse/commit/428ac2d7a304c8217b5825f12864b88e79d9639b))
* drop the import the deterministic rewrite left behind ([6f2b913](https://github.com/go7studio/Go7-Workhorse/commit/6f2b913b380f015bebcaf4d13f335220190e44bd))
* report only the project folders that are there ([dfd2b32](https://github.com/go7studio/Go7-Workhorse/commit/dfd2b321e132c5da9a38d5553a51b849bce0fc40))
* report only the project folders that are there, and stop naming a private project ([4d36249](https://github.com/go7studio/Go7-Workhorse/commit/4d36249b4d423bdf60757dcd384041da6f1b1f51))
* run a chat in a project folder that exists, and name the one that does not ([15041f9](https://github.com/go7studio/Go7-Workhorse/commit/15041f9b22b1c3d117695616c814e45d3949dc3d))
* run a chat in a project folder that exists, and name the one that does not ([1a0bd21](https://github.com/go7studio/Go7-Workhorse/commit/1a0bd21f8c7ba240fd514d937952880e2ca8dcb0))
* the terminal, worktree button and Codex probe pick a live folder too ([d17ee07](https://github.com/go7studio/Go7-Workhorse/commit/d17ee0792215b5b71b9ad09a7eabeaf6727365b4))
* the terminal, worktree button and Codex probe pick a live folder too ([1fe51ee](https://github.com/go7studio/Go7-Workhorse/commit/1fe51ee8ea4811813d1aa623c5fbceb0faa58e68))

## [0.6.32](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.31...v0.6.32) (2026-08-22)


### Bug Fixes

* stop the Grok Bot shim before Windows NSIS replace and stamp Windows releases ([#150](https://github.com/go7studio/Go7-Workhorse/issues/150)) ([3f9a082](https://github.com/go7studio/Go7-Workhorse/commit/3f9a08244c932cbc4a5eaa1142fe8c5509ab6c9a))

## [0.6.31](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.30...v0.6.31) (2026-08-22)


### Bug Fixes

* book Cursor Composer/API tokens and keep reused worker thinking level ([#148](https://github.com/go7studio/Go7-Workhorse/issues/148)) ([7bbc92d](https://github.com/go7studio/Go7-Workhorse/commit/7bbc92d3469a9b6be44c0c85add88d57db1433a2))

## [0.6.30](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.29...v0.6.30) (2026-08-22)


### Bug Fixes

* keep permission asks short when Grok titles a command ([#146](https://github.com/go7studio/Go7-Workhorse/issues/146)) ([45a1b19](https://github.com/go7studio/Go7-Workhorse/commit/45a1b19822b2a658175fb23a6c2b4acb9a12208e))

## [0.6.29](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.28...v0.6.29) (2026-08-22)


### Bug Fixes

* keep Orchestrate transcripts visible while workers stream ([#145](https://github.com/go7studio/Go7-Workhorse/issues/145)) ([ec6632a](https://github.com/go7studio/Go7-Workhorse/commit/ec6632af4c38c14b3914a2c17a501cb714235201))
* remove stale Grok Bot usage snapshots ([0eb6b73](https://github.com/go7studio/Go7-Workhorse/commit/0eb6b737560b5ef4154d1b18cd215126b90266b9))
* restore Grok Bot leftover reader ([#144](https://github.com/go7studio/Go7-Workhorse/issues/144)) ([37ece8a](https://github.com/go7studio/Go7-Workhorse/commit/37ece8a73ba6688df64751d3fcad6526418cd9e5))

## [0.6.28](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.27...v0.6.28) (2026-08-22)


### Bug Fixes

* stop stale Grok Bot shim during Mac updates ([7e28d4a](https://github.com/go7studio/Go7-Workhorse/commit/7e28d4ab7d34bcf59b01f302a791630d2461cd63))

## [0.6.27](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.26...v0.6.27) (2026-08-22)


### Bug Fixes

* keep desk saves durable when vault is locked ([06898e7](https://github.com/go7studio/Go7-Workhorse/commit/06898e794a589814d0912eb2bdd384cffffd0a2e))

## [0.6.26](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.25...v0.6.26) (2026-08-22)


### Bug Fixes

* read Grok Bot capacity from snapshot ([284cd8e](https://github.com/go7studio/Go7-Workhorse/commit/284cd8ed0ce01b1ceabfc956e68bb6b447a85f99))

## [0.6.25](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.24...v0.6.25) (2026-08-22)


### Bug Fixes

* show Grok Bot usage snapshot age ([ca4cd76](https://github.com/go7studio/Go7-Workhorse/commit/ca4cd7688dd7f9938c9c52c8f82e2678f556df59))

## [0.6.24](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.23...v0.6.24) (2026-08-22)


### Features

* ship authenticated Grok Bot Link and truthful usage ([23c83ac](https://github.com/go7studio/Go7-Workhorse/commit/23c83ac123a08fd75de13574c38e73c17217f2be))
* Workhorse owns the Grok Bot loopback shim on Mac and Windows ([65055d2](https://github.com/go7studio/Go7-Workhorse/commit/65055d2a23eeb13b76700be6c553bb8ed1aaae08))


### Bug Fixes

* age stale Grok Bot leftover to unknown ([c11cf56](https://github.com/go7studio/Go7-Workhorse/commit/c11cf567d0452ddf38c1f8fe36d155045e98f501))
* keep Grok Bot usage fresh without polling ([963ffc2](https://github.com/go7studio/Go7-Workhorse/commit/963ffc2613b61f5ff83900cb38968547ea1fe06f))
* require a per-install loopback token on the Grok Bot shim ([1dcdc4e](https://github.com/go7studio/Go7-Workhorse/commit/1dcdc4e29a5143c534bb90ed9f23a306da1cc9aa))

## [0.6.23](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.22...v0.6.23) (2026-08-21)


### Bug Fixes

* map Grok Bot weekly leftover into capacity ([7d09b24](https://github.com/go7studio/Go7-Workhorse/commit/7d09b24838240a86c1b4fc5c750f3d78da23438c))
* map Grok Bot weekly leftover into capacity ([ec40970](https://github.com/go7studio/Go7-Workhorse/commit/ec40970c1795648535ab7c09abbde0fe3f3a5fff))

## [0.6.22](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.21...v0.6.22) (2026-08-21)


### Features

* pin Orchestrate and Mission from the composer + menu ([9a7156a](https://github.com/go7studio/Go7-Workhorse/commit/9a7156a8858169eba3397b75fecc425a876c7c07))
* pin Orchestrate and Mission from the composer + menu ([3aa9f57](https://github.com/go7studio/Go7-Workhorse/commit/3aa9f57c0167a45f1924a1e533f3846fef5f64be))


### Bug Fixes

* Cursor-style project folders toggle closed without leaving the chat ([7e7cd8a](https://github.com/go7studio/Go7-Workhorse/commit/7e7cd8ad29725d52fc390dec529116c227e0ca8f))
* drop the crew-dot preview card from the sidebar ([baf8c72](https://github.com/go7studio/Go7-Workhorse/commit/baf8c72610021a05de65bf09cee8cb293fc1a22e))
* drop the loose Chats list under Projects ([40f401a](https://github.com/go7studio/Go7-Workhorse/commit/40f401a3c66b5442ad07c893d49f441a37569b91))
* keep cancelled workers, leftover, and generic titles honest ([6c8c199](https://github.com/go7studio/Go7-Workhorse/commit/6c8c1998dcc3a076b192cf0aca826021f8347fd3))
* keep model and effort on a running chat instead of Working ([5740e85](https://github.com/go7studio/Go7-Workhorse/commit/5740e8550477b4a314a3e849c1703d09f4392377))
* keep the open chat listed when its project folder is closed ([b26a9cd](https://github.com/go7studio/Go7-Workhorse/commit/b26a9cd68262f0ea7cd4412da6bbf4fea578e3ba))
* lift Changes above a queued prompt so it does not overlap ([8ab377d](https://github.com/go7studio/Go7-Workhorse/commit/8ab377d36287963c2ab81709c446b833417c8e28))
* open project folder is a tray, chevron on whole-row hover ([ddf8805](https://github.com/go7studio/Go7-Workhorse/commit/ddf88058cc1a67e460f43caf8e3f20317fb623c8))
* project rows show a folder that becomes a chevron on hover ([e6069e5](https://github.com/go7studio/Go7-Workhorse/commit/e6069e59e56afc90d1cd70b0b12a3d8a51ad2261))
* show crew status on the vendor dot, not as words ([dd2dd7b](https://github.com/go7studio/Go7-Workhorse/commit/dd2dd7be825ddabf3c91c458eb4f85cc1a7f36b9))
* show only the project name on sidebar folders ([7d0a1d3](https://github.com/go7studio/Go7-Workhorse/commit/7d0a1d32d1c00177d07d82081d920ff5765cb423))
* show the chevron only while the pointer is on the project row ([36ad1d0](https://github.com/go7studio/Go7-Workhorse/commit/36ad1d07779e0632293a3c3c1a03b0c858728309))

## [0.6.21](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.20...v0.6.21) (2026-08-21)


### Features

* add a Grok Bot custom HTTP preset on loopback ([4898859](https://github.com/go7studio/Go7-Workhorse/commit/4898859d31e34cc2a997155229faec18e7ab3729))
* copy a Grok Bot one-shot for Workhorse Link ([c7b3be3](https://github.com/go7studio/Go7-Workhorse/commit/c7b3be3ae9b5a8c7cafe3392b21b7989cbfed95b))
* copy a Grok Bot one-shot for Workhorse Link ([6061d0d](https://github.com/go7studio/Go7-Workhorse/commit/6061d0de07d2516f1c9a39bf79c6721c9dadd9f0))
* Grok Bot custom HTTP preset on loopback 8787 ([ac20693](https://github.com/go7studio/Go7-Workhorse/commit/ac2069326453d77efaf866179d25afba0947343f))
* Grok Bot is a Workhorse Link host with auto-approved tools ([254c7bf](https://github.com/go7studio/Go7-Workhorse/commit/254c7bf0766f4bca14ec11a768e37233be394ea4))
* Grok Bot one-shot auto-approves Workhorse Link tools ([5cc0e24](https://github.com/go7studio/Go7-Workhorse/commit/5cc0e2487eb7a5d21ea53386b191ab71d3949791))
* map Grok Bot as a Workhorse Link host ([5b1810b](https://github.com/go7studio/Go7-Workhorse/commit/5b1810b557e0a55302ba62eba5a925182d4b94b5))


### Bug Fixes

* compact Link chat list so host output caps do not clip it ([f07c345](https://github.com/go7studio/Go7-Workhorse/commit/f07c3451fb04cd1e798b79e07eee2b717aa78c0c))
* compact Link chat list so host output caps do not clip it ([5de7684](https://github.com/go7studio/Go7-Workhorse/commit/5de76846ac35893a9b487aa1bc4b2d179347ed09))
* Grok Bot fail-closed is port 8787 only ([86f019f](https://github.com/go7studio/Go7-Workhorse/commit/86f019f2f8b533cc70a97a467c57cc58f73472b6))
* Grok Bot one-shot names this computer, Mac or Windows ([641293d](https://github.com/go7studio/Go7-Workhorse/commit/641293df95ba4388e8dbbb1f58b004e920e02de6))
* keep the Mac Dock icon after replacing the app ([f9f52ef](https://github.com/go7studio/Go7-Workhorse/commit/f9f52ef695291b4dba5c782c81fc9cf3240ec7b0))
* keep the Mac Dock icon after replacing the app ([93be7e5](https://github.com/go7studio/Go7-Workhorse/commit/93be7e560f8c92d4f0e2404bac7b289512cee13c))

## [0.6.20](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.19...v0.6.20) (2026-08-21)


### Features

* assign a Link mission loop and later read the report ([83b20d3](https://github.com/go7studio/Go7-Workhorse/commit/83b20d36a9fafb1639f07fdc7796a0c5ca021c88))


### Bug Fixes

* Link follow-through is the same from every host ([1d60cbb](https://github.com/go7studio/Go7-Workhorse/commit/1d60cbbebe1a95484d0a2a71cef95d479bb91f07))
* Link follow-through is wait, done, or failed ([100e44e](https://github.com/go7studio/Go7-Workhorse/commit/100e44ea7c9e73d9b6b7a562f8b4d40f34100db3))
* show Auto effort, settle empty replies, route image gen to Grok ([ec98923](https://github.com/go7studio/Go7-Workhorse/commit/ec9892306aa871e9e2197ed7e22d1d81c52aa9d3))
* show Auto effort, settle empty replies, route image gen to Grok ([67d8537](https://github.com/go7studio/Go7-Workhorse/commit/67d8537498f1e410d39e66d4985e92080e0db10e))


### Performance Improvements

* keep large desks and live streams responsive ([cb1bbec](https://github.com/go7studio/Go7-Workhorse/commit/cb1bbec46126469f92b85c0ef78b3b5e51714243))

## [0.6.19](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.18...v0.6.19) (2026-08-20)


### Bug Fixes

* stream chat images and stop Codex first-open freeze ([#120](https://github.com/go7studio/Go7-Workhorse/issues/120)) ([16f3035](https://github.com/go7studio/Go7-Workhorse/commit/16f303512bfca9bc784281b209cb832aa68d7ce5))

## [0.6.18](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.17...v0.6.18) (2026-08-20)


### Bug Fixes

* a silent Codex worker cannot look finished ([3a0362e](https://github.com/go7studio/Go7-Workhorse/commit/3a0362e9ffeac1ee39d3c3d013111e4e1d76da57))
* assign Fable by cost and extra pool, not a lower score ([3804e02](https://github.com/go7studio/Go7-Workhorse/commit/3804e0265a3d4e4af6e9157abbedb3e4612cb5b8))
* cap Chromium caches, copy state backups, and prune dead worktrees ([6e97362](https://github.com/go7studio/Go7-Workhorse/commit/6e973627abcae842bf42a306fcbacf300e665046))
* cap Chromium caches, copy state backups, and prune dead worktrees ([d25c8f0](https://github.com/go7studio/Go7-Workhorse/commit/d25c8f08c5e5c4e5d2abfb0a20966f3c7c669d05))
* clear leftover update caches and stop fsyncing every hot save ([3adb805](https://github.com/go7studio/Go7-Workhorse/commit/3adb80578a680787553627c4aa7593d9e869610f))
* clear leftover update caches and stop fsyncing every hot save ([3558c0f](https://github.com/go7studio/Go7-Workhorse/commit/3558c0fef5f80829b148e1f8169bc44acf261d62))
* one bounded spawn, Claude default stays Sonnet 5 ([e6536c4](https://github.com/go7studio/Go7-Workhorse/commit/e6536c403a1cbc2d08a71be9d6087a35f2aaee4c))
* rank each spawn by intelligence, do not pin Claude ([a811ab6](https://github.com/go7studio/Go7-Workhorse/commit/a811ab60cc9c57bd2c7887cd692f2d7c7f7fb7fa))
* rank spawn by intelligence, assign Fable by cost ([3b70f6a](https://github.com/go7studio/Go7-Workhorse/commit/3b70f6afc951241af02f0ea0538ff73d25cb47da))

## [0.6.17](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.16...v0.6.17) (2026-08-20)


### Bug Fixes

* an uncapped plan reads ∞, and a metered week is no longer hidden ([5007010](https://github.com/go7studio/Go7-Workhorse/commit/50070106d9dac24ee27d89a036ad3ee4b880d2dd))
* an uncapped plan reads ∞, and a metered week is no longer hidden ([4b5f975](https://github.com/go7studio/Go7-Workhorse/commit/4b5f975c5391caa48c5f955bb9530ba353183e95))
* routing knows what the work is about ([fa412c3](https://github.com/go7studio/Go7-Workhorse/commit/fa412c36c8735b6809baa5a07bde7bf8651f8c6a))
* routing knows what the work is about ([5ed41e0](https://github.com/go7studio/Go7-Workhorse/commit/5ed41e02c05e2490fcdc6d62b0466f823df54230))

## [0.6.16](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.15...v0.6.16) (2026-08-20)


### Bug Fixes

* keep Codex skill notices out of replies ([87b5a81](https://github.com/go7studio/Go7-Workhorse/commit/87b5a8136f2359e4111f84a224e6f8cdc33e340f))
* keep folder-bound workers active ([e89009a](https://github.com/go7studio/Go7-Workhorse/commit/e89009a5a792f3149472558cd438a89f8fea1038))
* order live chats by recent activity ([26ce074](https://github.com/go7studio/Go7-Workhorse/commit/26ce07433624c223140570e1a2fe734312308459))
* routing respects the context window, and history stays bounded ([4826f0a](https://github.com/go7studio/Go7-Workhorse/commit/4826f0ac23c9226d5b8984003a961c15b469edce))
* routing respects the context window, and history stays bounded ([cf3efda](https://github.com/go7studio/Go7-Workhorse/commit/cf3efda63a100a19ea79d12e8b39724988b050aa))

## [0.6.15](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.14...v0.6.15) (2026-08-20)


### Features

* routing tells models apart, and free capacity is a filler, not a merit ([8c0bf53](https://github.com/go7studio/Go7-Workhorse/commit/8c0bf53bed360625745702fb96d8f2f2f5fb3429))
* routing tells models apart, and free capacity is a filler, not a merit ([bd0a81e](https://github.com/go7studio/Go7-Workhorse/commit/bd0a81e98e90ef9d010d9ade65464b81dabbd4ec))


### Bug Fixes

* drop unused MCP allow import so typecheck passes ([1a8e6c2](https://github.com/go7studio/Go7-Workhorse/commit/1a8e6c292e6300335dbf66fe2737a53cc64f13a6))
* keep session rules off one machine's folders ([59f04a2](https://github.com/go7studio/Go7-Workhorse/commit/59f04a272932c5224d789aea780e91f73fe29209))
* keep session rules off one machine's folders ([c59d1cc](https://github.com/go7studio/Go7-Workhorse/commit/c59d1ccb3d0a181acf9ddf7b99660824aa8d8b03))
* unbound chats start in the desk base instead of failing ([9e67867](https://github.com/go7studio/Go7-Workhorse/commit/9e67867066e36b73de0cfb08c8c0e7ee838e374a))
* unbound chats start in the desk base instead of failing ([53680f0](https://github.com/go7studio/Go7-Workhorse/commit/53680f0d7e53257863e3b54d0cac35c7c0344c05))

## [0.6.14](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.13...v0.6.14) (2026-08-20)


### Bug Fixes

* book every Codex request including worker sessions ([1eb8dae](https://github.com/go7studio/Go7-Workhorse/commit/1eb8dae6a60ba65bed850d77fe332541e363f859))
* Clear look, last chat, short tools, and Codex usage bills ([c14cd4f](https://github.com/go7studio/Go7-Workhorse/commit/c14cd4f48ee5b3484416483445c4680d2c1335e3))
* open the last thought or tools fold when Worked expands ([455e3c7](https://github.com/go7studio/Go7-Workhorse/commit/455e3c765cb68770797c531a74870e23ce5d6678))
* recover Worked fold after a duplicate-name compile crash ([6b0a6c2](https://github.com/go7studio/Go7-Workhorse/commit/6b0a6c2a3b1b9129f3e63c18c4627ff6fdc039a8))
* ship the Clear transcript look and ease work folds open ([0906283](https://github.com/go7studio/Go7-Workhorse/commit/0906283709126d211c93c350c2a74a966ce67874))
* short MCP tool names, last chat on project click, report-back clock ([a372a45](https://github.com/go7studio/Go7-Workhorse/commit/a372a45d0d97990c623b7dda6b960586f345c408))

## [0.6.13](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.12...v0.6.13) (2026-08-20)


### Features

* assign Auto and spawn from one family table and job tier ([c748c34](https://github.com/go7studio/Go7-Workhorse/commit/c748c34250e354ee0256110f2db4acbdb688bc02))
* collapse Cursor live models into family bases for routing ([3a16613](https://github.com/go7studio/Go7-Workhorse/commit/3a1661313c1572e94eb5ac6e4324e25c98f09188))
* **sidebar:** say who ran a wave and how it went, on the chat row ([1ca3d01](https://github.com/go7studio/Go7-Workhorse/commit/1ca3d019dd17f7ee5fc7948fab19436f51b9e9fe))
* **sidebar:** say who ran a wave and how it went, on the chat row ([804d9d7](https://github.com/go7studio/Go7-Workhorse/commit/804d9d7c75ef8c6a3717bf39bc8c28f16b65b2bb))


### Bug Fixes

* a dead worker takes no new work, and reuse stays inside its wave ([772f3b0](https://github.com/go7studio/Go7-Workhorse/commit/772f3b05c2495183052df8a3e9776884aecae5b9))
* a dead worker takes no new work, and reuse stays inside its wave ([6afe8fe](https://github.com/go7studio/Go7-Workhorse/commit/6afe8feadfcf3237a835c356984a12b6441c929a))
* a wave says who asked for it, what it is, and how it really went ([1ff88a0](https://github.com/go7studio/Go7-Workhorse/commit/1ff88a007d4aa18904ac36ad1416b26f3beff734))
* **mcp:** let a harness attach every file type the desk takes ([fd88545](https://github.com/go7studio/Go7-Workhorse/commit/fd885453ba4150db9fcfc7a2561bdb6f29cc5c2c))
* **mcp:** let a harness attach every file type the desk takes ([7745af1](https://github.com/go7studio/Go7-Workhorse/commit/7745af176a119c55615c1104a30a0ffb74f8e772))
* **mcp:** let a harness mark a slice an auditor, so the check routes deep ([8f1311f](https://github.com/go7studio/Go7-Workhorse/commit/8f1311f237964982299c3020caca9b6f7aeb0f1a))
* **mcp:** let a harness mark a slice an auditor, so the check routes deep ([fa17043](https://github.com/go7studio/Go7-Workhorse/commit/fa17043a7eb2e2d5fa1a2852302fba8c8555dcbd))
* reuse a worker on purpose, not because one was idle ([498dae5](https://github.com/go7studio/Go7-Workhorse/commit/498dae57c11071be9233ead0c41f9650212ca0d6))
* reuse a worker on purpose, not because one was idle ([7e8ab60](https://github.com/go7studio/Go7-Workhorse/commit/7e8ab60df1e14570183597ea0bf4009e0848b921))
* score Gemini as Gemini, not as mini ([1b9f79c](https://github.com/go7studio/Go7-Workhorse/commit/1b9f79cca99955c598a2f848df33cf6c7da284d9))
* spawn job typing ignores parent Auto tier; rank verified Learning outcomes ([3261acf](https://github.com/go7studio/Go7-Workhorse/commit/3261acf7bfa306f11d5fc5affb0069ef67f66578))
* **types:** declare the spawn role store.tsx already reads ([e08929a](https://github.com/go7studio/Go7-Workhorse/commit/e08929a095ea07d6ab07bb59e84cf2adf663946b))

## [0.6.12](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.11...v0.6.12) (2026-08-20)


### Bug Fixes

* keep earlier turns on screen when a new prompt is sent ([737b8bb](https://github.com/go7studio/Go7-Workhorse/commit/737b8bb4f9e3de1dca02f51e5d56efb734f7d913))
* keep earlier turns on screen when a new prompt is sent ([0e8a64e](https://github.com/go7studio/Go7-Workhorse/commit/0e8a64ee4137fee621ab2965b42967e5e4133a5f))

## [0.6.11](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.10...v0.6.11) (2026-08-20)


### Bug Fixes

* ease earlier turns in one at a time ([e9824c9](https://github.com/go7studio/Go7-Workhorse/commit/e9824c9ab6df9c8730e2664ccc6092d3a4fb6cce))
* fill earlier turns before the user hits the top ([40dc37d](https://github.com/go7studio/Go7-Workhorse/commit/40dc37d1f760f677d267d293368678d0b1733ab8))
* hold the transcript still when earlier turns load ([7154ad9](https://github.com/go7studio/Go7-Workhorse/commit/7154ad976bd242a8b62b013a6e93e72865f7f346))
* hold the transcript still when earlier turns load ([9819e4d](https://github.com/go7studio/Go7-Workhorse/commit/9819e4dd54d0d11c99d65b97a833e19ac8c55f8b))
* let earlier turns paint above a live scroll ([8d0ee6a](https://github.com/go7studio/Go7-Workhorse/commit/8d0ee6a1c472310495b742496bd7f635635d42a0))
* load earlier turns when the user scrolls to the top ([53c4edd](https://github.com/go7studio/Go7-Workhorse/commit/53c4edd339c81e1225f92e2baae1bbd4dd92d26a))
* load earlier turns when the user scrolls to the top ([34a4c3e](https://github.com/go7studio/Go7-Workhorse/commit/34a4c3e1f30bcf88c0f226da7dff3f18540403dd))
* lock the transcript to the turn the user was looking at ([7a452f9](https://github.com/go7studio/Go7-Workhorse/commit/7a452f93a3d0a4cb921baa17eb3de81c789ab780))
* page earlier turns in windows of ten ([91ed65c](https://github.com/go7studio/Go7-Workhorse/commit/91ed65c1c92ca2c382e2480cca2841778afbcb42))
* remount the desk after a hot-reload crash ([ade10d9](https://github.com/go7studio/Go7-Workhorse/commit/ade10d9cb1d0de19c0977b24b76ab40411fd5091))

## [0.6.10](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.9...v0.6.10) (2026-08-20)


### Features

* group Add Bot presets by billing and add Vercel, Kimi Code, and Gemini ([36c7e24](https://github.com/go7studio/Go7-Workhorse/commit/36c7e24cb3f5feefde2c6628dc315c00537b0471))


### Bug Fixes

* a hand-fired release must still stamp channel=release ([387b3ad](https://github.com/go7studio/Go7-Workhorse/commit/387b3ad5fe63f1cf38eabcf7f8d6c0f675ed4182))
* persist spawned workers, and salvage the usable half of three branches ([8419ba4](https://github.com/go7studio/Go7-Workhorse/commit/8419ba4b4cc5b44c324c41ca07b7c13ca195fb09))
* **run:** hold a verify reserve, reset reused budgets, record takeover ([aa8cfbb](https://github.com/go7studio/Go7-Workhorse/commit/aa8cfbb4cdd5902e31207718629a4b43c6b91f2e))

## [0.6.9](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.8...v0.6.9) (2026-08-19)


### Features

* admit a plan step only after a sibling auditor ([c8b38a3](https://github.com/go7studio/Go7-Workhorse/commit/c8b38a3ee59caa5608969bf22eeb39c47ada2343))
* capture inbound Workhorse Link calls in Learning ([ed81fd8](https://github.com/go7studio/Go7-Workhorse/commit/ed81fd8606c615891806b7d3946ce8b44b13c71c))
* capture inbound Workhorse Link calls in Learning ([04f527d](https://github.com/go7studio/Go7-Workhorse/commit/04f527d0057c7d8096e80cee17545128b4865ad3))
* harden provider and eval durability ([9331de0](https://github.com/go7studio/Go7-Workhorse/commit/9331de04c3409bd592b33af6526f1d9031fb82ed))


### Bug Fixes

* auditor admission only covers builder steps ([aa83052](https://github.com/go7studio/Go7-Workhorse/commit/aa830527fdb5cc3e1997e82055a26f3353bacb36))
* bind work to exact session scope ([4da70d6](https://github.com/go7studio/Go7-Workhorse/commit/4da70d6a02197e623602a1d19455b401b3fcef98))
* **coordination:** accept valid mission passes that mix roles ([d408cf5](https://github.com/go7studio/Go7-Workhorse/commit/d408cf5793f6fa94c7d603effca3a199afd539ef))
* **coordination:** cap workhorse_await_agents to a short cursor poll ([b70dec3](https://github.com/go7studio/Go7-Workhorse/commit/b70dec3cced0f4cb3136926d799a24d777f329c2))
* **coordination:** desk-owned join and fail-closed routing ([7131fe0](https://github.com/go7studio/Go7-Workhorse/commit/7131fe0986ab49c0d976f81d6738afc808afe845))
* **coordination:** keep named workers as durable addresses ([e6267e0](https://github.com/go7studio/Go7-Workhorse/commit/e6267e031c4bad83d6a4598f190ad0f9969028a3))
* **coordination:** make cancel-agent cover worker sessions and external tasks ([4a1cc13](https://github.com/go7studio/Go7-Workhorse/commit/4a1cc13cdf1a597ef7d0f1fcad8ba896755b1133))
* idle reconciled workers after restart ([4366d03](https://github.com/go7studio/Go7-Workhorse/commit/4366d038d195d839fa87d6b424681506f1b31a84))
* ordinary plans stay human; product asks carry a default ([d61edcd](https://github.com/go7studio/Go7-Workhorse/commit/d61edcd7115acefc1de5c2d43a45c96e07c598b3))
* persist and reconcile long-running work ([03ad024](https://github.com/go7studio/Go7-Workhorse/commit/03ad02499c0035adf3f3d485c00ca53b1535eb87))
* reopen Windows in-app updates via Task Scheduler ([577e783](https://github.com/go7studio/Go7-Workhorse/commit/577e7835cc782cb8536cec2a3ab199f374a0ac94))
* reopen Windows in-app updates via Task Scheduler ([628e463](https://github.com/go7studio/Go7-Workhorse/commit/628e4635ffeef3cbd7a72ecfca64017a6aeee256))
* **routing:** derive period from real reset cadence, scale reserve by time-to-reset ([eb50225](https://github.com/go7studio/Go7-Workhorse/commit/eb502256d97961d519385bf3121f411dea0374ca))
* unbreak main and stop shipping 506MB of unreachable agent binaries ([be8ec88](https://github.com/go7studio/Go7-Workhorse/commit/be8ec886c5d5d8d9763b76bcdd8b903c5d8cd76c))
* worker token ceiling meters this slice, not the repo ([24fa642](https://github.com/go7studio/Go7-Workhorse/commit/24fa6426a60d4214fe030424945afe9d38d3893d))

## [0.6.8](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.7...v0.6.8) (2026-08-19)


### Features

* harnesses can query leftover as a read-only MCP tool ([d9785fb](https://github.com/go7studio/Go7-Workhorse/commit/d9785fbb7254f3ec4a5d04d665a9eab2054e400a))
* leftover query for harnesses, vaulted bots, and mesh gates ([b252a29](https://github.com/go7studio/Go7-Workhorse/commit/b252a298db4dc2fa08501cb4ce677fbe53724f88))
* standard leftover wiring for major custom hosts ([98c6a46](https://github.com/go7studio/Go7-Workhorse/commit/98c6a4636c5f1f2e7a442e043a8ff0ecb49bac3f))
* the workhorse command — Link's CLI on your PATH ([89efc4a](https://github.com/go7studio/Go7-Workhorse/commit/89efc4af01e68224d1dcf33c5371307bcc4ccf4e))
* Workhorse Link — one way in for every outside harness ([fe51c6a](https://github.com/go7studio/Go7-Workhorse/commit/fe51c6a07ab5dfade6d62e42d00c35a829b25b03))
* Workhorse Link — one way in for every outside harness ([0044a23](https://github.com/go7studio/Go7-Workhorse/commit/0044a23c8b998aebbed718816f0de59be7c6e9b8))


### Bug Fixes

* a named desk spawn does not pick a harness ([9725d67](https://github.com/go7studio/Go7-Workhorse/commit/9725d674164b43bf3d93282e3c3a7cc1b1106dfb))
* a named desk spawn does not pick a harness ([61d98f5](https://github.com/go7studio/Go7-Workhorse/commit/61d98f55ece2590fde429e5a125909801272055c))
* every mutating Link call carries the envelope, and the dead ends are gone ([68d82a0](https://github.com/go7studio/Go7-Workhorse/commit/68d82a09d63f0f09ea52e24c8d3dea3faa018314))
* every mutating Link call carries the envelope; the workhorse command ([605f5d4](https://github.com/go7studio/Go7-Workhorse/commit/605f5d4613f74555055d8da663d755cd75b82c32))
* idle a goal round once, and never on compact-done ([15de90c](https://github.com/go7studio/Go7-Workhorse/commit/15de90cd13b0998d59ea5a3113681db6200e3bc1))
* keep studio identity and signing material out of the repo ([90f97e5](https://github.com/go7studio/Go7-Workhorse/commit/90f97e59e68263234a7e0eadc87993617694a749))
* keep the update control beside Settings ([f910008](https://github.com/go7studio/Go7-Workhorse/commit/f91000883a586d8d39aaa076789c6f6fd94fc807))
* make usage metering authoritative ([88559c2](https://github.com/go7studio/Go7-Workhorse/commit/88559c295fbd8edd46a416198414181a6c4d8c65))
* privileged IPC channels answer only the desk window ([eee5201](https://github.com/go7studio/Go7-Workhorse/commit/eee5201c0eedb286f2ee2bb270ad683ae1e7f398))
* run goal rounds, the turn log, and compact occupancy on the live path ([9bf7eba](https://github.com/go7studio/Go7-Workhorse/commit/9bf7ebab5824ca447553621a2be25a33f3f4647a))
* the sandbox contains the real path, and the repo says what it protects ([a09138a](https://github.com/go7studio/Go7-Workhorse/commit/a09138a1ff4521dce3db7e33fa63743859d8b845))
* vaulted custom bots stay callable, and harness mesh uses one policy ([2651d19](https://github.com/go7studio/Go7-Workhorse/commit/2651d195bce02dce2a862d9d0a563af29185857b))

## [0.6.7](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.6...v0.6.7) (2026-08-19)


### Bug Fixes

* reopen Workhorse after a Windows in-app update ([#79](https://github.com/go7studio/Go7-Workhorse/issues/79)) ([eaa7441](https://github.com/go7studio/Go7-Workhorse/commit/eaa744136331d808fc69cb4c57fba0b7b188ea52))

## [0.6.6](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.5...v0.6.6) (2026-08-19)


### Features

* goal rounds, fresh worker loops, and a per-chat turn log ([69b56d5](https://github.com/go7studio/Go7-Workhorse/commit/69b56d5c7c59ef86772bfdc2f08443cde6d38dee))


### Bug Fixes

* close full eval orchestration gaps ([74e2c18](https://github.com/go7studio/Go7-Workhorse/commit/74e2c1847879ee6158cde9c4555ec38f4076de50))
* MiniMax leftover tracks and the Changes dock stays put ([#78](https://github.com/go7studio/Go7-Workhorse/issues/78)) ([48698e9](https://github.com/go7studio/Go7-Workhorse/commit/48698e95df2a4c1b346e5c85305b3d47911d5692))
* preserve fresh worker handoffs across MCP ([e638525](https://github.com/go7studio/Go7-Workhorse/commit/e638525ebfa3cb53b700c15fc4f0a2f78e385c8f))
* route approved API models and harness agents ([62630ce](https://github.com/go7studio/Go7-Workhorse/commit/62630ceec68c271bc94975e0e8469f7eca98c420))
* send the handoff, not the parent slice, to a fresh worker ([4f59a1e](https://github.com/go7studio/Go7-Workhorse/commit/4f59a1e65483a31200ce0e825ee0dc0905e6304c))

## [0.6.5](https://github.com/go7studio/Go7-Workhorse/compare/v0.6.4...v0.6.5) (2026-08-19)


### Bug Fixes

* make adaptive mission continuation reliable ([ba21a99](https://github.com/go7studio/Go7-Workhorse/commit/ba21a99e259724325d00bcc09f10a511baf24491))

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
