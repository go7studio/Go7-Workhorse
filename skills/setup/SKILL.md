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

A Workhorse project is a sidebar folder on the desk, not a git repo.

1. `workhorse_list_projects` first so you do not duplicate a name.
2. `workhorse_create_project` with `name` (and optional `folder` to link a path).
3. After it succeeds, tell the user it is under Projects.

When they say “create a project” in this app, do that. Do not ask them to click New project.

## References

Pin a URL, note, or file on this project (Project home → References):

- `workhorse_list_references` first if you might duplicate
- `workhorse_add_reference` with `value` (optional `kind` / `label`)
- `workhorse_delete_reference` by label or URL

## Skills

Desk skills include Grok, Codex, Claude, and **Workhorse** (`desk`, `setup`).

- `workhorse_list_skills` then `workhorse_read_skill` by name (or `workhorse:desk`)
- Reading a skill returns instructions. It does not run scripts.
- If the skill needs files or shell, do that with workspace tools only when Permission and Sandbox allow it this turn.
