---
name: desk
description: Workhorse desk control. Use when agents should talk to each other, list or read sidebar chats, ask another chat, or spawn Grok, Codex, Claude, or a custom bot inside this conversation.
---

# Workhorse desk

This chat is on the Workhorse desk. Other live chats are in the sidebar. Use desk tools — do not tell the user to copy-paste into another window.

## Talk to other chats

1. `workhorse_list_chats` — live chats only. Archived and deleted are gone.
2. `sidebar` is the subtitle (model · effort · mode). `preview` is the last user/assistant snippet.
3. `workhorse_read_chat` with the **visible title** when you only need that transcript.
4. `workhorse_ask_chat` with the visible title + message when that chat should answer or do the work.

Always pass the visible title. Never invent a session id.

## Call another agent here

This live chat is the **orchestrator**. A missing linked folder does not fail this turn — search and attach (`workhorse_create_project`), then spawn, or pass `folder`. Do not spawn into an unbound working directory. Do not refuse the turn.

Then:

1. `workhorse_list_bots`
2. One bounded assignment is one `workhorse_spawn_agent`. Leave `provider` and `model` unset so Auto picks, unless they named a vendor or model. Spawn only a `canCall` row. The prompt is the **slice**.
3. Fan-out only when they asked for every vendor, all bots, multiple independent reviews, or a named list. Then write a lineup (name · vendor · folder · slice) and spawn one worker per named slice on a `canCall` row — including this chat’s own custom bot (`provider` custom, `chat` this bot’s name). The API key is already on the desk.

Each root spawn prompt is the job the worker will do — never a bare “please call subagents.” A worker may create one quick-route helper only when its assigned slice explicitly requires a second independent check. Workhorse caps that nested call at 5,000 tokens, shared isolation, and depth two; the helper cannot spawn again.

To run several workers at once (only after they asked for that fan-out): `workhorse_spawn_agent` with `wait=false` for each slice, then **stop**. One short line of who is out is enough. Workers fill their own nested chats. The desk joins every report into one orchestration call when they finish. `workhorse_await_agents` (default) is a status snapshot — do not sit on it, and do not ask the user 1/2/3 if it is still running.

Do not ask which vendor. Do not wait for Allow. Do not call `workhorse_request_vendor`. If `canCall` is false or the daily bank is spent, that vendor is a no-go — skip it. If stock vendors are a no-go, spawn one callable custom bot. Do not spawn several of one vendor with split tasks to fill a crew. Only say nothing to spawn when zero rows are `canCall`.

The user can also switch This chat → Vendor; that starts a new vendor instance on the same transcript.

## Projects

- Search likely folders first, then `workhorse_create_project` — that puts **this chat** in the project. Do not ask for a path when the folder exists.
- `workhorse_move_chat` with the project name (omit `chat` to move this chat).
- `workhorse_rename_chat` / `workhorse_rename_project` with the new `name`. If they say rename to X, rename this chat and this chat’s project. Do not delete and recreate. Then `workhorse_list_projects` — only say it is named X if Visible sidebar names include X.
- `workhorse_delete_chat` needs the exact title or id of **another** chat. Never delete this chat on a bulk list. `onlyThis=true` only if they asked to delete this chat alone.
- If they ask to delete all chats **not in a project**, call `workhorse_delete_chat` with `scope=loose` now. Do not ask which ones. Do not offer A/B/C. That never deletes this chat.
- After you ask the user to pick, stop and wait. Do not run a listed option until they answer. Do not ask them to pick when they already said delete all chats not in a project.

## Do not

- Do not say you have no way to talk to other chats.
- Do not tell the user to open a new Grok/Codex window and paste.
- Do not mention archived or deleted chats.
- Do not tell a worker to spawn. A worker does the assigned slice in the bound folder and returns a report.
