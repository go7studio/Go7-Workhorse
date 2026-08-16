# Goal: Cursor on the desk

Make **Cursor Agent** a fifth Workhorse vendor. A chat whose provider is `cursor` starts a real ACP child, streams into the desk, uses the one permission bar, and is watched on **Cursor’s two monthly pools** — not one token bucket.

This is Cursor Agent ACP. It is not the open Cursor IDE window, not Grok Bot, and not a rewrite of Grok Build.

Implementer plan: `docs/agent-goal-cursor.md`.  
Official pools: [Models & Pricing](https://cursor.com/docs/models-and-pricing). Official socket: [ACP](https://cursor.com/docs/cli/acp).

## Why this exists

Workhorse already hosts Grok, Claude, and Codex the same way: Electron spawns a vendor ACP process; React stays on IPC; tools stay in the vendor; `recordUsage` and Watch see that vendor.

Cursor already ships that socket (`agent acp`). It is missing from `ProviderId`. `vendorSendTarget` cannot name it. `capabilitiesFor` treats unknown ids as Grok. `usageProviderForSession` would dump Cursor tokens into the Grok bucket. That is the gap.

Cursor’s bill is also not one allowance. Two pools reset on the billing cycle:

| Pool | Draws | Include | Extra |
|---|---|---|---|
| **Cursor Models** | Composer 2.5, Cursor Grok 4.6 / 4.5 (and Fast) | Generous on the plan | On-demand at Cursor rates. No Token Rate. |
| **Other Models** | Claude, GPT, Gemini, any picked third-party; Auto Balance / Intelligence when they route off-family | Pro $20, Plus $70, Ultra $400. Start: $0 | On-demand at that model’s API price. Teams add Token Rate. |

Those meters are **account-wide**. This adapter, the open IDE, CLI, and Cloud Agents all drain them. A single `provider: "cursor"` ring would hold Composer when only the API include is spent, or let a spawn crew of Claude-via-Cursor burn on-demand with no harness notice.

Composer / Cursor Grok on this slot is not Workhorse’s Grok Build vendor. Two `ProviderId`s. Two bills.

## The contract

### Call path

```
Composer send
  → store (vendorSendTarget === "cursor")
  → evaluateWatchHold on this chat’s lane
  → IPC cursor:prompt
  → CursorSessionHost
  → spawn `agent acp` (CURSOR_ACP_BIN / agent / cursor-agent)
  → session/prompt
  → cursor:event (chunk / thought / tool / permission / usage / done / error)
  → same apply path as Grok / Claude / Codex
  → recordUsage({ provider: "cursor", lane, model, tokens })
```

Electron is the only process that spawns Cursor. Never spawn `Cursor.app` or `grok`. One ACP child per Workhorse session; reuse on the same launch key.

Start in this chat’s execution directory (linked folder or managed worktree). Empty local cwd is a fail.

### Login

Settings → LLMs → Cursor is On only when a spawnable ACP command **and** a Cursor login exist (`CURSOR_API_KEY` or `agent login`). The IDE being open is not a login. Recheck, not a fake toggle. Store a pasted key in `credential-store.ts`. Do not read tokens from the Cursor app tree.

### Models and lanes

Default new chat and default `workhorse_spawn_agent` (no model named) = **Composer 2.5**.

Every model id maps to a lane **before** send. Store the lane on the usage event.

| Lane | Slugs | Watch key |
|---|---|---|
| `cursor-models` | `composer-2.5`, `composer-2`, `composer`, `grok-4.6`, `grok-4.5`, Fast variants | `cursor:cursor-models` |
| `other-models` | Concrete third-party ids (`claude-*`, `gpt-*`, `gemini-*`, …) | `cursor:other-models` |
| `auto-cost` | `auto-smart` + `optimize_for=cost` | treat as `cursor-models` unless Cursor docs change |
| `auto-routed` | `auto-smart` + balanced / intelligence | treat as `other-models` until the run names a model, then re-bucket |
| `unknown` | empty | do not send |

Picker groups Cursor Models above Other Models. Other Models show that they use the monthly API include / on-demand.

`cursorUsageLane(model, params?)` lives in `src/lib/`. Host and Usage both call it.

### Permissions

`session/request_permission` → the one permission bar, `provider: "cursor"`. Allow once / session / Deny. Never the SDK auto-approve default.

`cursor/ask_question` and `cursor/create_plan` must get a JSON-RPC reply so the child does not hang. They do not write usage events.

### Usage and Watch (ship gate)

Do not ship a live send without this.

1. `recordUsage` is `provider: "cursor"` plus lane, resolved model, project, session, in / out / cache. Cost only if Cursor reported billed $. Preview / failed-before-prompt invent no tokens. Inclusive-turn repair still applies. Never fold into Grok.
2. `electron/cursor-plan.ts` fetches **official** monthly meters when documented (CLI `/usage` JSON, dashboard/admin usage, or ACP/SDK getUsage with pool fields). Confirm the endpoint against current docs. Do not scrape private `api2.cursor.sh`.
3. `WatchPlans.cursor` has two products: Cursor Models, Other Models. Period is monthly. On-demand spend is a third number on the Usage card when reported.
4. If the official meter is missing, leftover is **unknown**. Do not invent 0% or 100%. Workhorse-attributed tokens still show as “this desk.”
5. Watch holds **per lane**:

| Situation | Hold? |
|---|---|
| Composer chat, Cursor Models spent or daily lock | Yes. Offer another **desk** vendor, not Other Models unless the user picks it. |
| Composer chat, Other Models spent | No. |
| Other Models chat, that pool spent or on-demand cap | Yes. Offer Composer or a non-Cursor vendor. |
| `auto-routed` unresolved | Treat as Other Models. |
| 429 | Rate-limit notice. Do not mark the pool spent unless the meter says so. |

6. Routing is capacity-aware on lane. Prefer Composer when Other Models is high. An Other Models hold must not take Composer off the list.
7. `workhorse_list_bots` exposes both leftovers (two rows or two fields). Orchestrators must not read one leftover as both pools.

### Calling agents (three paths — do not mix)

| Path | What | Pool | Desk |
|---|---|---|---|
| **A. Desk spawn** | `workhorse_spawn_agent` `{ provider: "cursor" }` | Composer unless an Other Models id is named | Hidden child. Lineup / join. Bound folder. |
| **B. Inner task** | ACP `cursor/task` | Same two account pools as the parent | Tool row. Not a worker. Not `await_agents`. |
| **C. IDE / Cloud** | Agents Window, `POST /v1/agents` | Same account meters | Out of this goal. Plan fetch still sees the drain. |

A worker Cursor session does not get spawn tools. It may still emit `cursor/task`; those stay tools, never a second crew.

N Cursor children on Other Models = N times the monthly API include. Default every spawn to Composer.

### Performance

One child per chat, not per keystroke. Cancel is `session/cancel`. Plan fetch is cached and must not block `session/prompt`. Do not attach turned-off MCP servers. Do not open a second ACP process for an inner task.

## Done when

1. `ProviderId` includes `"cursor"`. `vendorSendTarget("cursor") === "cursor"`. `capabilitiesFor("cursor")` is Cursor, not Grok. `usageProviderForSession` never maps Cursor to Grok.
2. New chat → Vendor Cursor → send → a real `agent acp` child answers in the project folder. Failure is `Cursor agent failed: …`, never `Preview only`.
3. Stream, tools, permission bar, cancel, `session/load` resume work.
4. `cursorUsageLane` matches the table (tests). Every Cursor usage event has a lane.
5. Settings shows two Cursor rings plus on-demand when reported. Watch holds per lane. Composer is not held when only Other Models is spent.
6. Plan fetch uses an official meter when available; otherwise leftover is unknown.
7. Settings → LLMs Cursor row: Recheck. IDE open is not connected.
8. `workhorse_list_bots` lists Cursor when attached. Spawn without a model is Composer 2.5. Inner `cursor/task` is a tool row. Desk spawn is a child session.
9. Grok, Claude, Codex, custom unchanged. Grok Bot is not a provider.

Prove it (new **Cursor** chat in a linked project folder):

```
Reply with the single word pong. Do not edit files.
```

Then Settings → Usage shows a Cursor Models row for that chat, not a Grok row.

Second prove (same desk, switch that chat to a third-party Cursor model if attached, or a second chat): Other Models events stay on the Other Models ring. Spend that pool in the test fixture and confirm a Composer chat still sends.

## Out of scope

- Driving the open Cursor window or deeplink auto-send
- Grok Bot (`com.anysphere.sand`)
- `@cursor/sdk` or Cloud Agents as the first transport
- Scraping unpublished billing URLs
- Merging Cursor Models with SuperGrok leftover
- Paying or topping up on-demand from the desk
- Unlimited / auto-approve tools
- Changing join-turn
- Making Cursor the default orchestrator (it may *be* an orchestrator chat once live)

## Likely files

- `src/lib/cursor-lane.ts` — classification
- `src/lib/types.ts` — `ProviderId`, `Settings.llms.cursor`, usage lane
- `src/lib/providers.ts`, `models.ts`, `provider-capabilities.ts`, `vendor-bridge.ts`, `settings.ts`, `usage.ts`, `watch.ts`, `routing.ts`, `subagents.ts`, `desk-export.ts`
- `electron/cursor-login.ts`, `cursor-launch.ts`, `cursor-host.ts`, `cursor-plan.ts`
- `electron/main.ts`, `preload.ts`, `src/lib/store.tsx`
- `src/ui/Settings.tsx`, `UsagePane.tsx`, `WatchPane.tsx`, composer model menu
- `eval/provider-matrix.json` — `cursor-acp`
- `test/cursor-lane.test.ts` plus launch, login, hold, usage, no cross-talk
- `README.md`, `GOAL.md`, `AGENTS.md`
