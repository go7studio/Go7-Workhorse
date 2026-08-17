# Workhorse Bible

This is the locked product. Agents and humans read it before they change
the desk. `docs/FEATURES.md` is the inventory of what ships. This file is
the law: what must stay, what must not appear, and how that list changes.

Steve agrees every add or remove. Until then, build inside this boundary.
Do not invent a parallel product.

## Locked product

**One desk. Every subscription stays its own.**

- A native desktop window. Not a website. Not a new model.
- Electron main owns privileged work. The UI talks typed IPC. React never
  launches a vendor CLI.
- Grok, Claude, Codex, and Cursor are live ACP vendors. Custom bots are
  live HTTP slots (Anthropic or OpenAI-compatible, hosted or local).
- Logins, context, tools, and sandboxes never pool across vendors.
- A project is a name. Folders and references are optional links.
- Chats belong to a project. Vendor, model, and effort are per chat.
- One permission inbox. Permission mode and sandbox are separate controls.

**Several agents at once, called on purpose.**

- The user, or the orchestrator chat, can list bots, read or ask another
  live chat, and spawn a worker for a slice.
- Spawn only rows that `canCall`. Skip a spent daily bank or a declined
  vendor. Do not invent a bot that is not on the desk.
- More than one worker starts together (`wait=false`). The parent does not
  sit and poll. The desk joins reports.
- A worker does its slice in the bound folder. One bounded helper is the
  ceiling. Grandchildren do not spawn.
- Talking to an existing chat is not spawning. Attaching prior context is
  not a message. Resuming a child is not a new agent.

**The user controls how intelligence is called.**

- This chat → Vendor / model / effort is the live pick.
- Settings → Routing can stay off. When on, it may pick a cheaper or local
  slot from leftover and reserve. The user can turn it off.
- Settings → Watch is the weekly leftover and daily bank. The user sets
  the pace. The desk does not auto-approve or go unlimited.
- Permission and sandbox stay visible on the chat. An agent may only ask
  to raise a block for work it must do now. It never lowers them.

**Spend is leftover, from official meters.**

- Settings → Usage shows leftover rings, not a guessed 0 or 100.
- Each vendor and each custom bot keeps its own ring. Cursor is two
  monthly pools. Do not fold one ring into another.
- Missing official meter stays unknown (`…`). A 404 is not empty.
- Tokens are recorded per vendor and per chat. Preview and failed-before
  prompt invent none.

**Memory is a private SQLite store on this machine.**

- Settings → Learning. Off, capture, review, or automatic.
- Electron main owns the database under userData. Export or wipe from
  Settings. Nothing is sent away to hold it.
- Memory cannot grant tools, change permissions, pick a project, or
  override the current request.

**Work survives a restart.**

- Schedules, goals, plans, queues, and chats are journalled.
- A chat runs in a linked folder or a managed git worktree.
- Terminal and Git review use that same directory.

## Production code

This is a production app. Treat the tree that way.

- Ship the smallest change that keeps the locked product.
- Delete dead code, unused files, and one-off leftovers in the same
  change that makes them unused. Do not comment them out.
- One home per fact. FEATURES lists abilities. This file is the law.
  Session rules live in `src/lib/workhorse-rules.ts`. Do not copy those
  lists into a third place.
- Copy the user sees is short, present tense, and names the thing. No
  marketing filler. No “sidebar anything.” Call a project a project.
- Do not add a framework, a new top-level folder, a new Settings tab, or
  a new stock vendor unless this Bible is updated in the same commit.
- Tests drive shipped functions. They do not read the machine they run
  on. Green on one laptop is not green.
- Working papers stay out of the repo (CONTRIBUTING).

## Must not

- Merge subscriptions, leftover, context, or sandboxes.
- Drive the open Cursor IDE or Grok Bot as if they were this desk.
- Scrape unpublished hosts. Do not treat a 404 as a full or empty ring.
- Auto-approve, unlimited Watch, or invent API keys.
- Put a brain picker in front of New chat.
- Make Usage a top-level sidebar item.
- Scaffold files on disk when the user asked for a desk project.
- Leave a dirty shared checkout. One tree per agent.

## How this file changes

1. Steve says the product should gain or drop a locked item.
2. The same commit updates this file, `docs/FEATURES.md` if the inventory
   changed, and the test that pins these headings.
3. Until that commit lands, agents implement inside the current text.

A feature that is not in FEATURES is not shipped. A locked item that is
not in this file is not law. Do not “improve” either by drifting.

## Read order

1. This file.
2. `docs/FEATURES.md` — what the desk can do today.
3. `AGENTS.md` — how to work in this tree.
4. `CONTRIBUTING.md` — what belongs in the repo.
