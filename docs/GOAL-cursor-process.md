# Goal: Cursor integration process (usage lanes, watch, inner agents)

Do **not** ship a live Cursor send until this process is in the adapter. A single `provider: "cursor"` token bucket is a fail. Cursor’s monthly limits are account-wide; they also drain the open IDE and Cloud Agents. The desk has to see both pools and hold the right lane.

Read with `docs/GOAL-cursor-acp.md` and `docs/agent-goal-cursor-acp.md`. Official pools: [Models & Pricing](https://cursor.com/docs/models-and-pricing).

## Why this exists

Cursor does not have one allowance. It has **two pools**, each resetting on the billing cycle:

| Pool | What draws from it | Plan include | When it is extra |
|---|---|---|---|
| **Cursor Models** | Composer 2.5, Cursor Grok 4.6, Cursor Grok 4.5 (and their Fast variants) | Generous on Pro / Pro Plus / Ultra / Start | On-demand after the include, at Cursor’s listed token rates. No Cursor Token Rate. |
| **Other Models** | Every third-party model you pick (Claude, GPT, Gemini, …). Auto Balance / Auto Intelligence when they route off-family. | Pro $20, Pro Plus $70, Ultra $400. Start: **$0**. | On-demand at that model’s API price. Teams/Enterprise add a Cursor Token Rate ($0.25 / 1M) on third-party. |

CLI `/usage` already splits **Auto vs API**, included meters, on-demand spend, plan name, reset date. Workhorse must show the same split, not one Cursor ring.

If we only track “Cursor tokens”:

- Composer work would look spent when Other Models is empty (or the reverse).
- Watch would hold **every** Cursor chat, or none.
- Routing could not prefer Composer when the extra-model pool is low.
- A Cursor spawn crew of Claude-via-Cursor would silently eat the monthly API include and then on-demand, and the rest of the harness would not know why later Cursor turns fail.

`usageProviderForSession` today maps unknown providers to Grok. Cursor events would land in the Grok bucket. That is also a fail.

## Process (do this in order)

### 0. Classify before you send

Every Cursor model id maps to a **lane**. Store the lane on the usage event. Do not infer it later from a name in the Usage pane.

| Lane id | Models (match on lowercase slug) | Watch key | Default for new Cursor chats |
|---|---|---|---|
| `cursor-models` | `composer-2.5`, `composer-2`, `composer`, `grok-4.6`, `grok-4.5`, Fast variants of those | `cursor:cursor-models` | **Yes** — Composer 2.5 |
| `other-models` | Anything else with a concrete third-party id (`claude-*`, `gpt-*`, `gemini-*`, …) | `cursor:other-models` | No. User or orchestrator must pick it. |
| `auto-cost` | `auto-smart` + `optimize_for=cost` (Auto Cost) | `cursor:cursor-models` unless Cursor later documents otherwise | Allowed |
| `auto-routed` | `auto-smart` + `balanced` / `intelligence` | `cursor:other-models` **until** the run reports the resolved model. Then re-bucket that turn. | Allowed, but treat as Other Models for holds until resolved |
| `unknown` | Missing / empty model | Do not send. Do not invent a lane. | — |

Composer / Cursor Grok on this slot is **not** Workhorse’s Grok Build ACP vendor. Two different bills. Two different `ProviderId`s (`cursor` vs `grok`).

Ship a pure function `cursorUsageLane(model, params?)` in `src/lib/` and unit-test the table. The host and the Usage pane both call it. Do not duplicate the list in React.

### 1. Wire the adapter (ACP only)

Same contract as `GOAL-cursor-acp.md`. Extra rules from this process:

- Default model is **Composer 2.5** (`cursor-models`).
- The model picker groups Cursor Models above Other Models. Other Models need a visible “uses the monthly API include / on-demand” hint.
- `workhorse_spawn_agent` with `provider: "cursor"` and no model → Composer 2.5, not the parent’s Other Models id.
- One ACP child per Workhorse session. Reuse on the same launch key. Never spawn `Cursor.app`.
- Do not start a live send until lane classification + `recordUsage` + watch hold for **both** keys exist.

### 2. Record every turn (Workhorse-attributed)

On ACP usage / SDK `TokenUsage` / run result:

```
recordUsage({
  provider: "cursor",
  model: <resolved slug>,          // not "auto" if the run named a model
  lane: "cursor-models" | "other-models" | …,
  inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
  costUsd: <only if Cursor reported billed $>,
  sessionId, projectId,
})
```

Rules:

- Preview / failed-before-prompt → no event.
- Inclusive-turn repair still applies (same Grok/Codex double-count bug).
- `usageProviderForSession` / `DESK_VENDORS` / `byProvider` must know `cursor`. Never fold into Grok.
- Local events are **this desk’s** Cursor turns. They are not the whole Cursor account.

### 3. Fetch the account meters (harness-wide)

Cursor limits are shared with the IDE, CLI, Cloud Agents, and this adapter. Token sums from Workhorse alone will under-count.

Add `electron/cursor-plan.ts` next to `grok-plan.ts` / `claude-plan.ts`:

- Prefer an **official** usage read (CLI `/usage` JSON if it exists, documented dashboard/admin usage, or ACP/SDK `getUsage` plus included-pool fields). Confirm the endpoint against current Cursor docs before locking the URL. Do not scrape `api2.cursor.sh` privately.
- Parse into `GrokPlanUsage` with **two products**:
  - `{ product: "cursor-models", label: "Cursor Models", usagePercent, resetsAt }`
  - `{ product: "other-models", label: "Other Models", usagePercent, resetsAt }`
- Period is **monthly** (Cursor billing cycle), not weekly. `WatchPlans.cursor` is that object.
- Poll on the same cadence as other plan fetches (open Settings / Watch, periodic refresh). Not on every keystroke.
- If the official meter is missing, show Workhorse-attributed tokens for that lane and mark leftover **unknown**. Do **not** invent a percent. `workhorse_list_bots` already says: unknown leftover ≠ missing vendor.

On-demand spend (past the include) is a third number when Cursor reports it. Surface it on the Cursor Usage card as “on-demand this cycle.” It does not replace the two pool rings.

### 4. Watch holds per lane (this is the harness service)

Watch already holds a send when a vendor’s daily bank or leftover is spent (`evaluateWatchHold`). Cursor must hold **by lane**, not by `provider === "cursor"`.

| Situation | Hold? |
|---|---|
| Composer chat, Cursor Models leftover spent (or daily lock hit) | Hold that chat. Offer switch to another **desk** vendor (Grok Build, Claude ACP, Codex, custom) — not to Other Models unless the user picks it. |
| Composer chat, Other Models spent | **No hold.** That pool is not this turn. |
| Claude-via-Cursor chat, Other Models spent or on-demand cap reached | Hold that chat. Offer Composer 2.5 or a non-Cursor vendor. |
| `auto-routed` until resolved | Treat as Other Models for the hold. |
| Cursor 429 / rate limit | Existing rate-limit notice. Do not also mark the pool spent unless the plan meter says so. |

`workhorse_list_bots` rows for Cursor should expose **two** leftovers when both are known (`cursor-models` vs `other-models`), or two bot rows (`Cursor · Composer`, `Cursor · API`). Orchestrators must not read one `leftoverPercent` and assume both pools.

Routing (`chooseRoutingDecision`) must be capacity-aware on **lane**:

- Prefer `cursor-models` when Other Models usedPercent is high.
- Do not route a “quick” turn onto Sol/Opus-via-Cursor when Composer is attached.
- A hold on Other Models must not take Composer off the candidate list.

### 5. Calling agents inside Cursor

There are three different “call an agent” paths. Name them in the UI and in tools. Do not mix status.

| Path | What it is | Usage lane | Workhorse role |
|---|---|---|---|
| **A. Desk spawn** | `workhorse_spawn_agent` `{ provider: "cursor" }` | Default `cursor-models` unless the spawn names an Other Models id | Hidden Workhorse child. Lineup / join apply. Bound folder required. |
| **B. Cursor inner task** | ACP `cursor/task` (explore / shell / computer_use / custom) | **Same Cursor account / same two pools** as the parent turn | Tool row on the parent. Not a lineup worker. Do not `workhorse_await_agents` on it. |
| **C. Open IDE / Cloud Agent** | Agents Window, `POST /v1/agents` | Same account meters | Out of this adapter. Plan fetch still sees the drain. |

Rules:

- Path A is how the desk orchestrates Cursor. Path B is Cursor orchestrating **itself**. Both spend the same monthly pools — that is the harness-wide point.
- A worker Cursor session does not get spawn tools (`GOAL-orchestration.md`). It may still emit `cursor/task`; render those as tools, never as a second crew.
- Fan-out: N Cursor children × Other Models = N times the monthly API include. Default every spawn to Composer unless the slice **needs** a named third-party model.
- `cursor/ask_question` and `cursor/create_plan` must be answered so the child does not sit blocked (see ACP adapter goal). They do not create usage events by themselves.

### 6. Performance

- One child process per chat, not per keystroke. Same launch-key reuse as Grok.
- Cancel maps to `session/cancel`. Do not kill and respawn unless the child is wedged.
- Plan fetch is cached; refresh in the background. A slow dashboard must not block `session/prompt`.
- Do not attach every Settings MCP server if the user turned them off. Extra MCP on Cursor Other Models is extra tokens.
- Images/documents follow existing Workhorse attachment rules. Do not expand video into frames on a Cursor Other Models turn unless the user attached video.
- Nested `cursor/task` during a live parent turn is expected; do not open a second ACP process for it.

### 7. Monitoring (what Settings must show)

Settings → Usage and Settings → Watch, under Cursor:

1. **Cursor Models** ring — included used / left, reset date. Workhorse-attributed Composer + Cursor Grok tokens as a subtitle (“this desk”).
2. **Other Models** ring — included $ / used / on-demand this cycle. Workhorse-attributed third-party tokens as a subtitle.
3. Per-model table for this desk’s Cursor events (Composer vs Claude vs GPT, …).
4. Watch lock can be set **per lane** (same `lockKeys` idea as bots).
5. Support export includes lane + model, never the API key.

A spent Other Models pool is a **harness** notice: “Cursor API include is spent. Composer still runs. Claude/GPT-via-Cursor and the Cursor IDE’s third-party models share this meter.”

## Done when

1. `cursorUsageLane` matches the table; tests cover Composer, Grok 4.6/4.5, Fast, `claude-*`, `gpt-*`, `auto-smart` cost vs balanced, unknown.
2. `recordUsage` for Cursor always has `provider: "cursor"` and a lane. No event lands in Grok.
3. `WatchPlans` has `cursor` with two products. Holds are per lane. Composer is not held when only Other Models is spent.
4. Plan fetch uses an official meter when available; otherwise leftover is unknown, not 0% and not 100%.
5. Spawn without a model uses Composer 2.5. `workhorse_list_bots` does not collapse both pools into one leftover.
6. Inner `cursor/task` is a tool row, not a desk worker. Desk spawn is a child session.
7. Usage pane shows two Cursor rings plus on-demand when reported.
8. Adapter goal tests still pass. This process is not optional follow-up.

## Out of scope

- Scraping unpublished Cursor billing URLs
- Merging Cursor Models with Workhorse’s Grok Build SuperGrok leftover
- Paying or topping up on-demand from the desk
- Driving the open IDE chat
- Grok Bot
- Changing join-turn

## Likely files

- `src/lib/cursor-lane.ts` (new) — classification
- `src/lib/types.ts` — usage lane on `UsageEvent`; `WatchPlans.cursor`
- `src/lib/usage.ts`, `watch.ts`, `routing.ts`, `settings.ts`
- `electron/cursor-plan.ts`, `cursor-host.ts` (usage + lane stamp)
- `src/ui/UsagePane.tsx`, `WatchPane.tsx`
- `docs/GOAL-cursor-acp.md` — ship gate
- `test/cursor-lane.test.ts`, watch/usage cases
