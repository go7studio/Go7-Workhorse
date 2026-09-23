# What Go7 Workhorse does

Every ability the desk has, in one place. Anything listed here ships on `main`.
When you add a feature, add it here in the same commit.

## What it is

- Go7 Workhorse runs Grok, Claude, Codex, Cursor and your own API bots in one
  desktop window, each under its own login.
- Set the bot, model and thinking effort per chat, or let the desk pick.
- Spawned workers copy this chat's Permission and Sandbox. A path allowlist
  still launches the vendor at Ask so writes can be preflighted; the worker
  chip stays Always if the orchestrator is Always. Always with Sandbox Off or
  Workspace skips that allowlist.
- Chat status is a tiled Workhorse mascot, a 3-by-3 grid with the bottom-right
  pixel sliver omitted. It rests as one seamless image that separates into tiles
  when work starts.
- Tiles separate and turn in their own cells while working. An intact horse
  tilts and double-nods for input.
- Stopped is a brief opposing vibration with the tiles suspended. Failure is a
  rocky collapse into a transparent loose pile at roughly 10% tile-edge overlap,
  a faint twitch, then reassembly.
- Stopped and failed are terminal: each plays once and holds its last pose.
- Only working and needs-you keep moving, and a chat at rest holds still, so a
  desk of idle chats paints nothing.
- A finished run that left a thought or empty reply is at rest. The horse walks
  only while the chat or its agent run is actually still going.
- A worker thinking between tools stays working — not only while a command is
  in flight. The work fold, Steer, and the sidebar horse all follow that.
- Nested workers and Grok's own subagents stay working through thinking. The
  fold does not say done, and agent_status does not say the run finished,
  while the child still has work.
- A failed ask with no real chat does not mint a red "the other agent" card.
  The closed work line stays quiet instead of painting the whole fold failed.
- Only the failed mound overlaps. Every other motion keeps the pieces separated.
- The mascot wears its own bot's colour on every theme, so a row says which bot
  is working before you read it. That is the colour set for the bot in Settings,
  falling back to the vendor's own. Sidebar horses sit smaller than the header
  mark, and reduced-motion preferences keep static poses.

## Bots and logins

When the desk token, Claude CLI login, and outer environment are unusable, Claude can fall back to a readable Claude Desktop login on macOS and Windows.

| Bot | How it connects | Notes |
| --- | --- | --- |
| Grok | ACP over stdio | Runs the local Grok Build CLI |
| Claude | ACP over stdio | Runs the local Claude Code CLI |
| Codex | ACP, plus an App Server | App Server adds native history and capability discovery |
| Cursor | ACP over stdio | Runs `cursor-agent` |
| Custom | HTTP | Any Anthropic Messages or OpenAI Chat Completions endpoint, hosted or local |

- Each vendor runs under its own login. Subscriptions, context and sandboxes are
  never pooled.
- Client and model are separate: **Grok Build CLI** runs the model ids
  **Grok 4.7**, **Grok 4.6**, and **Grok 4.5**.
- The CLI's live catalog is authoritative. The desk shows the model, never the
  client name.
- The desk keeps its own Claude token so signing in here never signs out your
  own Claude Code. If that token is refused, Claude falls back to the login the
  CLI already holds, and a meter the desk cannot read never stops a chat from running.
- Claude names its models at every session start, so new ones reach the picker
  at once.
- An id no list knows still counts when it names a vendor's family. Claude
  refuses by name rather than substituting.
- OpenClaw and Hermes are **harnesses**, not vendors. Settings → LLMs shows each
  runtime and selects its callable agents.
- A plan grants agents for one wave, or you name `openclaw/main` or
  `hermes/<profile>`. Those tasks join the lineup, with no Usage ring.
- **Add a bot** lists MiniMax, Synthetic, OpenRouter, Groq, DeepSeek, Together,
  Fireworks, Hugging Face, Novita, Cerebras, AI/ML API, Vercel AI Gateway,
  Kimi Code, Gemini API, Grok Bot, and DGX Spark.
- Presets group as subscription plans, gateway credits or BYOK,
  direct API billing, and on this Mac.
- **DGX Spark** is a local OpenAI-compatible bot on `127.0.0.1:8788`. NVIDIA
  Sync is SSH: local-forward that port, paste the owner bearer, then Test API
  collects `/v1/models` so Qwen (and anything else the box is serving) can be
  ticked. The Spark gateway itself stays loopback-only.
- One custom connection approves several models. Chats and Auto use that list;
  Usage keeps one ring with separate model rows.
- Leftover pings only official key-only JSON meters: MiniMax, Synthetic,
  OpenRouter.
- DeepSeek, Novita, AI/ML API and Vercel AI Gateway fill a prepaid balance.
- Together, Fireworks, Groq, Hugging Face, Cerebras, Kimi Code and Gemini stay
  unknown until those hosts publish leftover JSON.

### Grok Bot

- A local OpenAI-compatible shim on 127.0.0.1, model `grok-bot`, not Grok 4.7.
  Grok ACP (`grok-4.7`, `grok-4.6`, `grok-4.5`, `grok-build`) is a separate vendor.
- Auto does not allocate it as an orchestration or builder worker. It may call,
  analyze and dispatch.
- Workhorse keeps the Grok Bot loopback shim on that port on Mac and Windows,
  with a login keepalive and a restart.
- Each install mints its own loopback token. Other callers are refused, and the
  port binds loopback only.
- The webhook wake file `grok-bot-wake.json` is a different secret from the
  loopback token. Neither goes in git or bot memory.
- A separate weekly ring reads `grok-bot-leftover.json` beside `grok-bot-inbox`,
  taking numeric `usedPercent` with ISO `resetsAt` and `asOf`. Missing, invalid,
  expired or over-30-minute-old readings stay unknown.
- Workhorse never writes that file, and never folds Cursor Composer / Other
  Models monthly leftover onto this ring.
- The handoff wants fresh runtime values on launch, after work, and every 15
  minutes while active, never invented by a model.
- It fixes no model. The one you pick needs local MCP or CLI tool calling.
- The connection fails closed if the shim is down.
- Instant chat is an optional finishing step you can hide and finish later from
  Settings → LLMs.
- Its installed command lists only valid pending requests and accepts one
  matching reply atomically, so a routine cannot write an arbitrary inbox path
  or replace a different answer.
- Grok Bot is a cloud computer harness: its agents live on its own remote
  computer, with its own usage ring.
- Setup and keys: [docs/GROK-BOT.md](GROK-BOT.md).

## Chats and projects

- A project is a name. Folders and references are optional, added later.
- Chats belong to a project. Rename, archive, delete, or drag one to another.
- Vendor, model and thinking effort are set per chat, not per app.
- Changing This chat's model or effort drops the previous vendor session, so a
  resend to Grok 4.6 High actually goes there. The thinking timer starts over.
- A vendor session opens with your own prompt, so the vendor titles the chat
  from the task. A vendor that echoes the private context is rejected.
- Fork a chat to try another model on the same history, in a managed worktree
  when the project has a Git folder.
- Rewind to an earlier turn.
- While a turn runs, Enter queues the next prompt on Next. Steer interrupts and
  sends now, and the chat never says Stopped.
- A finished turn stays finished. Trailing thought after the vendor returns does
  not walk the horse again.
- A long transcript opens on the latest turns and pages older windows without
  jumping.
- A portable transcript follows a chat when its vendor changes.
- Search runs over chat titles and message text across every project.
- Each row shows the age of the last prompt as `25m`, `2h` or `3d`. Hover for
  the full time.
- A parent folds its workers on the count button, and closing the project hides
  them even when it stays pinned.
- A project row shows its info and new-chat buttons when the pointer, the
  keyboard or the selection is on it, and keeps their space at rest.
- A crew chip in the composer shortens its name with an ellipsis rather than
  cutting it off at a narrow window.
- A chat that ran a wave says who called it and how it went, such as
  `OpenClaw · Working…`, or nothing once every worker finished clean.
- Failure is the only word in red. Interrupted and timed-out work is unfinished,
  not wrong.
- A wave that came in over Link takes the work's own name when its workers agree
  on one.
- User and assistant turns use the same clock.
- A turn's work stays on one line while it runs, named for the live action
  (`Working · 19s · Read GOAL.md`).
- When it ends, that line lists the tools (`Worked 19s · Read · Grep`) or the
  crew (`Worked 38s · Hazel · Piper`). Open it for think, tools, think.
- Consecutive calls share one fold labelled "3 tools"; a single call shows its
  name, and a later thought starts a new hop.
- On a long turn, earlier thoughts and tools roll into an Earlier fold. The
  current hop stays open, the reply below.
- Grok tables keep their real columns. Empty `| |` chrome is dropped, and
  `foo.md (34441 chars)` still opens.
- Grok Build background **Tasks** and **Watchers** (a script or monitor the
  agent started) stay on the chat as a small strip: name, elapsed time, and
  whether they are still running or were killed. That is the Grok ACP session,
  not Settings → Watch leftover pools. Other vendors do not report this yet.
- **Attach** takes files or a folder. You can drag them onto the window or paste
  them in.
  - **Images** png, jpg, jpeg, webp, gif, bmp
  - **Audio** mp3, wav, m4a, aac, flac, ogg, opus, webm
  - **Video** mp4, mov, m4v, webm, avi, mkv
  - **Documents** pdf, doc, docx, ppt, pptx, xls, xlsx, rtf, odt
  - **Text and code** txt, md, html, css, json, xml, svg, csv, tsv, ts, tsx, js,
    py, rs, go, java, rb, php, c, cpp, cs, sql, yml, toml, sh, and the rest
  - **Folders** dropped whole, with dotfiles and build output skipped
- A chat reads media the agent wrote, so a generated image shows in the
  transcript, not a path.
- **Permission modes** ask, accept-edits, always-approve, plan.
- **Sandbox profiles** off, workspace, read-only, strict. Read-only still reads:
  gh, git and the search tools. Anything that writes or sends stops, and so does
  every interpreter, because a script cannot be read for what it will do.
- `gh api` is refused in every form. It reaches whatever the machine's GitHub
  token can reach, and the desk cannot bind a path gh resolves for itself.
- A gh read names no repository at all, by flag (`--repo`, `-R`, `--hostname`)
  or by argument (`owner/repo`, a URL, `owner/repo#3`), so a seat reads its own
  checkout and gh takes the repo from the remote.
- A git option naming a program, a path or a config is a write: `--exec-path`,
  `--upload-pack`, `-c`, `-C`, `--git-dir`. It decides what runs before the
  subcommand gets a say.
- A refusal names what the seat can run, so a worker asks for the right call
  rather than for the dial to move.
- **Scoped approvals** a grant remembers the exact tool, command and path for 24
  hours. Changed or expired requests ask again.
- **Execution directory** a chat starts in a linked folder or managed git
  worktree. The terminal can go elsewhere, and Review opens cited external files.
- A loose top-level chat can search from the desk base. Workers need an absolute
  folder.
- A project with several folders runs in the first one still on disk. When none
  is there, the chat names the missing folder.
- **Terminal** a shell scoped to that chat, in the same directory.
- **Review**, and the compact **Changes** control beside the composer, open the
  changed files and diffs. Click a row to open the file beside the chat or as
  the project-home pane.
- On the project home that card is full width and the list folds. `+0/−0` stays
  hidden, and line stats load in the background.
- **Change instances** a created file's lines stay green; a later prompt that
  deletes some keeps them as red instances. The baseline survives a restart.
- Paths outside the project folder, such as OpenClaw configs, still resolve from
  the cite.

## Missions and workers

- Ordinary worker waves end with a report. Finished or cancelled assignments cannot hire another checker without a new user request. Explicit running plans and Mission continuations retain their own lifecycle.
- Crew distinguishes active workers from finished history; sidebar counts include all worker chats.

- **Composer + menu** Orchestrate, Mission, and Debug pin on the chat in any
  combination. Each pin is a chip next to +; multiple pins collapse to a count
  you can expand.
- Orchestrate makes this chat the orchestrator, and it must spawn desk workers,
  fan-out only when asked. On its spawns Auto scores every bot for the task's
  domain at the thinking level it would run at, drops bots under the tier's bar
  (Balanced 4, Deep 8 on the strict scale below, never above the best bot the
  desk can call; Quick takes any bot and stops paying for quality at 4),
  and orders the rest by quality, cost, speed and plan terms: leftover about to
  expire, pace against the days left before the pool resets, the reserve, a 5h
  window close to full, and workers already running on the pool. A wave of
  spawns spreads over pools instead of piling onto one.
- Each tier weighs those differently, and Bot knowledge, `workhorse_find_bots`
  and the head's brief say how. Quick is fast and cheap first: any bot, quality
  counts up to 4, each doubling of run cost costs 0.9 points and each doubling
  of speed earns 0.6, plan terms count 1.5 times. Balanced needs 4, counts
  quality up to 7, and weighs cost 0.35, speed 0.25 and plan terms once. Deep
  needs 8, counts all of its quality, weighs cost 0.15, ignores speed, and plan
  terms count half.
- Speed is measured here: output tokens a second over each model's finished
  worker runs, from billed ledger rows only, against the desk's median. Until
  a model has three runs on the desk it reads its family's speed rating (5 of 5
  is one doubling up, 1 of 5 one down).
- An older model on the same plan gives way to a newer one of its line that
  can take the work and scores at least as well at it: on Cursor, Opus 5.5
  takes what Opus 4.7 or 4.6 would have, even when a coordinator named the
  older one. A model on another plan, or one the boards rate better at the
  task, keeps its place.
- What a task costs is weighed. Each model's input, output and cache-read list
  prices come from OpenRouter's public model list (no key, read once a day with
  the scores; a model it does not list reads its family's price tier). A
  typical finished run on this desk (the median fresh input, output and cache
  reads in its Usage ledger) is priced at them, and scaled by what the model's
  own runs take once it has three runs and the desk six. Each doubling of that
  cost over the cheapest bot that clears the bar and can take work now gives up
  quality: 0.9 points on Quick, 0.35 on Balanced, 0.15 on Deep, with no cap, so
  two dear bots keep their order. Bot knowledge, `workhorse_find_bots` and the
  head's brief show each bot's run cost.
- `workhorse_find_bots` is the orchestrator's search: give it the task and a
  squad size, and it returns the bots the desk would pick with each one's score,
  where the score came from, its plan terms, a squad spread over pools, and why
  the rest were not picked. It spawns and reserves nothing. Custom bots such as
  MiniMax M3 get it too, so any chat's head can staff a squad.
- A model name locks only when the user named it in their ask. A model the
  coordinator writes on the spawn is kept when it clears the domain bar (a
  `workhorse_find_bots` pick, say) and ranked away when it does not.
- A spawn may say what kind of work its slice is (`domain`: coding, image
  generation, writing, visual, data, general); otherwise the desk reads it from
  the prompt, and an ask for prose (a release note, a post, "under 120 words")
  is writing even when it names the code it is about.
- Each spawn reply names the bot that took the slice, and the reports that come
  back say which bot ran each one (`ran on`), so the head's "who did what" is
  read from the desk's record rather than remembered.
- A custom bot on an Anthropic-style endpoint, MiniMax's among them, gets its
  own thinking blocks back unchanged on every tool round, as those hosts
  require, so it keeps its plan from one round to the next.
- Either pin also hands the chat the spawn rules. An unpinned chat gets them
  the moment it is asked for workers, and opens lighter for not carrying them.
- If the ask is phrased in a way the desk does not read as a request for
  workers, the chat says the desk can put workers on it and waits for you,
  rather than hiring one under no rules. A bare yes after that wait is not a
  request for workers, so the desk refuses it again: pin the chat to
  Orchestrate or Mission, or ask again in spawn, worker, bot or agent words.
- One assignment is one worker, or a
  named continuation on this parent for the same topic; a bare spawn still
  starts clear-headed.
- A gear on that chip, or a right-click, lists which bots this chat may spawn.
- All bots is the default; a subset stays on this chat until you clear it, and a
  new chat starts at all again. Left-click still clears the pin.
- Mission is mission-board tracking for an adaptive loop, not a spawn request.
  Spawn a wave, then continue the rest with `workhorse_continue_mission`.
- With both pins on, the chat spawns as orchestrator, then continues unmet work
  as a mission.
- **Judge** (Settings → Routing, off by default). With it on, each finished
  mission report is scored by TypeSafe's Jev through your Vercel AI Gateway
  bot, with `typesafe-ai/jev` ticked on that bot: per acceptance criterion,
  shown, not shown, or unclear, from the report's own text. The score rides
  on `workhorse_agent_status` and `workhorse_await_agents` as `reportSays`,
  and the next pass is told what no report showed. It ran nothing and
  verified nothing, never removes a criterion, and a pass it could not score
  says so, with why. A report goes to the judge at most twice an hour;
  a new key, host or model list on the Vercel bot, or switching the judge
  back on, lets it be tried again. A call never waits past the status
  reply's own deadline. Its tokens are on the usage ledger under that bot,
  verdict or not; spend shows on that bot's credits.
- Debug makes the seated bot establish expected versus observed behavior,
  reproduce before editing, identify the actual source and runtime under test,
  preserve unrelated work, and verify the real artifact when packaging or
  rendering matters. Combined with Orchestrate or Mission, the desk adds the
  same protocol to every worker brief and plan auditor.
- Set a cost cap or a token cap under Mission, and the desk stops the mission
  before the next pass once the crew's spend reaches it, never mid-turn.
- Your field is a ceiling and never a default: where a call names its own cap
  the lower of the two runs the mission, dollars and tokens read apart, so a
  call may tighten your stop and never lift it, the call's number stands where
  you set no field, yours stands where the call sends none, and a continuation
  raises the call's own number only as far as your ceiling, or freely where you
  left the field blank.
- The crew tray shows direct workers, their model, effort and latest activity.
- Expand it to stop a worker or the crew, preview a worker chat, queue a
  follow-up, or open the full chat. Drafts stay local while you type.
- Cancelling one worker stops that worker only, and the wave is not called
  finished while others run.
- **Subagents** get lifecycle records, cascading cancellation, changed-file
  review, and isolation that follows the parent chat's workspace: an isolated
  worktree parent mints a worktree; a local parent keeps children in that folder.
- The desk does not stop a worker on a token ceiling or a runtime
  limit. Billed spend for that chat and each orchestrated bot is on the left of
  the transcript.
- A reused worker starts a new slice count; billed usage for the chat is the
  lifetime total.
- Finished work older than a week moves to the transcript store and opens as
  before. Settings → Profile sets the days, and nought keeps every row in the
  desk file.
- A finished or interrupted worker's folder goes a week after the worker
  ends. Work no commit or remote holds is kept in git first, byte for byte and
  with what the worker staged, at `refs/workhorse/rescue/<chat>`, and resuming
  or reusing the worker brings the folder back with that work uncommitted and
  its staged changes staged. Only a rescue the desk wrote down is ever
  restored. A folder git cannot save whole (a large file, a nested repository,
  a submodule, ignored files nothing shows are a cache) stays, named with the
  reason, and Settings → Profile lists what the last sweep kept. Only links,
  Godot's editor cache, TypeScript's build record and Python bytecode count as
  a cache, each read by what it holds. A folder's name counts for nothing, so
  an installed `node_modules` keeps the folder.
- A worker that ends with uncommitted files in its own folder says so in the
  chat that sent it. A folder made in the last hour is never swept.
- If the parent does the work itself, the run records that it took over.
- A cancelled or failed worker still reports to its parent, in one line naming
  the worker, what happened and why.
- A worker gets short rules and only the tools it may call: read and ask chats,
  one bounded helper, raise a block, read skills and references. It creates,
  renames, moves and deletes nothing on the desk.
- Every vendor CLI leads its own process group, so ending a worker or quitting
  the desk stops what it started. Known limit: a CLI that double-forks with
  `nohup`, `setsid`, launchd or systemd leaves that group.
- **Worker path scope** assigned repo-relative paths appear with the worker.
  Ask, accept-edits, read-only, and strict report Git-visible changes outside
  that list when the run ends. Always with Sandbox Off or Workspace does not
  path-own writes.
- This is review evidence, not containment:
  Sandbox controls where the runtime may write, and worktrees keep worker
  changes out of the linked folder.
- The owner's lease refreshes from disk when its write completes.
- **One permission inbox** every prompt lands in one place, translated to each
  vendor's protocol. Permission and Sandbox are the person's settings. A
  worker copies the parent chat's current seat. A spawn call cannot raise,
  lower, or retune them.
- A subagent never asks
  you. The desk answers it, so the only card you see is your own chat lifting a
  limit you set.
- **Desk access default** Settings › LLMs holds one Permission and Sandbox for
  work that names no chat. It ships as Always allow, sandbox off. A new chat
  starts there. A call naming a parent chat takes that chat's setting. A
  vendor app's own config does not move Workhorse's seat.
- **Campaigns** ordinary delegation stays ordinary at every permitted width, and
  root-worker capacity bounds the wave. That bound is checked per admission, so
  simultaneous spawns can land more workers than the bound.
- A Campaign begins only when Mission or an adaptive loop is asked for, and
  passes advance one phase at a time with no approval prompt.
- A caller cannot claim the build phase; only the desk holds a mission at build.
- **Plans** multi-step work that continues after a worker joins. A checklist you
  tick yourself completes on ordinary evidence.
- When workers run it, a step finishes when another vendor re-runs the named
  test at that worktree's commit. The builder cannot mark it done.
- A product question carries a recommendation and a default, and work continues
  on it. Elevate waits; one blocked slice does not stop the others.
- **Auditors** a slice that checks another worker can say so. `role: auditor`
  routes it deep instead of sizing it from the prompt.
- That way a one-line gate
  command does not get the cheapest model on the desk to grade another model's
  work.
- It does not restrict the worker or pick a different vendor from the builder;
  name the builder in `exclude` for that. Plan admission spawns its own auditor
  on a vendor the builders did not use.
- **Schedules** one-shot and recurring, journalled and recovered after a restart.
- **Goals** long-running intent that outlives its chat, continuing in rounds
  until pause, clear, or the round cap, one turn per round. Grok's own `/goal`
  stays that vendor's one-shot driver.
- **Loops** an opt-in goal that reassesses unfinished work for bounded rounds.
- **Fresh workers** a spawn carrying only a bounded handoff (`seed: fresh`).
- **Turn log** a chat rebuilds model history from its own turn and step log, per
  chat, never shared across vendors.
- **Harness tasks** OpenClaw and Hermes work joins the lineup before the CLI
  finishes. Stop reaches the process; a restart marks uncertain work unknown.
- **Routing** a chat keeps the model you picked until you set **Auto**, which
  picks bot and effort per message. Auto never picks Cursor Auto.
- For a generated image, Auto prefers Grok (`/imagine`) over text models that
  only take image input.
- Spawning a worker without a model, the desk ranks the slice and picks bot and
  effort.
- A named model or bot is used as named. The exception is a model that exists on
  more than one vendor (Grok 4.7 on Grok Build and on Cursor), which still ranks
  those vendors by leftover.
- **Test only** on a custom model keeps it off Auto. A person picking it, or a
  named call, still reaches it. Orchestration does not score it for real work.
- Naming the vendor locks that login, and a named vendor without a model still
  ranks that vendor's models.
- Composer high, spawn `effort`, or "on high" in the ask stays on the worker.
  Auto infers effort only when nobody assigned one.
- A second spawn only checks that output, unless you asked for every vendor, all
  bots, several independent reviews, or a named list.
- Equal-intelligence picks go to the cheaper slot; a model with its own extra
  pool is kept for visual, creative or complex work.
- A bot is local because of its address, not its name. A model you named
  yourself is still covered by Allow local models, and is never paced against a
  weekly gauge it does not have.
- What a bot is good at stays what you told the desk. Costing nothing breaks a
  tie, and never buys work a model cannot do.
- Settings → Routing turns that off, and tunes how routing weighs leftover,
  reserve and local models.
- With Learning on, a hand-picked chat stays on that model while the private
  store records what Auto would have picked.

## Workhorse Link, for apps that call the desk

- Workhorse Link is how an outside app calls this desk: Codex, Claude Code,
  Cursor, Grok, Grok Bot, OpenClaw, Hermes, or any MCP client.
- Settings → LLMs → Workhorse Link connects each with one button. Connect Cursor
  writes `~/.cursor/mcp.json`, and Copy generic MCP configuration covers the
  rest.
- Connect Grok Bot copies its one-shot instructions, on Mac or Windows, with its
  runtime-owned weekly-usage exporter contract.
- Every app gets the same versioned contract: eight core tools for capabilities,
  list, read and ask chats, query leftover and availability, delegation,
  continuation and worker status.
- Typed local capability tools join them when a host is configured.
- Call `workhorse_capabilities` first. It names follow-through: new slice, named
  worker or live chat, later status.
- Status follows workers and asked chats: wait, done, or failed. The done report
  is that turn's reply.
- A worker's status also says what it spent: tokens in, out and cached, plus
  dollars when the desk knows the price. The join report the parent chat
  receives says the same for each worker in the wave.
- While the desk is running, a linked app's reads come from the live desk over
  the loopback bridge, not from the saved file.
- So a read never lands on a file caught halfway through a save, and answers
  what the desk holds right now.
- A read carries no credential, no environment value and no attachment bytes.
  The desk drops those before it answers.
- With the desk closed, reads still answer from the last saved state as they
  always did, and say `desk: offline`.
- A helper that used to hold about 390 MB against a 29 MB desk now holds about
  114 MB after ten reads.
- List chats is compact by default so a host output cap cannot clip the roster.
- It lists every parent chat and every worker running or finished within the
  last day, and `all` adds back the older finished ones.
- `parents` omits workers, `full` adds a preview, and duplicate names need that
  row's `id`.
- Link never waits on a long worker.
- `workhorse_delegate` takes a `files` array and reads each one the way a drop
  does.
- The same limits hold: 256 KB text, 4 MB an image, 12 MB a document, 25 MB
  audio, 60 MB video, and at most 24 at a time.
- Anything the desk would not take is refused by name, not passed on as an
  unreadable blob.
- Paths must sit inside the chat's project folder, so a linked app cannot read
  outside it.
- An unnamed inbound spawn opens a new chat in Chats, or a project you pick,
  titled from the prompt.
- An explicit request to work with Workhorse delegates before direct execution,
  and blocked delegation returns the Workhorse error first.
- Delete, rename, credentials, bot setup and project changes are refused. No
  token is stored, and connecting an app adds no vendor, login or Usage ring.
- The same helper is a JSON CLI for a harness without MCP, covering local host,
  chat, 3D, job, artifact and continuation commands. `delegate --accept` starts
  an adaptive mission loop; `status` then `follow-up` continue it.
- **Install workhorse command** puts that CLI on your PATH.
- Full contract: [docs/LINK.md](LINK.md).

## Spend and meters

- Usage is recorded per vendor and per chat from each vendor's own count: the
  ACP turn total, or the HTTP usage block.
- Cursor is billed from its dashboard event log,
  joined to this desk's ACP session id, not the
  whole Cursor account. A four-characters-per-token estimate is used only until
  that join covers the turn.
- Composer and API stay two separate pools. Grok, Claude, and Codex stay unknown
  if they omit a bill.
- Leftover rings, billed tokens, and retained context stay distinct meters.
- Every percentage on the Usage page is leftover. The ring shows the percent;
  the line under it counts the same way, for every vendor.
- Settings → LLMs On/Off marks are circles. This stretch cells are circles.
- Week stretch pies sit at 64px, not the full column width, so they match
  Today's hourly dots instead of filling the page.
- Big totals read 1.66B, not 1657.5M.
- This chat's billed total sits in white on the left of the transcript.
  Orchestrated bots combine into one grey Crew total under it, and a click opens
  each bot with in, cached and out.
- A chat with no crew still shows its own total. Retained context stays on the
  ring to the right, and is not a stop.
- **In** is fresh input, what the model read for the first time. **Cached** is
  context served back from cache. **Out** is what it wrote, and the total is
  in + out.
- Compact shrinks the context meter. Leftover moves only if that bot ran a
  billed summary.
- A full window never holds a send the way a spent daily bank does.
  Retained context is this chat's window occupancy, never the
  leftover ring.
- Budgets per vendor.
- A weekly pace that tells you when you are ahead of it, before the bill does.
- A usage view by day, week, month or all time. This stretch shows billed in +
  out for the range, the same total as the chat meter, not only the peak cell.
- Events missing a clock still count on today.

## Memory

- A private learning store on your own disk, in SQLite. Nothing is sent anywhere
  to hold it.
- The compiler is a custom bot. Settings → Learning can backfill the last day of
  human prompts from saved chats.
- Human intent, agent performance, and the mismatches between them compile as
  separate private lanes.
- Agent evidence covers model outcomes, terminal tools, retries, tests,
  artifacts, usage, errors, and inbound Workhorse Link calls from a harness:
  tool, envelope and outcome, never keys or chat text.
- Delivery and task quality stay separate. A terminal event is not a verified
  success, and a transport failure does not lower a model's task-quality record.
- A compile carries a bounded prompt. The memory block has a ceiling, and an
  event too large for it is trimmed rather than sent whole.
- A failing input gets a fixed number of attempts, counted against the input
  rather than the run, on every path including the resume after a restart.
- Only the model refusing the request spends that budget. A rate limit, busy
  endpoint, missing compiler, or non-JSON reply is retried with a widening gap.
- Once attempts are spent the desk stops asking, steps past that evidence, waits
  longer while failures repeat, and records one line per failure.
- Settings shows index counts and inferred memories, not raw prompt text or
  provenance ids.
- Export the store, or wipe it, from Settings.
- What Learning records about routing is bounded task characteristics and model
  identities, never the raw prompt.

## Skills, MCP servers, Workshop, Local Compute

- **Skills** three ship with the desk and are seeded into `~/.workhorse/skills`
  on first run: `desk` for chat-to-chat control, `setup` for adding bots and
  references, and `workhorse-workshop-pack` for building Workshop packs. Spark login is an optional add-on: Settings →
  Skills → Import the `dgx-spark` folder from
  github.com/go7studio/workshop-pack-dgx-spark (or the private skills hub).
- Skills are also listed from Grok, Codex, Claude and Cursor homes, and can be
  pushed back to a vendor.
- A per-turn skill radar matches task language against installed names and
  descriptions, then verifies only the strongest candidates.
- Settings → Skills turns that wording match off, and can include plugin packs
  in the auto-load catalog. Slash commands stay the exact route.
- **MCP servers** Settings → Skills adds and tests local stdio servers, attaches
  each to selected runtimes, and picks the tools exposed to custom HTTP models.
- Those calls use the same approval and result path as built-in tools.
  Environment values go to the OS-encrypted credential store.
- **Custom bots** a pasted URL and key become a first-class bot with its own
  name and colour.
- A bot you switch off leaves the LLM grid and sits under it with Enable and
  Delete. The grid holds what you can call.
- A host that answers "at capacity, try again shortly" is waited out for about
  twenty-three seconds, honouring Retry-After. Workhorse keeps no count of its
  own.
- Large catalogs are grouped, frontier-first, searchable and explicitly
  approved. One key keeps one ring with separate model rows.
- A multi-model host is asked what it serves. The editor lists its models with
  the window and price the host publishes.
- Each is ticked to offer it, tested on its own for a reply, a latency and token
  counts, and rated for Auto.
- A host that publishes no list says so, and its ids stay hand-typed.
- Qwen 3.8 bots use the native Off, Low, Medium and Extra reasoning levels and
  the published thinking and direct-mode sampling profiles.
- Dev shells keep a pasted key on the bot itself, because their credential vault
  is memory-only.
- **Workshop** an optional, read-only rail on the right edge. Settings →
  Workshop is the install and grant home, and **Manage** on the rail opens the
  same panel. **Workshop** in a chat header, beside Review and Terminal, opens
  a window on the right — the same slot as Review.
- Skills is not the Workshop home, and there is no dock row.
- Add a pack from that sheet: catalog Install, a public GitHub repo URL (the
  highest tagged release downloads), or a folder.
- A pack is data only: one `pack.json` naming what it reads and how its cards
  look, plus an optional collector the operator installs on the remote box.
  Nothing from a pack runs in Workhorse.
- Turn a pack on, pick the Local Compute host it reads through, and confirm the
  exact URLs, cadence and byte cap it will GET.
- The rail paints cards collapsed to a 76px strip, or expanded. With no packs on
  it is hidden, and Install and Turn on live in Settings → Workshop, the rail's
  Manage sheet, and the chat Workshop panel.
- Packs stack as modules and fold on their own.
- Update re-reads the repo's tags. When a pack's sources change, those packs
  turn off before polling restarts and you confirm again, because grants are
  bound to source fingerprints.
- The rail is the current snapshot, keeps no history, and starts, stops, routes
  and leases nothing.
- When two packs grant the same Local Compute URL, main issues one shared GET at
  the faster cadence. **Detach** opens the cards in their own window.
- Workhorse ships no packs. The DGX Spark monitor lives at
  github.com/go7studio/workshop-pack-dgx-spark.
- **Local Compute** Settings → LLMs → Local Compute discovers each host's live
  capabilities and grants them separately to Workhorse, connected apps, workers
  and auditors.
- Recheck also GETs `/v1/models` and lists the ids. That is how the desk
  collects what a host is delivering as chat models; it is not a vendor slot
  until you add DGX Spark (or Your own) under Add a bot.
- MCP, the `workhorse` command and harnesses see only what is healthy and
  granted for their caller role.
- A local host can discover profiles, accept asynchronous text or image-to-3D
  jobs, report or cancel jobs, transfer SHA-verified artifacts, and dispatch an
  authorized Blender continuation as a visible worker.
- Local hosts are execution hosts, not vendors, custom bots or Usage rings. The
  leftover check never includes keys or
  chat content. Older names still
  answer, so a harness already calling them is not refused.
- The generic invocation contract advertises artifact roles, cardinality,
  accepted media types, typed outputs and a closed constraint schema, so new
  families need no hardwired router.
- Legacy summary-only descriptors still work with their named tools, but are
  never guessed into a generic invocation contract.
- Generic invoke appears only when a granted capability publishes a complete
  typed contract. Upload discovery stays independent.
- Typed continuations appear only when an installed and granted capability and
  tool pair can produce them.
- Successful submissions and canonical semantic-request fingerprints survive a
  helper restart.
- When a host goes offline, a known job read reports `Unknown` with its
  timestamped last-observed state, and stale continuations are not offered.
- Only the token-file reference is stored, never the token itself.
- Hosts must use HTTPS; plain HTTP is accepted only on loopback. A Spark
  gateway is `http://127.0.0.1:8788` after NVIDIA Sync (or `ssh -L`) forwards
  it. LAN HTTP to the box is refused.
- **The `/` palette** new, project, link, model, effort, compact, plan, sandbox,
  usage, watch, schedule, goal, skills, review, context, rewind, export, memory,
  hooks, plugins, workflows, and more.

## Settings

- Nine sections: Profile, LLMs, Skills, Workshop, Bot knowledge, Routing,
  Learning, Usage, Watch.
- **Bot knowledge** shows what orchestration reads on an Orchestrate or Mission
  chat: task domain (coding, image generation, writing, visual, data, general),
  the bar for that domain and tier, every connected catalog and custom model in
  the order a spawn would pick it, with its score, where the score came from,
  its Agent Arena score when it has one, and its plan terms (leftover, time to
  reset, pace, 5h window, workers running there). Rows under the bar or out of
  reach say why. No API keys, credential ids, or base URLs. Cursor Auto is
  omitted; Grok 4.7 on Grok Build and on Cursor stay one family for leftover.
- Scores come from the public LMArena leaderboard dataset (CC BY 4.0), no key
  needed. Coding reads Code Arena, where models build working apps with tools
  (the text arena's coding category only for a model Code Arena has not rated);
  writing reads creative writing, data reads math, visual reads the vision
  arena, image generation reads text-to-image for Grok's image product, and
  general reads the text arena. Each score is matched to the run at the
  thinking level the desk would use. The desk checks the dataset's commit once a
  day and downloads it (about 0.7 MB) only when it changed, so a newly ranked
  model is scored the day LMArena publishes it; **Check now** asks at once.
- The scale is strict. Only a board's leader scores 10; its 25th-best model
  scores 5, counting each model once, and every other model sits on the line
  through those two, down to 1, so the tenth-best lands near 7 and a model far
  down the board lands near the floor. Agent Arena grades the same way. A new
  generation a board has not rated yet reads the latest earlier one of its line
  that it has (Opus 5.5 reads Opus 5, Grok 4.7's chat scores read Grok 4.6), and
  its source says so. A bot with no rated line uses the desk's own table, which
  is on the same scale, rounded down, never 10, and says which board or sibling
  each number was read from. An unknown custom bot keeps its family prior moved
  onto that scale: a frontier family is 8, the balanced band 5, an unrated
  model 2.
- The profile shows the Workhorse mark as tiny moving blobs of the bots you have
  called. Spend sets how many of each colour, and blobs merge without mixing.
- Hover it for Your Workhorse and what it is made of. With no spend yet it keeps
  the native sunset-to-blue blobs.
- Settings exports a support report without prompts, messages, file contents,
  environment variables, URLs or credential values.
- Settings → Profile checks GitHub for a newer desk. A Mac installer swaps the
  app from that release's disk image; a Windows installer runs the Setup exe
  after Workhorse quits.
- When one is ready, a blue control appears at the far right of Settings. Hover
  it for Update now and the version it will install.
- A control gets one line of explanation, then a Learn more link to the docs.
- In Settings → LLMs a vendor is switched with a word, On or Off. Only a meter
  draws a ring.

## Platforms

- Windows and macOS. Both installers are built and tested on their own machine
  for every release.
