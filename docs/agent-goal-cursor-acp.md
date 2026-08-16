# Plan: Cursor ACP adapter (live vendor + usage)

Paste this file as the plan / goal for a **new implementer agent**. Do not re-research harnesses. Do not implement Grok Bot. Do not drive the open Cursor IDE window. Do not redesign the shell.

## Goal kind
implementation

## Objective
Ship a **live Cursor ACP adapter** so a new `cursor` composer slot behaves like Grok / Claude / Codex: vendor process, tools, permission bar, resume, and honest `recordUsage` with `provider: "cursor"`.

Workhorse stays an outer shell. Cursor Agent remains the inner harness (model loop, file/shell tools, its own modes). Workhorse does not call `api2.cursor.sh` by scraping, does not inject into `Cursor.app`, and does not execute Cursor’s tools itself.

## Why this shape
Grok / Claude / Codex are already: `store.send()` → IPC → `*SessionHost` → vendor ACP stdio → events → tool rows / permission bar / `recordUsage`.

Cursor is missing from `ProviderId`. Official docs already describe the matching socket: [`agent acp`](https://cursor.com/docs/cli/acp) (`initialize`, `authenticate` / `cursor_login`, `session/new` | `session/load`, `session/prompt`, `session/update`, `session/request_permission`).

The open IDE is a different product. `cursor://anysphere.cursor-deeplink/prompt?text=…` prefills; it does not run or stream. `@cursor/sdk` and Cloud Agents API are real but are **not** this slice (ACP first, same as the other three local vendors).

## Acceptance criteria
1. **Live Cursor path.** `session.provider === "cursor"` in `src/lib/store.tsx` `send()` calls Cursor IPC (`window.workhorse.cursorPrompt` or equivalent). It must **not** call `grokPrompt` / `claudePrompt` / `codexPrompt` and must **not** fall through to preview echo. Missing binary / ACP child failure surfaces as `Cursor agent failed: …`.
2. **Same adapter contract.** Electron main is the only process that spawns the vendor. Renderer stays IPC-only (`AGENTS.md`). Contract: start in the chat execution cwd, `session/prompt`, stream, `session/request_permission` → existing Allow once / session / Deny bar, `session/load` resume, cancel. Compact/rewind only if Cursor ACP exposes them — do not fake them.
3. **Spawn Cursor ACP, not `grok`, not `Cursor.app`.** New files: `electron/cursor-launch.ts`, `electron/cursor-host.ts`, `electron/cursor-login.ts`. Reuse `GrokAgent` / shared ACP parsers. Detect command: `CURSOR_ACP_BIN` (must exist) → `agent` / `agent.exe` on PATH → `cursor-agent` on PATH → `~/.local/bin/agent`. Optional last resort: existing Application Support `cursor-agent` **if the file exists**. Do not download. Do not spawn the Electron app binary. Record argv as `buildCursorLaunchSpec`.
4. **Provider wiring.** Add `"cursor"` to `ProviderId`. Update every `Record<ProviderId, …>` and stock list that would otherwise treat Cursor as Grok (`capabilitiesFor`, `MODEL_CATALOG`, `vendorSendTarget`, `Settings.llms`, `DESK_STOCK` / `STOCK` in settings, usage, watch, desk-export, routing, subagent aliases). `capabilitiesFor("cursor")` must not return the Grok block.
5. **Model + effort.** Fallback catalog: `composer-2.5` (default), `auto-smart`. Overlay a live list when detection can fetch one (ACP initialize / documented model list / `CURSOR_API_KEY`). Map Workhorse effort onto Cursor’s documented flags; omit if unknown. Do not invent `--reasoning-effort`.
6. **Sandbox + permission modes.** Reuse `Session.sandbox` and `Session.mode`. Map onto Cursor ACP `ask` / `agent` / `plan` and any documented sandbox flags. Approvals stay the one permission bar with `provider: "cursor"`. Never auto-approve because the SDK default does.
7. **Tools + MCP.** Cursor’s own tools run inside the child. Settings `mcpServers` plus Workhorse MCP (`workhorseMcpServer()`) are passed on `session/new` and `session/load`. Handle Cursor extension methods that would otherwise stall the child: `cursor/ask_question` and `cursor/create_plan` must get a JSON-RPC reply (answered / skipped / accepted / rejected). Notifications (`cursor/update_todos`, `cursor/task`, `cursor/generate_image`) may render as tool/thought rows; they must not throw.
8. **Resume.** Persist `vendorSessionId` / `vendorProvider: "cursor"`. Next prompt `session/load` then `session/prompt`. Launch-key change (model / effort / mode / sandbox / cwd / MCP) → `session/new`.
9. **Login detection.** `detectCursorLogin` with injected `existsSync` / env / homedir (never a bare home path in tests). Connected only when binary **and** (`CURSOR_API_KEY` or `~/.cursor` login artifact that official CLI uses — confirm the file name against current `agent login` docs, typical `cli-config` / auth json). Cursor.app running is **not** connected. Settings button is Recheck.
10. **Usage.** Cursor usage events call `recordUsage` with `provider: "cursor"` and the session’s model / project / session. Reuse the shared ACP usage parser / `finalizeTurnUsage`. Do not invent tokens. Do not write Cursor events as `provider: "grok"`. Usage pane lights up when events exist. A Cursor weekly ring is not required.
11. **Preface + thoughts.** Same `composeVendorPrompt` / session rules as other ACP vendors. Role is still desk orchestrator vs worker (`parentId`). Workers still do not get spawn tools.
12. **Docs stay honest.** Update `README.md`, `GOAL.md`, `AGENTS.md`, `src/lib/providers.ts` (tagline “Cursor Agent via ACP”). Add `eval/provider-matrix.json` profile `cursor-acp`. Do not claim the open IDE is wired. Do not claim Grok Bot.

## Verification plan (faults first)
Write tests imported by `npm test`. Drive **shipped** functions.

1. `gating` **No cross-talk.** Cursor `send()` does not call `grokPrompt`. Grok / Claude / Codex / custom send targets unchanged. `vendorSendTarget("cursor") === "cursor"`. `asProviderId("cursor") === "cursor"`.
2. `gating` **capabilitiesFor.** `capabilitiesFor("cursor").transport === "acp"` and is not the Grok resume/rewind/compact native set unless Cursor actually exposes those. Unknown provider must not silently become Cursor either — keep today’s Grok fallback or make unknown throw; pick one and test it.
3. `gating` **Launch spec.** `buildCursorLaunchSpec`: env override wins; missing env falls back to detected `agent` / `cursor-agent`; command is never `grok` and never `Cursor.app` / `Cursor`; argv includes `acp`; cwd is the given folder; MCP list includes user servers + Workhorse MCP when that env is set.
4. `gating` **Resume.** Fake stdio ACP child injected into `CursorSessionHost`: new chat → `session/new` then `session/prompt`; after dispose → `session/load` then `session/prompt`; failed load → `session/new`; launch-key change → `session/new`.
5. `gating` **Login.** `detectCursorLogin` temp dirs / env: missing binary → not connected; binary without key/auth → not connected; binary + `CURSOR_API_KEY` → connected; presence of `/Applications/Cursor.app` alone → not connected.
6. `gating` **Usage.** A Cursor usage event hydrates as `provider: "cursor"` and appears in `byProvider` / rollup. Inclusive-turn double-count repair still applies. Other vendors’ events stay in their buckets.
7. `gating` **Permissions + Cursor extensions.** `session/request_permission` tagged `provider: "cursor"` still maps Allow once / session / Deny. `cursor/ask_question` / `cursor/create_plan` receive a response so the child does not hang (unit-test the handler; skipped/rejected is fine when the UI is not up).
8. `gating` **Spawn alias.** `parseProviderId("cursor") === "cursor"`. `workhorse_spawn_agent` admit path accepts cursor when attached. Worker role still strips spawn tools.
9. `gating` **Honesty on failure.** Unresolved binary → `Cursor agent failed:` (or the host error the store already renders). Never preview.
10. `gating` **Regression.** Existing Grok / Claude / Codex / custom adapter tests stay green. `npm test` passes.
11. `evidence`: `{SCRATCH}/cursor-adapter-test-output.txt` with full `npm test`. Optional live smoke (only if `agent` + login exist): new Cursor chat, prompt `Reply with the single word pong. Do not edit files.`, one usage event `provider: "cursor"`. Smoke is not required.

## Non-goals
- Grok Bot / `sand://` / local-exec daemon
- Deeplink into the open IDE, auto-send, or sharing that transcript
- `@cursor/sdk` local runtime as the first transport
- Cloud Agents API, Cursor VMs, `POST /v1/agents`
- Calling unpublished `api2.cursor.sh` routes
- Unlimited tool approval
- Replacing Grok Build
- Join-turn / orchestration contract changes (Cursor may *use* spawn once live; do not change desk join)
- SuperGrok-style leftover ring for Cursor
- Redesigning the UI

## Assumed scope
- Product: Go7 Workhorse local repo.
- Copy Claude/Codex host shape: `electron/claude-host.ts`, `electron/codex-host.ts`, `electron/grok-agent.ts` parsers, `src/lib/vendor-bridge.ts`, `src/lib/store.tsx` send, `src/lib/usage.ts`.
- Official ACP: https://cursor.com/docs/cli/acp
- Confirm binary name and auth file against the installed CLI before locking `detectCursorLogin`.

## Implementation notes (lock these so you do not ask)
- **IPC names:** parallel `cursor:*` handlers (`cursor:prompt`, `cursor:event`, `cursor:cancel`, `cursor:answer-permission`, `cursor:detect-login`). Do not rename working `grok:*` / `claude:*` / `codex:*` channels.
- **Share the event apply path.** Reuse the extracted vendor-event switch. Usage pending stays per session id.
- **Reuse ACP parsing.** Import `classifyAcpUpdate`, usage parse, consume loop from the existing agent module. Do not copy-paste a second parser.
- **Host class.** `CursorSessionHost` wraps shared ACP agent + `buildCursorLaunchSpec`. Inject `spawn` for tests. One slot per Workhorse `sessionId`.
- **Workhorse MCP.** Same merge as Grok. Cursor chats should see desk tools when the bridge env is set. Session rules must not tell Cursor it is Grok.
- **Settings.** `llms.cursor: LlmLink`. Recheck + “Detected the local Cursor Agent login” / “Cursor ACP binary or login not found.”
- **Eval.** Add `cursor-acp` to `eval/provider-matrix.json` with `launchBoundary: electron/cursor-host.ts`.
- **Images.** If Cursor ACP prompt content allows image blocks, pass the same payload Grok uses. If not, send text only and drop images with a short comment.
- **Tests import shipped modules** from `electron/` and `src/lib/`.
