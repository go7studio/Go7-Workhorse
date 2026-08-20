---
name: setup
description: Workhorse setup. Use when adding or removing a desk bot, pinning a project reference, or loading a skill. Desk actions only — never invent API keys or edit Workhorse source.
---

# Workhorse setup

Bots, references, and skills are desk slots. Do not read Workhorse source or write adapters.

## Bots

1. `workhorse_list_bots` — if the model is already listed, tell the user to pick it under This chat → Vendor.
2. User supplied base URL, model, and key → `workhorse_setup_custom_bot` with those fields.
3. No key given → tell them to use Add a bot. Do not import MiniMax or OpenClaw.
4. `workhorse_delete_bot` removes a slot by name.

Never invent an API key. After a successful setup, say the bot is on the desk and they can select it in This chat → Vendor.

## Projects

A Workhorse project is a named desk entry under Projects. It is not a file on disk and not a git repo. Linking a folder does not create `project.godot` or any files.

1. Search likely folders first (`D:\` and `C:\`, Godot/Projects, the user’s Projects folder, names matching the request). If they name a drive, search that drive now — do not ask which copy.
2. `workhorse_list_projects` so you do not duplicate a name.
3. `workhorse_create_project` with `name` and the absolute `folder` you found (folder can wait until you find it). If that project already exists, passing `folder` links it. This chat is placed in that project. Do not ask the user for a path when a matching folder exists.
4. `workhorse_list_projects` again. Only tell the user it exists if that list shows the name and folder.
5. Call it a project. Do not call it a sidebar anything.

Move / delete:

- `workhorse_move_chat` with `project` (omit `chat` to move this chat)
- `workhorse_rename_chat` / `workhorse_rename_project` with the new `name`. If they say rename to X, rename this chat and this project. Do not delete and recreate.
- `workhorse_delete_chat` with the exact title or id of **another** chat. Never omit chat to delete yourself. `onlyThis=true` only if they asked to delete this chat alone. If they ask to delete all chats not in a project, call it with `scope=loose` now — do not ask which ones.
- `workhorse_delete_project` with `project` (`chats=keep` default, or `remove`)

When they say “create a project” or “allocate” in this app, search then create. Do not invent success. Do not ask them to click New project. After you ask them to pick, stop and wait.

## References

Pin a URL, note, or file on this project (Project home → References):

- `workhorse_list_references` first if you might duplicate
- `workhorse_add_reference` with `value` (optional `kind` / `label`)
- `workhorse_delete_reference` by label or URL

## Skills

Desk skills include Grok, Codex, Claude, and **Workhorse** (`desk`, `setup`). Leftover-meter wiring for a new vendor lives in the private skills hub (`vendor-meter`), not this public repo.

- `workhorse_list_skills` then `workhorse_read_skill` by name (or `workhorse:desk`)
- Reading a skill returns instructions. It does not run scripts.
- If the skill needs files or shell, do that with workspace tools only when Permission and Sandbox allow it this turn.
