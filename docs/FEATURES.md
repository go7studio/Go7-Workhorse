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
- Fork a chat to try a different model on the same history.
- Rewind to an earlier turn.
- A portable transcript follows a chat when its vendor changes.
- Search runs over chat titles and message text across every project.

## Control

- **Permission modes** — ask, accept-edits, always-approve, plan.
- **Sandbox profiles** — off, workspace, read-only, strict.
- **One permission inbox.** Every prompt lands in the same place and is
  translated to each vendor's own protocol.
- **Execution directory** — a chat runs in a linked folder or in a managed git
  worktree, isolated from your working copy.
- **Terminal** — chat-scoped, in that same directory.
- **Git review** — see changed files and diffs for the work a chat did.

## Spend

- Usage recorded per vendor and per chat.
- Budgets per vendor.
- A weekly pace that tells you when you are ahead of it, before the bill does.
- A usage view by day, week, month, or all time.

## Work that outlives a turn

- **Schedules** — one-shot and recurring, journalled by the desktop process and
  recovered after a restart.
- **Goals** — long-running intent that survives the chat that started it.
- **Subagents** — lifecycle records, runtime and token ceilings, cascading
  cancellation, changed-file review, and worktree isolation where the project
  supports it.
- **Plans** — multi-step work that continues after a worker joins.
- **Routing** — reasoning effort chosen per task rather than fixed per app.

## Memory

- A private learning store on your own disk, in SQLite.
- Export it, or wipe it, from Settings.
- Nothing is sent anywhere to hold it.

## Extending it

- **Skills** — listed from Grok, Codex, Claude and Cursor homes, and pushed
  back to a vendor.
- **MCP servers** — attached to a runtime, with the same approval and result
  path as built-in tools.
- **Custom bots** — a pasted URL and key become a first-class bot with its own
  name and colour.
- **The `/` palette** — new, project, link, model, effort, compact, plan,
  sandbox, usage, watch, schedule, goal, skills, review, context, rewind,
  export, memory, hooks, plugins, workflows, and more.

## Settings

Profile, connected LLMs, skills, routing, learning, usage, watch.

Settings can export a support report that excludes prompts, messages, file
contents, environment variables, URLs and credential values.

## Platforms

Windows and macOS. Both installers are built and tested on their own machine
for every release.
