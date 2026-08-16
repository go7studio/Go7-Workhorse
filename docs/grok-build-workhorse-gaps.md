# Grok Build vs Workhorse

What **Grok Build** (xAI’s coding agent: TUI, headless CLI, ACP) can do that **Workhorse** does not support as its own product surface, or does not pass through to the live Grok adapter.

This is an inventory, not a roadmap. Workhorse is the **outer shell** (window, projects, chats, palette, permissions). Grok is the **inner harness** (model loop, vendor tools, skills/hooks/MCP kernel). Missing inner loops are not Workhorse product bugs.

Sources: [docs.x.ai/build/overview](https://docs.x.ai/build/overview), [Skills / Plugins / Marketplaces](https://docs.x.ai/build/features/skills-plugins-marketplaces), [Modes and Commands](https://docs.x.ai/build/modes-and-commands), `~/.grok/docs/user-guide/` (slash commands, sandbox, plan, subagents, dashboard, background tasks, headless), `grok --help`, and Workhorse `GOAL.md`, `src/lib/commands.ts`, `electron/grok-launch.ts`, `electron/grok-agent.ts`, Settings / Skills.

**Not in scope:** Claude, Codex, or custom-HTTP gaps.

## How to read the tags

| Tag | Meaning |
|---|---|
| **inner-only** | Grok already owns this. Workhorse should not reimplement the kernel. |
| **surface** | Grok has it; Workhorse either does not put it in the palette/UI or does not forward the command to the live adapter. |
| **outer-shell** | No Workhorse control even as a translation (no This-chat toggle, no Settings row, no ACP `_meta` / launch flag). |
| **shipped** | Workhorse already does this for Grok (own UI and/or ACP/launch forward). |

Workhorse slash merge is `mergeCommands(COMMANDS, GROK_SHELL_COMMANDS)` (`src/lib/commands.ts`). **Workhorse names win.** A Grok command listed below as “forwarded” only runs if Workhorse did not take the same `/name`.

---

## What Workhorse already ships for Grok

These are **not** unsupported.

| Capability | Where it lives |
|---|---|
| Live Grok ACP child (`grok agent … stdio`) | `electron/grok-launch.ts` `buildGrokLaunchSpec` |
| Persist vendor session and **reload** with `session/load` (new only if load fails) | `electron/grok-agent.ts`, `WORKHORSE_CLIENT_CAPABILITIES.sessionLoad` |
| Permission modes ask / accept-edits / always-approve / **plan** → Grok `--permission-mode` `default` / `acceptEdits` / `bypassPermissions` / `plan` plus `_meta.planMode` / `yoloMode` | `resolveGrokPermissionMode`, This chat, `/plan` |
| Sandbox `off` \| `workspace` \| `read-only` \| `strict` as top-level `--sandbox` | `resolveGrokSandbox`, `/sandbox` |
| Settings MCP list merged into `session/new` and `session/load` (`mcpServers`) plus the Workhorse desk MCP | `mergeMcpServers`, `workhorseMcpServer` |
| Grok login detected in Electron (binary + login artifact), not a fake toggle | `electron/grok-login.ts` |
| Model + reasoning effort (`low`/`medium`/`high`/`xhigh`; Workhorse `extra` maps to `xhigh`) | `GROK_MODELS`, `resolveGrokEffort` |
| Manual compact via Workhorse `/compact` → Grok `x.ai/compact_conversation` | `COMMANDS` `/compact`, `GrokSessionHost.compact` |
| Fork a Grok chat through `grokFork` | `store.tsx` + preload |
| Rewind points / `/rewind` forwarded to Grok | `GROK_SHELL_COMMANDS` `/rewind` |
| Thought / tool / usage ACP updates rendered in the desk transcript | `electron/grok-agent.ts` classify + store |
| Skills **catalog + Grok palette** | `skillHomes` reads `~/.grok/skills`, `~/.grok/bundled/skills`, and `~/.grok/plugins` as `origin: "grok"`. `commandsForSession` for a Grok chat merges those via `commandsFromSkills`. Settings → Skills can also push a skill into Grok’s skills home. |
| Workhorse-owned spawn, schedule, Watch, projects, worktrees, Git review, chat terminal | `GOAL.md` items 5–8; `/schedule`, `/watch`, `/goal` (desk goal, not Grok’s) |
| Many Grok TUI commands in the palette, forwarded (`run: "grok"`) | `GROK_SHELL_COMMANDS`: `/context`, `/session-info`, `/export`, `/view-plan`, `/memory`, `/flush`, `/dream`, `/remember`, `/hooks`, `/plugins`, `/marketplace`, `/skills`, `/imagine`, `/imagine-video`, `/loop`, `/deep-research`, `/workflow`, `/workflows`, `/feedback`, `/btw`, `/mcps`, `/doctor`, `/release-notes`, `/docs`, `/tutorial`, `/import-claude`, `/config-agents`, `/personas`, `/login`, `/logout`, `/privacy`, `/timestamps`, `/resume` |

Forwarded slash commands are **not** Workhorse UIs. They go into the Grok process. If Grok’s inner modal never appears in Electron, that is a **surface** gap, not “Workhorse has no skills.”

---

## Gaps (Grok Build has it; Workhorse does not own or fully surface it)

### Permission and plan

| Grok Build | Tag | Workhorse today |
|---|---|---|
| Classifier **auto** permission mode (`/auto`, `--permission-mode auto`, `_meta.autoMode`) | **outer-shell** | `/auto` is an alias for Workhorse **accept-edits** (`COMMANDS`). `resolveGrokPermissionMode` never emits Grok `auto`. Comment in `grok-launch.ts`: accept-edits is `acceptEdits`, not `autoMode`. |
| Grok plan-file gate (only `plan.md` writable until you approve) | **inner-only** | Workhorse `/plan` already sets Grok plan mode. The plan file itself is Grok’s. |
| `/view-plan` preview | **surface** | Forwarded as `grok` command; no Workhorse plan card. |
| Allow/deny glob rules (`--allow` / `--deny`, except accept-edits Edit/Write) | **outer-shell** | Launch only adds `--allow Edit` / `--allow Write` for accept-edits. No Settings row for arbitrary Grok deny rules. |
| `dontAsk` when sandbox is read-only/strict | **shipped** (translation) | `resolveGrokPermissionMode` maps boxed sandboxes to `dontAsk`. |

### Skills, plugins, hooks, MCP, marketplace

| Grok Build | Tag | Workhorse today |
|---|---|---|
| Unified extensions modal (`/skills` `/hooks` `/plugins` `/marketplace` `/mcps`) | **inner-only** + **surface** | Commands are forwarded. Workhorse does not host that modal. Settings → Skills is a **desk catalog** (list/push/delete), not Grok’s modal. |
| Plugin install, marketplace sources, `~/.grok/plugins/` | **inner-only** | Forward `/plugins` `/marketplace`. No Workhorse marketplace UI. |
| Hook trust (`/hooks-trust`), project `.grok/hooks/` | **inner-only** | Forward `/hooks`. Settings “Hooks” in the LLM card is **Codex App Server** discovery (`GOAL.md` §9), not Grok hooks. |
| Skill-as-slash (`/<skill-name>`, `/local:commit`) | **surface** | Homes under `~/.grok/skills`, `~/.grok/bundled/skills`, and `~/.grok/plugins` **are** catalogued (`skillHomes` origin `grok`) and merged into a Grok chat’s palette as `run: "skill"` (`commandsFromSkills` → `invokeSkillPrompt`). Remaining gaps: Grok **qualified** names (`/local:commit`, `/user:commit`); native Grok slash vs the desk “Use the installed skill…” wrapper; skills that live only in the Grok **install tree** (not those three homes). `~/.agents/skills` is catalogued as **workhorse**, not grok. |
| Claude Code / `AGENTS.md` / `~/.agents` discovery | **inner-only** | Grok reads those when the child starts. Workhorse does not reimplement. `/import-claude` is forwarded. |

### Agents, personas, subagents, dashboard

| Grok Build | Tag | Workhorse today |
|---|---|---|
| `spawn_subagent` (explore / plan / general-purpose) and personas | **inner-only** | Grok can still spawn **its** subagents inside the ACP process. Workhorse spawn (`workhorse_spawn_agent`) is a **desk** crew, not Grok’s `spawn_subagent`. |
| `/config-agents` / `/personas` | **surface** | Forwarded; no Workhorse agents/personas editor. |
| Agent Dashboard (`/dashboard`, `grok dashboard`, live roster, dispatch, pin) | **surface** / **outer-shell** | Not in `GROK_SHELL_COMMANDS`. Workhorse sidebar is not that dashboard. |
| `/tasks` (background commands + Grok subagents + scheduled loops) | **surface** | Not in the Workhorse palette. Desk `/schedule` is a different scheduler. |
| Leader process (`grok leader`, `--leader`) | **inner-only** | Launch **forces** `--no-leader` so sandbox stays in-process (`grok-launch.ts`). Intentional. |

### Workflows, Grok `/goal`, research, loops

| Grok Build | Tag | Workhorse today |
|---|---|---|
| Rhai workflows (`.grok/workflows/`, `/create-workflow`, `/workflow`, `/workflows`) | **inner-only** + **surface** | `/workflow` and `/workflows` are forwarded. `/create-workflow` is **not** in `GROK_SHELL_COMMANDS`. No Workhorse workflow dashboard. |
| Native Grok `/goal` (token budget, adversarial evidence review) | **surface** | Workhorse `/goal` is **desk-owned** (`run: "goal"`). It shadows Grok’s `/goal`. The Grok goal driver is not what the palette runs. |
| `/deep-research` | **surface** | Forwarded only. No Workhorse research pane. |
| `/loop` (Grok scheduler, 7-day expiry) | **surface** | Forwarded. Desk `/schedule` is Workhorse-owned and is the product scheduler (`GOAL.md` §8). |
| Background `run_terminal_command`, `Ctrl+B`, `monitor` tool | **inner-only** | Grok tools. Workhorse chat **Terminal** is a separate Electron shell (`electron/terminal-host.ts`). |

### Sessions, TUI, CLI, media, account

| Grok Build | Tag | Workhorse today |
|---|---|---|
| Headless `grok -p`, `--output-format`, `--json-schema`, `--max-turns` | **inner-only** | Workhorse is a desktop ACP client, not a headless Grok runner. |
| `grok inspect` (discovered config, skills, hooks, MCP) | **outer-shell** | No Workhorse “inspect this folder the way Grok would” view. |
| `grok sessions` / TUI `/resume` picker of `~/.grok/sessions` | **surface** | `/resume` is forwarded (no Workhorse session browser of Grok’s on-disk store). Desk chats are Workhorse state. |
| `/share` (share session URL) | **outer-shell** | Not in `COMMANDS` or `GROK_SHELL_COMMANDS`. |
| `/find`, `/jump`, `/timeline`, `/transcript`, `/queue`, `/help` | **surface** | TUI/pager only. Not forwarded. Workhorse has its own search (`searchChats`) and prompt queue. |
| `/minimal` / `/fullscreen`, `/vim-mode`, `/compact-mode`, `/multiline`, `/edit-prompt` | **inner-only** | Pager chrome. Workhorse is not the Grok TUI. |
| `/theme` Grok TUI themes | **surface** | Workhorse `/theme` wins and cycles **Workhorse** themes. Grok’s theme command never runs. |
| `/usage` Grok billing / credits | **surface** | Workhorse `/usage` wins and opens **desk** token usage. Grok billing is not that page. |
| `/settings` Grok config modal | **surface** | Workhorse `/settings` wins (Profile / LLMs / Watch). |
| `/timestamps` | **surface** | Forwarded; Workhorse transcript does not have its own timestamp toggle. |
| `/imagine` / `/imagine-video` | **surface** | Forwarded; no Workhorse media gallery. |
| Grok `--worktree` / `grok worktree` (Grok-managed git worktrees, `--restore-code`) | **outer-shell** | Workhorse worktrees are **desk** environments (`session-environment.ts`), not Grok’s `--worktree` flag. Launch does not pass `--worktree`. |
| Custom models in `~/.grok/config.toml` `[model.*]` | **inner-only** | Grok discovers them. Workhorse model picker is the **desk catalog** (`GROK_MODELS`: grok-4.6, grok-4.5, grok-build). Extra Grok config models are not listed unless Grok advertises them back. |
| `grok-devbox` sandbox profile | **outer-shell** | Workhorse sandbox enum has no `devbox`. |
| `grok doctor` / `grok du` / `grok trace` / `grok setup` / `grok wrap` / `grok update` | **inner-only** | CLI. `/doctor` is forwarded into the session; the other subcommands have no Workhorse wrapper. |
| `/feedback`, `/docs`, `/tutorial`, `/release-notes` | **surface** | Forwarded into Grok, not Workhorse help. |
| Privacy / ZDR / `/privacy` | **surface** | Forwarded. No Workhorse privacy pane. |
| Structured output / JSON schema | **outer-shell** | No Workhorse prompt option for Grok `--json-schema`. |
| Disable web search (`--disable-web-search`) | **outer-shell** | Not a This-chat control. |
| Cross-session memory flag (`--experimental-memory`) | **outer-shell** | `/memory` `/flush` `/dream` forwarded when Grok has memory on; Workhorse never passes `--experimental-memory`. |

---

## Name collisions (easy to misread as “unsupported”)

| Slash | Who wins | Effect |
|---|---|---|
| `/auto` | Workhorse | Accept-edits, **not** Grok classifier auto |
| `/goal` | Workhorse | Desk goal bar, **not** Grok’s evidence-reviewed `/goal` |
| `/usage` | Workhorse | Desk tokens / Watch, **not** Grok billing |
| `/theme` | Workhorse | Desk theme cycle, **not** Grok TUI theme |
| `/settings` | Workhorse | Desk settings, **not** Grok config.toml modal |
| `/fork` | Workhorse | Desk fork (+ `grokFork` for Grok chats) |
| `/compact` | Workhorse | Desk compact path that calls Grok compact RPC |
| `/new` `/rename` `/delete` `/copy` | Workhorse | Desk chat ops |

---

## Short list: what you actually cannot do from Workhorse today

If the question is “I can do this in Grok Build TUI/CLI and I cannot do the same thing as a Workhorse control”:

1. Turn on Grok’s **classifier auto** permission mode.
2. Open Grok’s **Agent Dashboard** or a live roster of Grok-native subagents/tasks.
3. Author a **Rhai workflow** (`/create-workflow`) from Workhorse, or see the Grok **workflows run** UI as a desk pane.
4. Run **Grok’s** `/goal` (shadowed) or set a Grok goal token budget.
5. Browse **Grok on-disk sessions** (`~/.grok/sessions`) or **share** a Grok session URL.
6. Start a chat in a **Grok `--worktree`** (desk worktrees are a different feature).
7. Pick **devbox** sandbox, **JSON schema** output, **disable web search**, or **experimental memory** from This chat.
8. Type Grok **qualified** skill slashes (`/local:commit`) or get Grok’s native skill-command behavior (desk entries wrap as `run: "skill"`). Skills only in the Grok install tree (outside `~/.grok/skills`, `bundled/skills`, and `plugins`) stay off the palette.
9. Manage Grok **plugins / marketplace / hook trust** except by forwarding a slash into the child (no desk modal).
10. Run **headless** `grok -p` / `grok inspect` from the app (CLI only).

Items 3, 4, 8, 9 still *might* work if you type the forwarded command and Grok’s inner UI responds inside the ACP stream. Workhorse does not guarantee or skin that.

---

## What not to build

Do not treat this list as “clone the Grok TUI.” Skills, hooks, MCP, Grok subagents, plan-file gating, memory backends, and the workflow runtime stay **inner-only**. The useful outer-shell questions are the collisions (`/auto`, `/goal`, `/usage`) and the few launch flags This chat never translates (`auto` mode, `--worktree`, `--experimental-memory`, `--json-schema`).
