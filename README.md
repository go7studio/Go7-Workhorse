# Go7 Workhorse

A native desktop shell for Grok, Claude, Codex, and any other bot you add later. One window. One project folder. One permission bar.

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

1. **Open a project** — native folder picker. That directory is the workspace, the way Codex binds a thread to a folder.
2. **Pick a brain** — Grok, Claude, Codex, or Custom. Each card is a future adapter. None are marked signed-in yet.
3. **Talk in preview** — messages stay local so you can learn the layout.
4. **Type `/`** — command palette.
5. **`/demo-permission`** — shows Allow once / Allow for session / Deny.

| Command | What it does |
|---|---|
| `/new` | New session in this project |
| `/project` | Open another folder |
| `/providers` | Back to the brain picker |
| `/ask` `/accept-edits` `/always-approve` | Permission mode |
| `/theme` | Light, dark, or system |
| `/quit` | Close the app |

## Layout

```
electron/     window, folder dialog, saved state
src/lib/      types, store, commands, provider list
src/ui/       sidebar, welcome, picker, session, permissions
src/styles/   tokens and layout
```

State is saved under Electron `userData` as `workhorse-state.json`.

## Next

- Grok adapter (`grok agent stdio`)
- Claude and Codex ACP adapters
- Sign-in status from each vendor’s existing login
- Real tool-permission forwarding

Each adapter should implement the same small contract: start in a folder, send a prompt, stream events, ask for permission, resume.
