# Plan: Cursor on the desk (ACP + two-pool watch)

Paste this file as the plan for a **new implementer agent**. Do not re-research harnesses. Do not implement Grok Bot. Do not drive the open Cursor IDE. Do not redesign the shell.

Product contract: `docs/GOAL-cursor.md`.

## Goal kind
implementation

## Objective
Ship a live `cursor` vendor on Workhorse: ACP child, stream, permission bar, resume, desk spawn, and honest **two-lane** usage/watch (Cursor Models vs Other Models). Account meters are harness-wide. A single Cursor bucket is a fail.

Workhorse stays the outer shell. Cursor Agent stays the inner harness. Do not scrape `api2.cursor.sh`. Do not spawn `Cursor.app`.

## Phases (do in order)

### A — Types and lane (no live send)

1. Add `"cursor"` to `ProviderId`. Update every `Record<ProviderId, …>` and stock list (`capabilitiesFor`, `MODEL_CATALOG`, `vendorSendTarget`, `Settings.llms`, settings/usage/watch `STOCK` / `DESK_VENDORS`, desk-export, routing, subagent aliases). `capabilitiesFor("cursor")` is ACP Cursor, **not** Grok. `usageProviderForSession` must not map cursor → grok. Pick one unknown-provider policy (keep Grok fallback **or** throw) and test it.
2. Add `lane` on `UsageEvent` (optional on old events; required on new Cursor events).
3. Ship `src/lib/cursor-lane.ts` `cursorUsageLane(model, params?)` from the table in `GOAL-cursor.md`. Unit-test Composer, Composer Fast, Grok 4.6/4.5 Fast, `claude-*`, `gpt-*`, `gemini-*`, `auto-smart` cost vs balanced, empty → unknown.
4. Fallback catalog: `composer-2.5` (default), `auto-smart`. Picker copy may wait for phase C; classification must exist now.

### B — ACP host (send allowed only with lane + hold hook)

5. New files: `electron/cursor-login.ts`, `cursor-launch.ts`, `cursor-host.ts`. Reuse `GrokAgent` / ACP parsers. Inject `spawn` for tests.
6. Detect command: `CURSOR_ACP_BIN` (must exist) → `agent` / `agent.exe` on PATH → `cursor-agent` on PATH → `~/.local/bin/agent` → Application Support `cursor-agent` **if the file exists**. Never `grok`. Never `Cursor.app`. `buildCursorLaunchSpec` records argv (`acp`, cwd, MCP merge including Workhorse MCP when env is set).
7. IPC: `cursor:prompt`, `cursor:event`, `cursor:cancel`, `cursor:answer-permission`, `cursor:detect-login`. Do not rename grok/claude/codex channels.
8. `store.send()` for `provider === "cursor"` calls `cursorPrompt` only. Missing binary → `Cursor agent failed: …`. Never preview.
9. Contract: cwd = execution directory; stream chunk/thought/tool; `session/request_permission` → bar `provider: "cursor"`; cancel; `session/load` resume; launch-key change → `session/new`.
10. Answer `cursor/ask_question` and `cursor/create_plan` (skipped/rejected is fine without UI). Render `cursor/task` / todos / generate_image as tool or thought rows. Do not throw. Do not open a second process for `cursor/task`.
11. `detectCursorLogin`: binary **and** (`CURSOR_API_KEY` or official `agent login` artifact — confirm file name). Cursor.app present ≠ connected. Injected fs/env/homedir in tests.
12. `recordUsage` on every completed turn: `provider: "cursor"`, lane from `cursorUsageLane`, resolved model (not `auto` if the run named one). Reuse shared usage parse / `finalizeTurnUsage`. No tokens on preview or failed-before-prompt.

**Gate:** do not merge a send path that can run without (11)+(12) and a Watch key for the lane.

### C — Account meters and per-lane Watch

13. `electron/cursor-plan.ts`. Official monthly meters only. Two `GrokPlanProduct`s: `cursor-models`, `other-models`. Period monthly. On-demand as an extra field when reported. Missing meter → leftover unknown.
14. `WatchPlans.cursor`. `evaluateWatchHold` uses the session’s lane, not `provider === "cursor"`. Composer not held when only Other Models is spent. Other Models chat held when that pool is spent. 429 ≠ spent.
15. Usage + Watch UI: two Cursor rings, “this desk” subtitle from local events, on-demand line, per-model table, `lockKeys` per lane.
16. Routing: prefer `cursor-models` when Other Models usedPercent is high. Other Models hold does not drop Composer candidates.
17. `workhorse_list_bots`: two leftovers or two rows (`Cursor · Composer`, `Cursor · API`). One leftover for both pools is a fail.

### D — Desk spawn and docs

18. `parseProviderId("cursor") === "cursor"`. Spawn with no model → Composer 2.5. Bound folder required. Worker role still strips spawn tools.
19. Inner `cursor/task` never becomes a lineup row and never satisfies `workhorse_await_agents`.
20. Honest docs: `README.md`, `GOAL.md`, `AGENTS.md`, `providers.ts` tagline “Cursor Agent via ACP”. `eval/provider-matrix.json` profile `cursor-acp`, `launchBoundary: electron/cursor-host.ts`. Do not claim the IDE or Grok Bot.

## Verification (faults first)

Tests imported by `npm test`. Drive shipped functions.

1. **No cross-talk.** `vendorSendTarget("cursor") === "cursor"`. Cursor send does not call `grokPrompt`. Other vendors unchanged.
2. **capabilitiesFor / usageProviderForSession.** Cursor is not Grok. A Cursor usage event is not in the Grok rollup.
3. **cursorUsageLane.** Full table in `GOAL-cursor.md`.
4. **Launch spec.** Env wins; fallback `agent`/`cursor-agent`; never grok / Cursor.app; argv has `acp`; cwd set; MCP merge when env set.
5. **Resume.** Fake stdio child: new → `session/new`+`prompt`; after dispose → `load`+`prompt`; failed load → `new`; launch-key change → `new`.
6. **Login.** Missing binary / binary no auth / key present / app bundle only.
7. **Usage + lane.** Event has `provider: "cursor"` and lane. Inclusive-turn repair still applies.
8. **Holds.** Fixture: Other Models 100%, Composer chat not held. Cursor Models 100%, Composer chat held. Other Models chat held when that product is 100%.
9. **Permissions + extensions.** Bar maps Allow once/session/Deny. ask_question / create_plan get a reply.
10. **Spawn.** Admit cursor when attached. Default model Composer 2.5. Worker has no spawn tools. `cursor/task` extractor is not a child session.
11. **Plan parse.** Official-shaped JSON → two products, monthly, unknown when fields missing (not 0, not 100).
12. **Honesty.** Unresolved binary → `Cursor agent failed`. Never preview.
13. **Regression.** Existing adapter tests green. `npm test` passes.
14. **Evidence.** Full `npm test` output. Optional live smoke only if `agent` + login exist: `pong` prompt, usage event on Cursor Models. Not required.

## Non-goals

Grok Bot; IDE deeplink; `@cursor/sdk` / Cloud API as first transport; unpublished billing scrape; SuperGrok merge; on-demand purchase UI; auto-approve; join-turn changes; UI redesign.

## Lock these

- Copy Claude/Codex host shape. Share the vendor-event switch. Usage pending per session id.
- Session rules must not tell Cursor it is Grok.
- Images: pass ACP image blocks if Cursor accepts them; else text only, short comment.
- Tests import shipped `electron/` and `src/lib/` modules.
