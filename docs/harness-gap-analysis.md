# Go7 Workhorse — AI harness gap analysis

> Historical baseline: this audit predates the live Claude/Codex/custom adapters and several outer-shell features. The current shipped status is summarized in `README.md` and `GOAL.md`. Vendor resume, sandbox controls, worktrees, Git review, a chat terminal, durable one-shot schedules, and the Codex App Server capability boundary have since landed. Statements below calling those adapters “stubs” are no longer current.

**Date:** 2026-08-12  
**Product:** [Go7 Workhorse](https://github.com/Spikey222/Go7-Workhorse) v0.1.0  
**Scope:** What Workhorse *is today*, what major agent harnesses already do, and which of those elements a multi-vendor **desktop outer shell** could usefully adopt.

This is an analysis document, not a roadmap commit. Nothing here implements adapters, skills, or UI.

---

## How to read this document

Workhorse is not trying to become Claude Code, Codex, or Hermes. Those products are **inner harnesses**: they own the model loop, tools, sandbox, skills, and vendor login.

Workhorse’s job, as written in `AGENTS.md`, is the **outer harness**:

> A native desktop shell for coding agents. Each vendor stays its own process. This app is the window, the project, the chats, the `/` palette, and the permission bar.

Gaps are therefore framed as **shell / orchestration benefits**, not “reimplement every vendor-private inner loop.”

| Label | Meaning |
|---|---|
| **Inner harness** | What a vendor CLI/agent already does (Grok already has skills, hooks, MCP, subagents, sandbox, plan mode, memory). |
| **Outer harness** | Workhorse’s job: one window, projects/chats, one permission inbox, adapters. |
| **Surface / orchestration gap** | The capability exists inside a *wired* vendor (today: Grok) but Workhorse does not surface or unify it. Not “Workhorse has no X.” |
| **Adapter gap** | The capability exists in a planned vendor (Claude, Codex, custom) but that adapter is not shipped. |
| **Outer-shell gap** | A control-plane feature no Workhorse surface has, even as a translation of a vendor protocol. |

Every gap below names (a) a competitor source and (b) a Workhorse file or current behavior that lacks it.

---

## Naming: “Hermies”

The OBJECTIVE names **Hermies**. This document treats that as **Hermes Agent** (Nous Research):

- Product site: <https://hermes-agent.org/>
- Docs: <https://hermes-agent.nousresearch.com/docs/>
- Repo: <https://github.com/NousResearch/hermes-agent>

No closer public product by that nickname was found. Hermes can import settings from **OpenClaw**; OpenClaw is a migration source, not the named product.

---

## 1. Workhorse as it is today

Claims in this section match `README.md`, `GOAL.md`, `AGENTS.md`, and current source. They do **not** treat Claude, Codex, or Custom as live.

### Product

Native Electron window (`electron/main.ts`). Not a website. State persists as Electron `userData` / `workhorse-state.json`.

A **project** is a named container (`src/lib/project.ts`). Folders and references (file / url / note) are optional links. **Chats belong to a project** (`src/lib/chats.ts`): rename, archive, delete, drag onto another project.

A chat starts, then the composer menu picks vendor, model, and brain effort (`src/lib/models.ts`). There is no brain picker in front of New chat.

Settings hold profile, connected LLMs, custom API, and usage (`src/ui/Settings.tsx`). Usage is not a sidebar item. Adapters are supposed to call `recordUsage` (`src/lib/usage.ts`). Preview chats must not invent tokens (`AGENTS.md`).

`/` opens a command palette (`src/lib/commands.ts`). A unified permission overlay presents **Allow once / Allow for session / Deny** (`src/ui/PermissionBar.tsx`).

### Provider slots — honest stubs except Grok

From `src/lib/providers.ts`, every catalog `connected` flag is hardcoded `false`:

| Slot | Tagline | What actually runs |
|---|---|---|
| **Grok** | “Grok Build via ACP” — “Adapter ready.” | **Live.** Electron main spawns `grok agent --no-leader … stdio` (`electron/grok-launch.ts`, `electron/grok-agent.ts`). |
| **Claude** | “Claude Code via ACP” — “Adapter next.” | **Stub.** Local echo: “Preview only. Claude would answer…” (`src/lib/store.tsx` `send()`). |
| **Codex** | “Codex CLI via ACP” — “Adapter next.” | **Stub.** Same preview echo. |
| **Custom** | “Any bot you drop in.” | **Stub.** Settings can store an OpenAI-compatible URL; no adapter uses it. |

Settings LLM toggles only flip `settings.llms.*.connected`. They do not detect vendor logins or spawn processes.

`GOAL.md` out of scope: Claude / Codex / custom live adapters, and a Grok subscription login UI.

### Adapter contract

`README.md`:

> Each adapter should implement the same small contract: start in a folder, send a prompt, stream events, ask for permission, resume, and call `recordUsage` with that vendor’s tokens.

Implemented **only** for Grok:

| Verb | Locus | Today |
|---|---|---|
| Start in a folder | `resolveSessionCwd` + `sessionParams.cwd` | First linked folder, else `process.cwd()`. Extra folders are ignored as cwd. |
| Prompt | IPC `grok:prompt` → ACP `session/prompt` | Renderer never calls the CLI. |
| Stream | ACP `session/update` → IPC `grok:event` | Text chunks, tool rows, compact, usage, permission, done, error. Thoughts are collected, not shown as a surface. |
| Permission | ACP `session/request_permission` | Mapped to once / session / deny. |
| Resume | `GrokSessionHost` process slot | Keeps the child while launch key (argv + cwd) matches. Changing model, effort, mode, or cwd **disposes and `session/new`s**. No ACP `session/load`. |
| `recordUsage` | IPC `usage` → `store.recordUsage` | Input / output / cache tokens + optional USD. |
| Extra | `grok:compact`, `grok:cancel` | `/compact`; `session/cancel`. |

Launch (`electron/grok-launch.ts`):

```
grok agent --no-leader [--always-approve] --model <id> --reasoning-effort <effort> stdio
```

- `always-approve` → `--always-approve` + `_meta.yoloMode`
- `accept-edits` → `_meta.autoMode` only
- `initializeParams.clientCapabilities` is `{}`
- `sessionParams.mcpServers` is always `[]`

### Commands and permission modes

Shell commands: `/new` `/project` `/link` `/providers` `/model` `/effort` `/compact` `/ask` `/accept-edits` `/always-approve` `/demo-permission` `/theme` `/settings` `/rename` `/archive` `/delete` `/usage` `/quit`.

No `/resume`, `/plan`, `/hooks`, `/skills`, `/mcp`, `/memory`, `/agents`, `/sandbox`.

Modes: `ask` | `accept-edits` | `always-approve`. There is no rule editor, sandbox profile picker, or plan-mode surface.

### What Grok’s inner harness already has (not Workhorse)

Local Grok user-guide (`~/.grok/docs/user-guide/`): skills, hooks, MCP, subagents/personas, sandbox profiles, plan mode, memory, ACP (`session/new`, `session/load`, `session/prompt`, `session/request_permission`), compact, background tasks, scheduler.

Workhorse does not reimplement these. When they are missing from the *window*, that is a **surface/orchestration** gap.

---

## 2. Competitor harnesses — defining elements

Each subsection cites official docs or the project repo.

### 2.1 Claude Code

**Sources:** [Overview](https://code.claude.com/docs/en/overview), [Skills](https://code.claude.com/docs/en/skills), [Hooks](https://code.claude.com/docs/en/hooks), [Sub-agents](https://code.claude.com/docs/en/sub-agents), [Memory](https://code.claude.com/docs/en/memory), [Agent view](https://code.claude.com/docs/en/agent-view).

> Claude Code is an agentic coding tool that reads your codebase, edits files, runs commands, and integrates with your development tools. Available in your terminal, IDE, desktop app, and browser.

| Element | What it is |
|---|---|
| Tools | Read/edit/write, Bash/PowerShell, web, MCP, Agent (spawn subagent). |
| Permissions | Modes (ask, acceptEdits, plan, dontAsk, bypassPermissions) plus path/command rules. Skills can grant `allowed-tools` for one turn. |
| Memory / session | `CLAUDE.md` always loaded; auto memory (`MEMORY.md` + on-demand topic files); resume; compaction that re-attaches recent skills. |
| Skills / hooks | `SKILL.md` (Agent Skills standard). Hooks at SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, Stop, SubagentStart/Stop, PreCompact, WorktreeCreate, and more. Hooks can deny a tool before it runs. |
| Subagents / orchestration | Named specialists with their own context, tools, and permissions. Agent teams. **Agent view** lists many sessions and which ones need input. Isolation via git worktrees. |
| Long-running / resume | Desktop + web + cloud; routines; `/loop`; teleport (`claude --teleport`); Remote Control from phone. |
| Sandbox | OS-level filesystem/network plus permission rules. |
| Surfaces | Terminal, VS Code, JetBrains, Desktop, Web, Slack, GitHub Actions, Agent SDK. |

**For Workhorse:** Claude is a **planned ACP adapter**, not shipped. Do not clone CLAUDE.md, skills, or hooks. Do adopt the *outer* ideas: one inbox for permission requests, a place to see which sessions need input, and a way to resume a vendor session after the window restarts.

### 2.2 Codex CLI (OpenAI)

**Sources:** [Codex CLI](https://learn.chatgpt.com/docs/codex/cli), [Sandboxing](https://learn.chatgpt.com/codex/sandboxing), [Hooks](https://learn.chatgpt.com/codex/hooks), plus official pages for [subagents](https://learn.chatgpt.com/codex/agent-configuration/subagents), [MCP](https://learn.chatgpt.com/codex/extend/mcp), [skills & plugins](https://learn.chatgpt.com/codex/skills-and-plugins).

> Inspect code, make changes, run commands, and automate repeatable work without leaving your terminal.

> The sandbox is the boundary that lets the agent act autonomously without giving it unrestricted access to your machine. … Sandboxing and approvals are different controls that work together.

| Element | What it is |
|---|---|
| Tools | Local inspect/edit/run; web search; image inputs (`codex --image`); MCP; dedicated `/review`. |
| Permissions | `/permissions` picker. Approval policy `untrusted` / `on-request` / `never`. Optional `approvals_reviewer = auto_review`. |
| Memory / session | `codex resume` (and `codex exec resume`); AGENTS.md; memories; chronicle. |
| Skills / hooks | Skills + plugin marketplace. `hooks.json` / `[hooks]` for SessionStart/End, PreToolUse, PermissionRequest, PostToolUse, Stop, SubagentStart/Stop, PreCompact. Non-managed hooks must be **reviewed and trusted** (`/hooks`). |
| Subagents / orchestration | Delegate focused work; Codex can itself be an MCP server (`codex()` / `codex-reply()`). |
| Long-running / resume | Resume local chats; `codex cloud`; scheduled tasks; git worktrees. |
| Sandbox | `read-only` / `workspace-write` / `danger-full-access` plus writable roots. Seatbelt / bubblewrap / Windows sandbox. |
| Surfaces | CLI, IDE, ChatGPT desktop, cloud, GitHub Action, App Server, SDK. |

**For Workhorse:** Codex is a **planned ACP adapter**, not shipped. The split “sandbox ≠ approvals” is the useful outer idea: Workhorse already has an approval bar; it has no sandbox/profile control and no resume of a saved vendor chat.

### 2.3 Hermes Agent (Nous Research) — “Hermies”

**Sources:** [Docs home](https://hermes-agent.nousresearch.com/docs/), [Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory), [Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills), [GitHub](https://github.com/NousResearch/hermes-agent), [hermes-agent.org](https://hermes-agent.org/).

> The self-improving AI agent built by Nous Research. The only agent with a built-in learning loop — it creates skills from experience, improves them during use, nudges itself to persist knowledge, and builds a deepening model of who you are across sessions.

| Element | What it is |
|---|---|
| Tools | 60+ tools in toolsets. Terminal backends: local, Docker, SSH, Daytona, Singularity, Modal, Vercel Sandbox. |
| Permissions | Command approval; container isolation; `memory.write_approval` / `skills.write_approval`; hub skill scanner. |
| Memory / session | Bounded MEMORY.md + USER.md injected at session start; FTS5 `session_search` over all past chats; `/journey` learning graph; optional Honcho. |
| Skills / hooks | Agent Skills standard; agent-created skills (`skill_manage`); Skills Hub; `/learn`; skill bundles; background review that writes memory/skills. |
| Subagents / orchestration | Isolated subagents; programmatic tool calling via `execute_code`. |
| Long-running / resume | Built-in cron delivered to any messaging platform; serverless backends that hibernate when idle. |
| Sandbox | Container / backend isolation plus approval. |
| Surfaces | CLI, TUI, Desktop, 20+ messaging platforms on one gateway. Repo includes `acp_adapter`. |

**For Workhorse:** Hermes is **not** a Workhorse provider slot today. The learning loop is inner — do not reimplement MEMORY.md or skill self-improvement. The outer ideas worth stealing are: **search across chats**, a **gateway that fans one agent to many surfaces**, and **remote/sandboxed backends** that are not the laptop filesystem.

### 2.4 Gemini CLI

**Sources:** [Docs](https://geminicli.com/docs/), [Plan mode](https://geminicli.com/docs/cli/plan-mode), [Checkpointing](https://geminicli.com/docs/cli/checkpointing), [github.com/google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli).

> Gemini CLI brings the power of Gemini models directly into your terminal.

> Plan Mode is a read-only environment for architecting robust solutions before implementation.

| Element | What it is |
|---|---|
| Tools | Filesystem, shell, web fetch/search, MCP, skills, research subagents. |
| Permissions | Approval modes Default → Auto-Edit → Plan (Shift+Tab). Policy engine (`plan.toml` + `~/.gemini/policies/`). Trusted folders. |
| Memory / session | GEMINI.md; session browser; rewind; checkpointing (`/restore` uses a **shadow git** of files + conversation + the pending tool). |
| Skills / hooks | Agent Skills; extensions gallery; hooks including AfterTool on `exit_plan_mode`. |
| Subagents / orchestration | Local and remote subagents (docs mark some as experimental). |
| Long-running / resume | Checkpoints; 30-day session retention; headless; plan→implement model routing (Pro then Flash). |
| Sandbox | Isolated tool execution + plan-mode tool allowlist. |
| Surfaces | Terminal, IDE integration, extensions. Some unpaid tiers are slated to move to Antigravity CLI. |

**For Workhorse:** Gemini is not a slot today. Checkpoint/restore (files + transcript + the blocked tool) and a first-class **Plan** mode in the mode cycle are the outer-facing pieces.

### 2.5 OpenCode

**Sources:** [Intro](https://opencode.ai/docs/), [Agents](https://opencode.ai/docs/agents/), [opencode.ai](https://opencode.ai/).

> OpenCode is an open source AI coding agent. It’s available as a terminal-based interface, desktop app, or IDE extension.

| Element | What it is |
|---|---|
| Tools | Read/write/edit, bash, LSP, web, skills. |
| Permissions | Per-tool `allow` / `ask` / `deny`, including bash globs (`git push`: ask). Plan agent defaults edits and bash to `ask`. |
| Memory / session | `/init` writes AGENTS.md; multi-session; `/undo` `/redo`; `/share` public transcript; auto-compact. |
| Skills / hooks | Custom commands; formatters; JSON/markdown agent defs. |
| Subagents / orchestration | Primary **Build** and **Plan** (Tab). Subagents General, Explore, Scout. Navigate parent/child sessions with arrow keys. |
| Long-running / resume | Several agents in parallel on the same project. |
| Sandbox | Permission model (no separate OS-sandbox product page). |
| Surfaces | TUI, desktop, IDE; 75+ providers via Models.dev. |

**For Workhorse:** OpenCode is the closest **UX** cousin: desktop + projects + Plan/Build as a mode, undo, share. Workhorse already has projects/chats and a permission bar. It does not have Plan as a mode, undo, share, or child-session navigation.

### 2.6 OpenHands

**Sources:** [Introduction](https://docs.openhands.dev/overview/introduction), [Agent Canvas](https://docs.openhands.dev/openhands/usage/agent-canvas/overview), [ACP Agents](https://docs.openhands.dev/openhands/usage/agent-canvas/acp-agents), [openhands.dev](https://www.openhands.dev/).

> The Agent Client Protocol (ACP) is a standard for talking to coding agents over JSON-RPC on stdio. Instead of Agent Canvas calling an LLM directly, the Agent Server spawns the agent's own CLI as a subprocess and relays each turn to it. The external agent manages its own LLM, tools, and execution; Agent Canvas sends messages and renders what comes back.

> Agent Canvas is an open-source control surface for agentic work. From one place, you can manage conversations, files, terminals, model configuration, backends, and automations.

| Element | What it is |
|---|---|
| Tools | Built-in OpenHands tools *or* the vendor’s own tools when the backend is an ACP agent. |
| Permissions / sandbox | Trust boundary is the **backend**: local npm, Docker mounts, VM, or Cloud sandbox. |
| Memory / session | Conversation belongs to one backend; branch a conversation; backend keeps state if the browser closes (Docker/VM/cloud). |
| Skills / hooks | Automations (scheduled / event-driven). |
| Subagents / orchestration | Multi-backend. ACP presets: Claude Code (`@agentclientprotocol/claude-agent-acp`), Codex (`@zed-industries/codex-acp`), Gemini (`gemini --acp`). Custom ACP command. |
| Long-running / resume | Always-on VM/cloud; automations. |
| Sandbox | Docker / Cloud sandboxes. |
| Surfaces | Browser Canvas, desktop preview, CLI, SDK, Cloud, Enterprise. |

**For Workhorse:** OpenHands Agent Canvas is the closest **architecture** cousin: an outer shell that hosts vendor CLIs over ACP and reuses the machine’s existing login. Workhorse already chose this shape for Grok (`grok agent stdio`). Claude and Codex adapters are still stubs. OpenHands also has **backends** (where the agent runs) separate from **conversations** (the chat). Workhorse has only “this Electron process + first linked folder.”

---

## 3. Inner vs outer — what Grok already covers

Do not list these as “Workhorse has no X” when Grok already implements them internally:

| Inner capability | Grok (inner) | Workhorse (outer) today |
|---|---|---|
| Skills | `.grok/skills`, Claude/Cursor compat | Not listed, invoked, or trusted in the shell |
| Hooks | `~/.grok/hooks`, folder trust | Not shown |
| MCP | `~/.grok/config.toml` | `mcpServers: []` always |
| Subagents | `spawn_subagent`, explore/plan | Tool rows only; no child-session UI |
| Sandbox | `--sandbox workspace\|read-only\|strict` | Not passed; no picker |
| Plan mode | `/plan`, `enter_plan_mode` | No mode, no plan preview |
| Memory | `--experimental-memory`, `/memory` | Not surfaced |
| ACP session load | `session/load` in agent mode | Host always `session/new` |
| Compact | `x.ai/compact_conversation` | **Surfaced** via `/compact` |
| Permissions | ACP `session/request_permission` | **Surfaced** as the unified bar |
| Usage | Turn usage events | **Surfaced** via `recordUsage` |

A gap that already exists inside Grok but is not unified in Workhorse is labeled **surface/orchestration**.

---

## 4. Gap list

Each item: competitor source, Workhorse locus, label, benefit.

### G1 — Resume the vendor session, not just the Electron chat

- **Source:** Codex [`codex resume`](https://learn.chatgpt.com/docs/codex/cli) (“Reopen a recent chat from the current repository”). Grok ACP documents `session/load` ([Agent mode](file://C:/Users/lgovo/.grok/docs/user-guide/15-agent-mode.md)). Gemini session browser + `/restore`.
- **Workhorse locus:** `electron/grok-host.ts` `ensureAgent` always `session/new` when the launch key changes or the process is gone. `src/lib/store.tsx` persists *renderer* messages only. No `/resume`. Adapter contract says “resume” but Grok does not call `session/load`.
- **Label:** Surface/orchestration (Grok); adapter (Claude/Codex).
- **Benefit:** Closing the window or switching model today starts a new inner session. The user thinks they are continuing a chat; the vendor has forgotten tools, todos, and compact checkpoints. An outer shell should persist the ACP `sessionId` and reload it.

### G2 — Plan as a first-class shell mode

- **Source:** Gemini [Plan Mode](https://geminicli.com/docs/cli/plan-mode) (Shift+Tab cycle; read-only except the plan file). OpenCode [Build vs Plan](https://opencode.ai/docs/agents/). Grok plan mode; Claude permission mode `plan`.
- **Workhorse locus:** `PermissionMode` is only `ask` | `accept-edits` | `always-approve` (`src/lib/types.ts`). No `/plan`, no plan preview, no approve/request-changes bar.
- **Label:** Surface/orchestration (Grok); adapter (others).
- **Benefit:** The shell already cycles permission modes. Adding Plan (read-only research, then a reviewable `plan.md`) is an outer control, not a new planner. Grok already writes the plan file.

### G3 — Separate sandbox from approvals

- **Source:** Codex [Sandboxing](https://learn.chatgpt.com/codex/sandboxing): sandbox = technical boundary; approvals = when to ask. Modes `read-only` / `workspace-write` / `danger-full-access`. Grok `--sandbox workspace|read-only|strict`.
- **Workhorse locus:** `src/ui/PermissionBar.tsx` answers once/session/deny. `electron/grok-launch.ts` `buildGrokLaunchSpec` only maps `always-approve` / `autoMode`. No `--sandbox` flag.
- **Label:** Surface/orchestration.
- **Benefit:** Approvals without a sandbox is “trust the model.” A desktop outer shell can expose the vendor’s existing profiles (and later translate Claude/Codex equivalents) without implementing Landlock/Seatbelt itself.

### G4 — Permission *policy*, not only a prompt

- **Source:** OpenCode [agent permissions](https://opencode.ai/docs/agents/) (`allow`/`ask`/`deny` per tool and bash glob). Claude permission rules. Codex `/permissions` + rules. Gemini policy engine.
- **Workhorse locus:** `src/lib/permissions.ts` only applies one pending card. No rule list. `/demo-permission` is UI rehearsal.
- **Label:** Outer-shell gap (unified policy UI); surface (vendors already have rules).
- **Benefit:** One inbox is right. Users still need a durable “never `rm -rf` / always allow `git status`” that the shell stores and each adapter translates.

### G5 — Attach MCP at session start

- **Source:** Claude [MCP](https://code.claude.com/docs/en/mcp); Codex [`codex mcp`](https://learn.chatgpt.com/codex/extend/mcp); Hermes [MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp); Gemini [MCP servers](https://geminicli.com/docs/tools/mcp-server/); Grok `mcp_servers` in `~/.grok/docs/user-guide/07-mcp-servers.md`.
- **Workhorse locus:** `electron/grok-launch.ts` `sessionParams.mcpServers: []`. Settings have no MCP list. `AGENTS.md` says tools attach to a runtime, not extra tabs — but nothing attaches them.
- **Label:** Surface/orchestration.
- **Benefit:** The outer shell should pass the user’s MCP servers into ACP `session/new` (or let the vendor load its own). Empty `mcpServers` means Workhorse *strips* integrations the inner harness already has unless Grok reads them from disk independently.

### G6 — Surface skills / hooks / folder trust (do not reimplement)

- **Source:** Claude [Skills](https://code.claude.com/docs/en/skills) + [Hooks](https://code.claude.com/docs/en/hooks); Codex [Hooks](https://learn.chatgpt.com/codex/hooks) (`/hooks` review and trust); Hermes Skills Hub + write-approval; Grok skills/hooks + `/hooks-trust`.
- **Workhorse locus:** `src/lib/commands.ts` has no `/skills` or `/hooks`. `electron/grok-launch.ts` does not pass `--trust`.
- **Label:** Surface/orchestration.
- **Benefit:** Show what the running vendor loaded, and gate project hooks once in the shell. Implementing SKILL.md execution in Electron would be cloning the inner loop.

### G7 — Parallel sessions and “needs input” roster

- **Source:** Claude [Agent view](https://code.claude.com/docs/en/agent-view) (“what every session is doing and which ones need your input”). OpenCode multi-session + child-session navigation. OpenHands conversations per backend.
- **Workhorse locus:** Sidebar lists chats; `pending[0]` is the only permission shown (`PermissionBar.tsx`). One active session in the pane.
- **Label:** Outer-shell gap.
- **Benefit:** A multi-vendor window will have several children asking for permission. A roster (“Grok needs Allow on `git push` · Claude is running tests”) is exactly the outer inbox `AGENTS.md` describes, extended past a single modal.

### G8 — Child / subagent as a navigable session

- **Source:** OpenCode [parent/child session navigation](https://opencode.ai/docs/agents/). Claude [sub-agents](https://code.claude.com/docs/en/sub-agents) + [agent view](https://code.claude.com/docs/en/agent-view). Grok `spawn_subagent` (`~/.grok/docs/user-guide/16-subagents.md`).
- **Workhorse locus:** `src/lib/grok-events.ts` `upsertToolMessage` flattens tool calls to system rows. `src/lib/types.ts` `Session` has no child/parent id.
- **Label:** Surface/orchestration.
- **Benefit:** Users cannot open the explore/plan child, cancel it, or see its permission separately. The shell should treat a subagent as a chat-like object *if* the vendor streams one.

### G9 — Undo / rewind / checkpoints

- **Source:** OpenCode `/undo` `/redo`. Gemini [Checkpointing](https://geminicli.com/docs/cli/checkpointing) (`/restore` = shadow git + conversation + pending tool). Grok rewind points. Codex recommends git checkpoints.
- **Workhorse locus:** `src/lib/store.tsx` only appends messages. `cancelRun` exists; no rewind. No file snapshot.
- **Label:** Surface/orchestration (vendor rewind); outer (file checkpoint UI).
- **Benefit:** Desktop users expect “that edit was wrong.” Prefer forwarding `/rewind` or Gemini-style restore to the inner harness over inventing a third history.

### G10 — Long-running work, cloud, and schedules

- **Source:** Codex [cloud](https://learn.chatgpt.com/codex/cloud) + [scheduled tasks](https://learn.chatgpt.com/codex/automations). Claude [routines](https://code.claude.com/docs/en/routines). Hermes [cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron). Grok `~/.grok/docs/user-guide/20-background-tasks.md`.
- **Workhorse locus:** `electron/main.ts` `grok:prompt` is one in-process run. `src/lib/commands.ts` has no scheduler. No cloud handoff.
- **Label:** Outer-shell gap (control plane); surface (Grok already has tools).
- **Benefit:** The shell is the place to list “jobs” across vendors. Do not write a new cron inside Electron if the vendor already has one — show and trigger it.

### G11 — Execution backends (where the agent runs)

- **Source:** OpenHands [backends](https://docs.openhands.dev/openhands/usage/agent-canvas/overview). Hermes terminal backends ([docs](https://hermes-agent.nousresearch.com/docs/)). Codex [cloud environments](https://learn.chatgpt.com/codex/environments/cloud-environment).
- **Workhorse locus:** One local child process. Cwd = `folders[0]`. `AGENTS.md`: “Do not merge … sandboxes across vendors” — but there is no sandbox/backend object at all.
- **Label:** Outer-shell gap.
- **Benefit:** A Workhorse *project* could link a folder **or** a Docker/SSH backend per vendor, without merging sandboxes. That is the next step after “named container + optional folders.”

### G12 — Detect vendor login instead of a manual toggle

- **Source:** OpenHands [ACP Agents](https://docs.openhands.dev/openhands/usage/agent-canvas/acp-agents): reuse `~/.claude/.credentials.json`, `~/.codex/auth.json`, `~/.gemini/oauth_creds.json`; login beats API key.
- **Workhorse locus:** `src/ui/Settings.tsx` “Use local login” is a boolean. Grok just inherits `process.env` and `~/.grok`.
- **Label:** Adapter / outer.
- **Benefit:** Honest stubs stay honest until an adapter exists; when it does, connected should mean “CLI login found,” matching `GOAL.md` (“Sign-in status from each vendor’s existing login”).

### G13 — Finish Claude and Codex ACP adapters (and optionally Gemini / Hermes)

- **Source:** OpenHands [ACP Agents](https://docs.openhands.dev/openhands/usage/agent-canvas/acp-agents) (Claude / Codex / Gemini presets). Hermes [`acp_adapter`](https://github.com/NousResearch/hermes-agent/tree/main/acp_adapter). Workhorse `README.md` Next: “Claude and Codex ACP adapters.”
- **Workhorse locus:** `src/lib/store.tsx` preview echo for non-Grok. No `claude-agent.ts` / `codex-agent.ts`.
- **Label:** Adapter gap (explicitly planned, **not shipped**).
- **Benefit:** This is the product. OpenHands proves the outer-shell pattern. Workhorse should stay thinner than Canvas (no file browser required) but the spawn-ACP-stdio contract is the same.

### G14 — Pass client capabilities and extra directories

- **Source:** Claude [additional directories](https://code.claude.com/docs/en/skills) (`--add-dir`). [ACP](https://agentclientprotocol.com) client capabilities. Grok initialize in `~/.grok/docs/user-guide/15-agent-mode.md`.
- **Workhorse locus:** `electron/grok-launch.ts` `clientCapabilities: {}`. Only `folders[0]` is cwd (`src/lib/store.tsx` `send`). Project `references` never enter the prompt.
- **Label:** Surface/orchestration.
- **Benefit:** Linked folders after the first, plus URL/note references, should become ACP extra roots or prompt context. Otherwise the project model is decorative.

### G15 — Visual / image context in the composer

- **Source:** Codex `codex --image` ([CLI](https://learn.chatgpt.com/docs/codex/cli)). OpenCode drag-and-drop images. Claude desktop diffs.
- **Workhorse locus:** Composer is text (`src/ui/Composer.tsx`). ACP prompt is `[{ type: "text", text }]`.
- **Label:** Outer-shell gap (composer); adapter (image content blocks).
- **Benefit:** Screenshots of errors are how people actually brief agents. The shell should accept an image and pass the vendor’s content type.

### G16 — Search chats and (optionally) show vendor memory

- **Source:** Hermes [session_search](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory) (FTS5 over all sessions). Codex resume search. Claude `/resume`. Grok session dashboard.
- **Workhorse locus:** `src/ui/Sidebar.tsx` is a flat list. `src/lib/commands.ts` has no search. Chats persist only via `electron/main.ts` `workhorse-state.json`.
- **Label:** Outer-shell gap (search); surface (Grok `/memory`).
- **Benefit:** A project with dozens of chats needs search. Surfacing “Grok memory is on” is enough; do not build Hermes MEMORY.md in the shell.

### G17 — Dedicated review loop

- **Source:** Codex [code review](https://learn.chatgpt.com/codex/code-review). Claude bundled `/code-review` ([skills](https://code.claude.com/docs/en/skills)).
- **Workhorse locus:** `src/lib/commands.ts` has no `/review`. A chat can *ask* for review in prose.
- **Label:** Surface/orchestration.
- **Benefit:** A `/review` that starts a chat in ask/read-only mode (or Plan) is an outer shortcut, not a new reviewer model.

### G18 — Share / export a transcript

- **Source:** OpenCode [`/share`](https://opencode.ai/docs/) (explicit, off by default).
- **Workhorse locus:** No export command in `src/lib/commands.ts`. State is `electron/main.ts` `workhorse-state.json` only.
- **Label:** Outer-shell gap.
- **Benefit:** Useful for support and pairing. Keep default private.

### G19 — Worktrees for isolated agent edits

- **Source:** Claude [worktrees](https://code.claude.com/docs/en/agent-view); Codex [git worktrees](https://learn.chatgpt.com/codex/environments/git-worktrees).
- **Workhorse locus:** Agent writes in `src/lib/project.ts` linked `folders[0]` (`electron/grok-host.ts` `resolveSessionCwd`). No worktree helper.
- **Label:** Outer-shell gap.
- **Benefit:** Parallel chats on one project will collide. Creating a worktree per chat is shell orchestration; the vendor then just gets a cwd.

### G20 — Thought / reasoning surface

- **Source:** Grok ACP thought chunks (`electron/grok-agent.ts` `THOUGHT_UPDATE_KINDS`; `~/.grok/docs/user-guide/15-agent-mode.md`).
- **Workhorse locus:** `electron/grok-agent.ts` collects thoughts and may dump them as the reply if there is no message text. `src/ui/SessionPane.tsx` has no thought block.
- **Label:** Surface/orchestration.
- **Benefit:** Users cannot tell planning from the answer. Cheap: a collapsible thought block on the same event stream.

### G21 — ACP client as a real client (empty capabilities)

- **Source:** [ACP](https://agentclientprotocol.com) (sessions, prompts, tool updates, permissions). OpenHands and Grok both speak it.
- **Workhorse locus:** `protocolVersion: 1`, `clientCapabilities: {}`. Incoming methods other than `session/request_permission` return `-32601`.
- **Label:** Surface/orchestration.
- **Benefit:** Vendors gate features (fs, terminal, session/load) on client capabilities. An empty object silently disables inner features.

---

## 5. Priority for a multi-vendor outer shell

What actually benefits Workhorse’s stated job (one window, projects, one inbox, adapters):

1. **G13** Claude/Codex ACP adapters (the product).
2. **G1** Persist and `session/load` vendor sessions.
3. **G12** Detect local logins.
4. **G3 + G4** Sandbox profile + durable permission policy, still one inbox.
5. **G2** Plan mode in the existing mode cycle.
6. **G5 + G14 + G21** Pass MCP, extra folders/references, and client capabilities into `session/new`.
7. **G7 + G8** Needs-input roster and child sessions.
8. **G9 / G11 / G10** Rewind, backends, jobs — after the above.

Do **not** prioritize cloning Hermes’ learning loop, Claude’s plugin marketplace, or Codex cloud. Those stay inner.

---

## 6. What not to copy

- A second skills runtime, hooks engine, or MCP host inside Electron.
- Merged context, subscriptions, or sandboxes across vendors (`AGENTS.md`).
- Pretending Claude/Codex are connected (`providers.ts` / preview echo must stay honest until adapters exist).
- SWE-bench tables or “best model” rankings — out of scope.
- OpenHands-scale file browser / terminal / Canvas unless the product goal changes. Workhorse’s advantage is a *quiet* Apple-like window.

---

## Appendix — other harnesses (not in the required set)

These did not fail the analysis by being omitted. Short notes only:

| Harness | Why it exists | Relevance to Workhorse |
|---|---|---|
| **Cursor** | IDE-native inner harness; `.cursor/skills`, hooks, rules. | Grok already reads Cursor skills for compat. Not a Workhorse slot. |
| **Cline** | VS Code agent with approvals and MCP. | Same permission-inbox lesson as Claude. |
| **Aider** | Git-centric CLI, explicit apply. | Checkpoint/commit discipline (see G9). |
| **Goose** | Block/recipe local agent (Goose). | Recipe ≈ skill; not a new outer pattern. |

---

## Sources (index)

- Workhorse: `README.md`, `GOAL.md`, `AGENTS.md`, `src/lib/providers.ts`, `src/lib/commands.ts`, `src/lib/types.ts`, `src/lib/store.tsx`, `src/lib/permissions.ts`, `electron/grok-agent.ts`, `electron/grok-host.ts`, `electron/grok-launch.ts`, `electron/main.ts`
- Grok inner: `~/.grok/docs/user-guide/` (skills, hooks, MCP, subagents, sandbox, plan mode, memory, agent/ACP)
- Claude Code: https://code.claude.com/docs/en/overview
- Codex CLI: https://learn.chatgpt.com/docs/codex/cli
- Hermes Agent: https://hermes-agent.nousresearch.com/docs/
- Gemini CLI: https://geminicli.com/docs/
- OpenCode: https://opencode.ai/docs/
- OpenHands: https://docs.openhands.dev/overview/introduction
- ACP: https://agentclientprotocol.com
