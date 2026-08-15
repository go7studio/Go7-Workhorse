# Go7 Workhorse

A native desktop shell for Grok, Claude, Codex, and any other bot you add later. One window. Projects and chats. One permission bar.

This repository is the desktop shell. Grok and Claude use ACP. Codex keeps ACP as its prompt fallback and also has an App Server boundary for native history and capability discovery. Custom is live HTTP.

## Goal

See [GOAL.md](GOAL.md). In short: a learnable Apple-like desktop shell, not a website, not a new model.

## Run

```bash
cd C:\Users\lgovo\Projects\Go7-Workhorse
npm install
npm run dev
```

`npm run dev` opens the **Workhorse window**. It does not use Chrome as the app.

## Install on Windows

```bash
npm install
npm run dist:win
```

Run `release/Workhorse-Setup-<version>.exe` to install the branded **Workhorse** desktop application. The installer creates Start-menu and Desktop shortcuts and preserves the existing Workhorse projects and chats when updating or uninstalling.

## Install on macOS

```bash
npm install
npm run dist:mac
```

On a Mac, that writes `release/Workhorse-<version>-mac.dmg`, `release/Workhorse-<version>-mac.zip`, and the unpacked `Workhorse.app`. The build is unsigned (`identity: null`); Gatekeeper may require right-click → Open the first time. Vendor CLIs (Grok, Codex, Claude) are not bundled — they must already be installed on the machine.

## How to use the scaffold

1. **New project** — give it a name. No folder required.
2. **Chat** from that project, or **New chat** from the welcome screen (creates an Untitled project).
3. **Link folder** or **Add reference** when you want files, URLs, or notes on the project. Several folders are allowed.
4. **New chat** starts with the last model. Change vendor, model, and brain level from the menu on the composer.
5. **Talk** — Grok, Codex, and Claude run live. Custom uses the HTTP bot you created.
6. **Type `/`** — command palette.
7. **`/demo-permission`** — shows Allow once / Allow for session / Deny.
8. **Review / Terminal** — inspect the real Git working tree or open a shell scoped to this chat's local folder or worktree.

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
| `/schedule 30m …` | Persist a one-shot background run and execute it in this chat when due |
| `/schedule every 30m …` | Create a recurring, restart-safe background run |
| `/compact` | Compact natively when available, otherwise create a portable Workhorse checkpoint |
| `/goal objective` | Start a quiet Workhorse goal; use `pause`, `resume`, `status`, or `clear` without adding control turns to the transcript |
| `/quit` | Close the app |

## Layout

```
electron/     window, folder dialog, saved state
src/lib/      types, store, commands, provider list
src/ui/       sidebar, welcome, project home, chats, sheets
src/styles/   tokens and layout
```

State is saved under Electron `userData` as a versioned `workhorse-state.json`. Writes are atomic, three protected backup generations are retained, older saves migrate on load, and a corrupt primary falls back to the newest compatible backup. Custom API keys are removed from normal state and backups and stored through Electron's OS-backed encrypted storage. The app refuses to persist a plaintext key when OS encryption is unavailable.

Grok chats use `grok agent stdio`. Codex chats use `@agentclientprotocol/codex-acp` (or `CODEX_ACP_BIN`) with `CODEX_PATH` pointed at the installed `codex.exe`; when that CLI exposes `codex app-server`, Settings can also show native Codex threads, child-thread relationships, hooks, and runtime capabilities. Claude chats use `@agentclientprotocol/claude-agent-acp` (or `CLAUDE_ACP_BIN`) with `CLAUDE_CODE_EXECUTABLE` pointed at the installed `claude.exe`. Custom chats call any Anthropic/OpenAI-compatible URL the user adds.

Each chat can execute in the linked local folder or a managed detached Git worktree. Permission mode, filesystem sandbox, network access, and outside-workspace/root access are separate settings. Workhorse applies the shared security boundary before translating an approval to a vendor; Codex also receives supported controls through its native config.

## Provider-neutral harness features

- A canonical portable transcript follows a chat when its provider changes, and portable checkpoints restore compacted context for providers without native compaction.
- The provider capability registry drives controls instead of implying that every vendor supports the same native operations.
- Custom Anthropic Messages and OpenAI Chat Completions bots can use configured MCP servers through the same normalized approval and result path as built-in tools.
- Electron main journals queues, one-shot and recurring schedules, and active goals. Dispatched work is recovered after an app-process restart.
- Cross-provider subagents have explicit lifecycle records, runtime and token ceilings, cascading cancellation, changed-file review, shared-workspace conflict warnings, and managed-worktree isolation when the project supports it.
- The sidebar searches chat titles and message text across projects. Its attention inbox retains permission requests, failed scheduled work, failed subagents, and conflict warnings until dismissed.
- Settings can export a support-safe provider report. It excludes prompts, messages, file contents, environment variables, URLs, and credential values.

Custom OpenAI-compatible HTTP support intentionally targets Chat Completions. This project does not implement the OpenAI Responses API or Azure OpenAI deployment routing.

Run `npm run build` for the production TypeScript/Vite build and `npm test` for the complete adapter and shell suite.
