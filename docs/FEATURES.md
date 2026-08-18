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
whether each runtime is installed. A plan can grant them for one wave, or you
can name `openclaw/main` or `hermes/<profile>`. Those tasks join the lineup.
They do not get a Usage ring. Settings → LLMs → Install MCP writes a restricted
Workhorse server into OpenClaw (`mcp.servers`), and into Hermes (`mcp_servers`)
if Hermes is already installed. Those apps launch the packaged helper. No token
is stored. They can list, read, and ask chats, and spawn a Workhorse worker on a
chat you pick. Delete, rename, credentials, and elevate stay blocked.

## Files you can hand a chat

Drag them onto the window, or paste them in.

- **Images** — png, jpg, jpeg, webp, gif, bmp
- **Audio** — mp3, wav, m4a, aac, flac, ogg, opus, webm
- **Video** — mp4, mov, m4v, webm, avi, mkv
- **Documents** — pdf, doc, docx, ppt, pptx, xls, xlsx, rtf, odt
- **Text and code** — txt, md, json, csv, tsv, ts, tsx, js, py, rs, go, java,
  rb, php, c, cpp, cs, sql, yml, toml, sh, and the rest of the usual list
- **Folders** — dropped whole, with dotfiles and build output skipped

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
- A portable transcript follows a chat when its vendor changes.
- Search runs over chat titles and message text across every project.
- Each chat row shows how old the last prompt is in a compact form such as
  `25m`, `2h`, or `3d`. Hover the stamp for the full time.
- User and assistant turns in the transcript use the same clock.
- A turn’s work stays on one compact line while it runs. Open it when you
  want the ordered detail: think, tools, think. Consecutive tool calls share
  one fold labelled "3 tools"; expand it to see the calls listed underneath, not
  a row of "1 tool". A single call shows its name. A later thought starts a new
  hop. The visible reply stays below that.

## Control

- **Permission modes** — ask, accept-edits, always-approve, plan.
- **Sandbox profiles** — off, workspace, read-only, strict.
- **One permission inbox.** Every prompt lands in the same place and is
  translated to each vendor's own protocol.
- **Execution directory** — a chat runs in a linked folder or in a managed git
  worktree, isolated from your working copy.
- **Terminal** — chat-scoped, in that same directory.
- **Git review** — a compact Changes control beside the composer opens the
  changed files and diffs for the work a chat did.
- **Change instances** — a created file’s lines stay green. A later prompt that
  deletes some of them keeps those lines as red instances in the review, instead
  of shrinking the green count against empty / HEAD.

## Spend

- Usage recorded per vendor and per chat, from each vendor's own count: the
  ACP turn total, or the HTTP response's usage block. A turn is estimated at
  four characters a token only when the vendor sent no count — Cursor, so far.
- **In** is fresh input — what the model read for the first time. **Cached** is
  context served back from cache, named apart so a long chat does not read as
  millions of new tokens. **Out** is what it wrote. The total is in + out.
- Budgets per vendor.
- A weekly pace that tells you when you are ahead of it, before the bill does.
- A usage view by day, week, month, or all time.

## Work that outlives a turn

- **Schedules** — one-shot and recurring, journalled by the desktop process and
  recovered after a restart.
- **Goals** — long-running intent that survives the chat that started it.
- **Subagents** — lifecycle records, runtime and token ceilings, cascading
  cancellation, changed-file review, and worktree isolation where the project
  supports it. A worker gets a worker's context: the short worker rules and
  only the desk tools it may call — read and ask chats, one bounded helper,
  ask to raise a block, read skills and references. It cannot create, rename,
  move or delete anything on the desk, and is not shown those tools.
- **Plans** — multi-step work that continues after a worker joins.
- **Routing** — your own chat keeps the model you picked until you set it to
  **Auto**; Auto picks the bot and effort for each message. The desk routes
  the work it hands out on its own: when a chat spawns a worker without naming
  a bot, the desk picks the bot and effort for the slice, and a named bot is
  used as named. Settings → Routing turns that off, and tunes how any routing
  weighs leftover, reserve, and local models.

## Memory

- A private learning store on your own disk, in SQLite.
- The compiler is a custom bot. Settings → Learning can backfill the last day of human prompts from saved chats.
- Human intent, agent performance, and mismatches between them compile as separate private lanes. Agent evidence includes model outcomes, terminal tools, retries, tests, artifacts, usage, and errors—not raw reasoning text.
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
  name and colour. Testing the connection asks the provider which models it
  serves; tick the ones you want and any chat on that bot can pick between
  them. One key is one bot and one leftover ring, however many models it
  offers — Usage still breaks the tokens out per model.
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
downloads that release's disk image and replaces the app.

## Platforms

Windows and macOS. Both installers are built and tested on their own machine
for every release.
