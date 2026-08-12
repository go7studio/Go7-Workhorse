# Go7 Workhorse

A native desktop shell for Grok, Claude, Codex, and any other bot you add later. One window. Projects and chats. One permission bar.

This repository is the first scaffold. The window is real. The agents are not wired yet.

## Goal

See [GOAL.md](GOAL.md). In short: a learnable Apple-like desktop shell, not a website, not a new model.

## Run

```bash
cd C:\Users\lgovo\Projects\Go7-Workhorse
npm install
npm run dev
```

`npm run dev` opens the **Workhorse window**. It does not use Chrome as the app.

## How to use the scaffold

1. **New project** — give it a name. No folder required.
2. **Chat** from that project, or **New chat** from the welcome screen (creates an Untitled project).
3. **Link folder** or **Add reference** when you want files, URLs, or notes on the project. Several folders are allowed.
4. **New chat** starts with the last model. Change vendor, model, and brain level from the menu on the composer.
5. **Talk in preview** — messages stay local so you can learn the layout.
6. **Type `/`** — command palette.
7. **`/demo-permission`** — shows Allow once / Allow for session / Deny.

| Command | What it does |
|---|---|
| `/new` | Back to this project’s home |
| `/project` | Create a project |
| `/link` | Link a folder to this project |
| `/providers` | Back to the project home |
| `/ask` `/accept-edits` `/always-approve` | Permission mode |
| `/theme` | Light, dark, or system |
| `/model` | Switch model (`/model grok-4.6`) |
| `/effort` | Brain level (`low` `medium` `high` `extra`) |
| `/settings` | Profile, connected LLMs, custom API, usage |
| `/usage` | Open Settings → Usage |
| `/quit` | Close the app |

## Layout

```
electron/     window, folder dialog, saved state
src/lib/      types, store, commands, provider list
src/ui/       sidebar, welcome, project home, chats, sheets
src/styles/   tokens and layout
```

State is saved under Electron `userData` as `workhorse-state.json`.

## Next

- Grok adapter (`grok agent stdio`)
- Claude and Codex ACP adapters
- Sign-in status from each vendor’s existing login
- Real tool-permission forwarding

Each adapter should implement the same small contract: start in a folder, send a prompt, stream events, ask for permission, resume, and call `recordUsage` with that vendor’s tokens.
