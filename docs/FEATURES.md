# What Go7 Workhorse does

Every ability the desk has, in one place. Anything listed here ships on `main`.
When you add a feature, add it here in the same commit.

## Agents

| Vendor | How it connects | Notes |
| --- | --- | --- |
| Grok | ACP over stdio | Runs the local Grok CLI |
| Claude | ACP over stdio | Runs the local Claude Code CLI |
| Codex | ACP, plus an App Server | App Server adds native history and capability discovery |
| Cursor | ACP over stdio | Runs `cursor-agent` |
| Custom | HTTP | Any Anthropic Messages or OpenAI Chat Completions endpoint, hosted or local |

Each vendor runs under its own login. Subscriptions, context and sandboxes are
never pooled.

OpenClaw and Hermes are **harnesses**, not vendors. Settings → LLMs shows
whether each runtime is installed and lets you select its callable agents. A
plan can grant selected agents for one wave, or you can name `openclaw/main`
or `hermes/<profile>`. Those tasks join the lineup. They do not get a Usage
ring.

**Workhorse Link** is how any outside app calls this desk — Codex, Claude
Code, Grok, OpenClaw, Hermes, or any MCP client. Settings → LLMs → Workhorse
Link connects each with one button, through that app's own MCP tool; Copy
generic MCP configuration covers the rest. Every app gets the same eight
tools: capabilities, list/read/ask chats, query leftover and availability,
delegate a task, continue a finished wave, worker status. The leftover check
never includes keys or chat content. The first call,
`workhorse_capabilities`, says what this desk offers. Older names still
answer so a harness that already calls them is not refused. Delete, rename,
credentials, bot setup and project changes are not offered and are refused.
No token is stored. Connecting an app adds no vendor, login or Usage ring.
The same helper is a JSON CLI for a harness without MCP, and Install
workhorse command puts it on your PATH. See [docs/LINK.md](LINK.md).

Unnamed inbound spawns create a new chat in Chats by default, or in a project
you pick, titled from the prompt. An explicit request to work with Workhorse
delegates before direct execution; blocked delegation returns the Workhorse
error before any fallback.

One custom API connection can approve several models. Chats and Auto routing use only that list while Usage keeps one connection ring and separate model rows.
Add a bot lists MiniMax, Synthetic, OpenRouter, Groq, DeepSeek, Together,
Fireworks, Hugging Face, Novita, Cerebras, AI/ML API, Vercel AI Gateway,
Kimi Code, and Gemini API. Presets are grouped as subscription plans,
gateway credits or BYOK, and direct API billing. Leftover pings only
official key-only JSON meters (MiniMax, Synthetic, OpenRouter). DeepSeek,
Novita, AI/ML API, and Vercel AI Gateway fill prepaid balance. Together,
Fireworks, Groq, Hugging Face, Cerebras, Kimi Code, and Gemini stay
unknown until those hosts publish leftover JSON.

## Files you can hand a chat

Drag them onto the window, or paste them in.

- **Images** — png, jpg, jpeg, webp, gif, bmp
- **Audio** — mp3, wav, m4a, aac, flac, ogg, opus, webm
- **Video** — mp4, mov, m4v, webm, avi, mkv
- **Documents** — pdf, doc, docx, ppt, pptx, xls, xlsx, rtf, odt
- **Text and code** — txt, md, html, css, json, xml, svg, csv, tsv, ts, tsx,
  js, py, rs, go, java, rb, php, c, cpp, cs, sql, yml, toml, sh, and the rest
  of the usual list
- **Folders** — dropped whole, with dotfiles and build output skipped

A harness gets the same list. `workhorse_delegate` takes a `files` array and
reads each one the way a drop does, with the same size limits — 256 KB of
text, 4 MB an image, 12 MB a document, 25 MB audio, 60 MB video — and at most
24 at a time. Anything the desk would not take is refused by name rather than
handed on as an unreadable blob. The paths must sit inside the chat's project
folder: an app connected over Link can call this, and the desk will not read
outside the folder you pointed it at.

A chat can also read media the agent wrote, so a generated image shows in the
transcript rather than as a path.

## Chats and projects

- A project is a name. Folders and references are optional, added later.
- Chats belong to a project, and can be renamed, archived, deleted, or dragged
  to another project.
- Vendor, model and thinking effort are set per chat, not per app.
- Fork a chat to try a different model on the same history. The fork is layered
  under the source chat, with a managed worktree when the project has a Git
  folder — the same isolation subagents use.
- Rewind to an earlier turn.
- A long transcript opens on the latest turns. Scrolling up pages in the next older window without jumping.
- A portable transcript follows a chat when its vendor changes.
- Search runs over chat titles and message text across every project.
- Each chat row shows how old the last prompt is in a compact form such as
  `25m`, `2h`, or `3d`. Hover the stamp for the full time. A finished worker
  you have not opened since it landed shows a small done dot beside the stamp;
  opening that chat clears it. While a worker is still going, its place in the
  list stays fixed — tool ticks do not reshuffle nested rows. A parent with workers
  folds them on the count button; they ease open and closed.
- A chat that ran a wave says so on its own row: who called it, and how it
  went — `OpenClaw · Working…`, or nothing at all once every worker finished
  clean. Failure is the only word in red; interrupted and timed-out work is
  unfinished, not wrong. A wave that came in over Link and was never named
  here takes the work's own name instead of the prompt's first few words, so
  long as its workers agree on one.
- User and assistant turns in the transcript use the same clock.
- A turn’s work stays on one compact line while it runs. Open it when you
  want the ordered detail: think, tools, think. Consecutive tool calls share
  one fold labelled "3 tools"; expand it to see the calls listed underneath, not
  a row of "1 tool". A single call shows its name. A later thought starts a new
  hop. When a turn runs long, earlier thoughts and tools roll into an Earlier
  fold you can open again. The current hop stays open. The visible reply stays
  below that. A parent turn that is only a worker marker still shows that
  worker's last reply underneath, so the report is readable on this chat.
  Open the worker for the tools and the rest of its transcript.
- Grok tables keep their real columns. Empty `| |` / `|---|` chrome is
  dropped, and a path with a size suffix such as `foo.md (34441 chars)`
  still opens.

## Control

- **Permission modes** — ask, accept-edits, always-approve, plan.
- **Sandbox profiles** — off, workspace, read-only, strict.
- **One permission inbox.** Every prompt lands in the same place and is
  translated to each vendor's own protocol.
- **Scoped approvals.** A session grant remembers the exact tool, command, and
  path for 24 hours. Changed or expired requests ask again.
- **Execution directory** — a chat starts in a linked folder or managed git
  worktree; the terminal can navigate elsewhere and Review opens cited external
  files. A loose top-level chat can search from the desk base, while workers
  need an absolute folder.
- **Terminal** — chat-scoped, in that same directory.
- **Git review** — a compact Changes control beside the composer opens the
  changed files and diffs for the work a chat did. Click a row to open the
  file beside the chat or as the project-home pane. On the project home the
  Changes card stays full width and the file list folds open and closed.
  +0/−0 stays hidden. Line stats load in the background and do not re-diff
  the list once they are known.
- **Change instances** — a created file’s lines stay green. A later prompt that
  deletes some of them keeps those lines as red instances in the review, instead
  of shrinking the green count against empty / HEAD. Paths such as
  OpenClaw configs outside the project folder still resolve from the
  cite in the transcript.
  The baseline survives an app restart.

## Spend

- Usage recorded per vendor and per chat, from each vendor's own count: the
  ACP turn total, or the HTTP response's usage block. If a vendor sends no
  count, the turn stays unknown; Workhorse does not invent tokens.
- **In** is fresh input — what the model read for the first time. **Cached** is
  context served back from cache, named apart so a long chat does not read as
  millions of new tokens. **Out** is what it wrote. The total is in + out.
- Compact shrinks the context meter. Leftover does not move unless that same
  bot ran a billed summary. A full window never holds a send the way a spent
  daily bank does.
- Budgets per vendor.
- A weekly pace that tells you when you are ahead of it, before the bill does.
- A usage view by day, week, month, or all time.

## Work that outlives a turn

- **Schedules** — one-shot and recurring, journalled by the desktop process and
  recovered after a restart.
- **Goals** — long-running intent that survives the chat that started it. A
  desk goal continues in rounds after a turn ends, until pause, clear, or the
  round cap. Each round is one turn on that chat’s vendor. Grok’s own `/goal`
  is still that vendor’s one-shot driver.
- **Loops** — an opt-in goal that reassesses unfinished work for bounded rounds.
- **Fresh workers** — a separate spawn option with only a bounded handoff
  (`seed: fresh`) and no parent conversation.
- **Turn log** — a chat can reconstruct model history from its own turn and
  step log. The log is per chat. It is never shared across vendors.
- **Subagents** — lifecycle records, runtime and token ceilings, cascading
  cancellation, changed-file review, and worktree isolation where the project
  supports it. A token ceiling meters this slice’s new work, not leftover or
  the size of the repo the worker read. One pass cannot spend the whole
  mission. The last fifth is for verifying and handing off, not more producing.
  The run is warned before it stops, and the stop report says what was left
  unfinished. No ceiling means no limit. A reused worker starts a new count.
  If the parent then does the work itself, the run records that the parent took
  over instead of a fully Workhorse-owned completion.
  A worker gets a worker's context: the
  short worker rules and only the desk tools it may call — read and ask chats,
  one bounded helper, ask to raise a block, read skills and references. It
  cannot create, rename, move or delete anything on the desk, and is not shown
  those tools.
- **Plans** — multi-step work that continues after a worker joins. A checklist
  plan you tick yourself still completes on ordinary evidence. When workers run
  the plan, a step finishes when another vendor re-runs the named test at that
  worktree’s commit. The builder cannot mark it done. During that run, a
  product question carries a recommendation and a default, and work continues
  on that default. Elevate still waits. One blocked slice does not stop the
  others.
- **Harness tasks** — OpenClaw and Hermes work appears in the lineup before the
  CLI finishes. Stop reaches the live process; restart marks uncertain work
  unknown instead of complete.
- **Auditors** — a slice that checks another worker's output can say so.
  Spawn or delegate with `role: auditor` and the desk routes it deep instead
  of sizing it from the prompt, so a one-line gate command does not get the
  cheapest model on the desk to grade another model's work. It does not
  restrict the worker or pick a different vendor from the builder; name the
  builder in `exclude` for that. Plan admission spawns its own auditor and
  picks a vendor the builders did not use.
- **Routing** — your own chat keeps the model you picked until you set it to
  **Auto**; Auto picks the bot and effort for each message. Auto does not pick
  Cursor Auto; that stays a named chat pick. The desk routes the work it
  hands out on its own: when a chat spawns a worker without naming a bot, the
  desk picks the bot and effort for the slice, and a named bot is used as
  named. Settings → Routing turns that off, and tunes how any routing weighs
  leftover, reserve, and local models.

## Memory

- A private learning store on your own disk, in SQLite.
- The compiler is a custom bot. Settings → Learning can backfill the last day of human prompts from saved chats.
- Human intent, agent performance, and mismatches between them compile as separate private lanes. Agent evidence includes model outcomes, terminal tools, retries, tests, artifacts, usage, errors, and inbound Workhorse Link calls from a harness (tool, envelope, and outcome — not keys or chat text).
- Settings shows index counts and inferred memories, not raw prompt text or internal provenance ids.
- Export it, or wipe it, from Settings.
- Nothing is sent anywhere to hold it.

## Extending it

- **Skills** — two ship with the desk, `desk` for chat-to-chat control and
  `setup` for adding bots and references. Skills are also listed from Grok,
  Codex, Claude and Cursor homes, and can be pushed back to a vendor.
- **MCP servers** — attached to a runtime, with the same approval and result
  path as built-in tools.
- **Custom bots** — a pasted URL and key become a first-class bot with its own
  name and colour. Large catalogs are grouped, frontier-first, searchable, and
  explicitly approved; one key keeps one ring with separate model rows.
  Dev shells keep a pasted key on the bot itself, because their credential
  vault is memory-only and used to drop leftover tracking on restart.
- **The `/` palette** — new, project, link, model, effort, compact, plan,
  sandbox, usage, watch, schedule, goal, skills, review, context, rewind,
  export, memory, hooks, plugins, workflows, and more.

## Settings

Profile, connected LLMs, skills, routing, learning, usage, watch.

The profile shows the Workhorse mark as tiny moving blobs of the bots you
have called. Spend sets how many of each color; blobs merge in space without
mixing into a new color. Hover it for Your Workhorse and what it is made of.
With no spend yet, it keeps the native sunset-to-blue blobs.

Settings can export a support report that excludes prompts, messages, file
contents, environment variables, URLs and credential values.

Settings → Profile can check GitHub for a newer desk. A Mac installer
downloads that release's disk image, replaces the app, and opens it. A Windows
installer downloads the Setup exe, installs after Workhorse quits, and opens
the new build. When one is ready, a blue update control appears at the far
right of Settings. Hover it to see Update now and the version it will install.

## Platforms

Windows and macOS. Both installers are built and tested on their own machine
for every release.
