# Goal: Cursor live (ACP, same contract as Grok / Claude / Codex)

Make **Cursor** a fifth Workhorse vendor. A chat whose provider is `cursor` starts a real Cursor ACP child, streams into the desk, uses the existing permission bar, and calls `recordUsage` with `provider: "cursor"`.

This is **Cursor Agent ACP**. It is not the open Cursor IDE window, not Grok Bot, and not a rewrite of the Grok slot.

Read first: `docs/agent-goal-cursor-acp.md`, `src/lib/vendor-bridge.ts`, `electron/claude-host.ts` / `electron/codex-host.ts` (copy this shape), official [Cursor ACP](https://cursor.com/docs/cli/acp).

## Why this exists

Cursor already ships the socket Workhorse knows:

- `agent acp` — stdio JSON-RPC: `initialize` → `authenticate` (`cursor_login`) → `session/new` or `session/load` → `session/prompt` → `session/update` + `session/request_permission`
- Usage and resume are first-class on that protocol
- `@cursor/sdk` and the Cloud Agents API exist, but they are not this slice

Workhorse still has `ProviderId = "grok" | "claude" | "codex" | "custom"`. `vendorSendTarget("cursor")` cannot even compile. Settings stock vendors are `grok / codex / claude`. `capabilitiesFor` treats anything else as Grok. That is the gap.

The open Cursor window (`cursor://anysphere.cursor-deeplink/prompt?text=…`) only prefills a prompt. The user must confirm. Nothing streams back. That is a door, not a vendor. Do not build it here.

## The contract

A Cursor chat on the desk behaves like a Codex chat:

1. Electron main is the only process that spawns Cursor. React stays on IPC.
2. Start in this chat’s execution directory (linked folder or managed worktree). Never spawn into an empty local cwd.
3. Stream text, thoughts, and tool rows through the existing store event path.
4. `session/request_permission` lands on the one permission bar (`provider: "cursor"`). Allow once / Allow for session / Deny. Do **not** use the SDK’s default auto-approve.
5. Resume with `session/load` when `vendorSessionId` is set and the launch key is unchanged.
6. Cancel stops the in-flight prompt.
7. `recordUsage` writes `provider: "cursor"` plus model, project, session, in / out / cache. Preview chats invent no tokens.
8. Settings MCP + the built-in Workhorse MCP are passed on `session/new` and `session/load`, same as Grok.
9. Settings → LLMs → Cursor is **On** only when a spawnable ACP command **and** a Cursor login exist (`CURSOR_API_KEY`, `--api-key`, or `agent login`). The IDE being open is not a login.

## How we call it

```
Composer send
  → store.tsx (vendorSendTarget === "cursor")
  → IPC cursor:prompt
  → CursorSessionHost
  → spawn `agent acp` (or CURSOR_ACP_BIN / detected cursor-agent)
  → ACP session/prompt
  → cursor:event (chunk / thought / tool / permission / usage / done / error)
  → same apply path as Grok / Claude / Codex
```

Detect the binary in this order: `CURSOR_ACP_BIN` (must exist), then `agent` / `agent.exe` on PATH, then `cursor-agent` on PATH, then the well-known install `~/.local/bin/agent`. On this Mac a copy also lives under Application Support `anysphere.cursor-agent-worker` — use it only if the PATH / env candidates are missing, and only if the file exists. Do not download packages at runtime. Do not spawn `grok`. Do not spawn `Cursor.app`.

Auth: `CURSOR_API_KEY` or `agent login`. Store the key in `credential-store.ts` when the user pastes one. Do not read tokens from the Cursor IDE app support tree.

Models: fallback catalog `composer-2.5` (default) and `auto-smart`. Overlay a live list when Cursor ACP or `CURSOR_API_KEY` can name models. Launch the selected id. Unknown id → omit a bad flag; do not silently swap to Grok.

Modes: map Workhorse `ask | accept-edits | always-approve | plan` onto Cursor ACP `ask | agent | plan` (and permission defaults). Sandbox maps onto whatever Cursor ACP documents; if a flag is missing, omit it and keep Workhorse’s own sandbox/security policy in front.

## Done when

1. `ProviderId` includes `"cursor"`. `vendorSendTarget("cursor") === "cursor"`. `capabilitiesFor("cursor")` is Cursor, **not** Grok.
2. New chat → Vendor Cursor → send a line → a real `agent acp` child starts in the project folder and answers. Failure is `Cursor agent failed: …`, never `Preview only`.
3. Stream, tools, permission bar, cancel, and `session/load` resume work on that chat.
4. A completed turn writes a usage event with `provider: "cursor"`. The Usage pane rolls it up next to Grok / Claude / Codex. No invented tokens.
5. Settings → LLMs shows a Cursor row. Recheck detects binary + login. “Cursor.app is open” is not enough.
6. `workhorse_list_bots` can list Cursor when it is attached and callable. `workhorse_spawn_agent` with `provider: "cursor"` starts a **Workhorse** child session on ACP, in a bound folder — not a tab in the IDE, not a Grok Bot.
7. Grok, Claude, Codex, and custom paths are unchanged. Grok Bot is still not a provider.

Same prompt to prove it (new **Cursor** chat inside a linked project folder):

```
Reply with the single word pong. Do not edit files.
```

Then open Settings → Usage and see a `cursor` row for that chat.

## Out of scope

- Driving the already-open Cursor IDE window or deeplink auto-send
- Grok Bot (`com.anysphere.sand`)
- `@cursor/sdk` as the live transport (ACP first; SDK is a later slice if ACP is missing)
- Cloud Agents API / `POST /v1/agents` / Cursor VMs
- Replacing Grok Build ACP
- Unlimited / auto-approve tools
- Merging Cursor’s IDE transcript, logins, or cloud computer with Grok / Claude / Codex / custom
- Making Cursor the default orchestrator (it may *be* an orchestrator chat once this adapter exists; join-turn stays the desk contract)

## Likely files

- `src/lib/types.ts` — `ProviderId`, `Settings.llms.cursor`
- `src/lib/providers.ts`, `models.ts`, `provider-capabilities.ts`, `vendor-bridge.ts`, `settings.ts`, `usage.ts`, `watch.ts`, `subagents.ts`, `desk-export.ts`, `routing.ts`
- `electron/cursor-login.ts`, `cursor-launch.ts`, `cursor-host.ts` (reuse `GrokAgent` / ACP parsers; do not fork a second usage parser)
- `electron/main.ts`, `preload.ts`
- `src/lib/store.tsx` — send target + detect login
- `src/ui/Settings.tsx`, composer model menu
- `eval/provider-matrix.json` — `cursor-acp` profile
- `test/` — launch spec, login detect, send-target, usage `provider: "cursor"`, no cross-talk
- `README.md`, `GOAL.md`, `AGENTS.md` — honest “Cursor via ACP”
