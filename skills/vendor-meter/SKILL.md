---
name: vendor-meter
description: Wire any new or existing Workhorse import into leftover metering. Use when leftover rings show “…”, when adding a vendor ACP API MCP or custom bot, when a billing or quota source is unknown, or when Settings → Usage must follow official docs instead of a guessed URL.
---

# Vendor meter

Fill a Workhorse leftover ring from an **official** usage source. This skill is the import procedure for any vendor — ACP child, HTTP API, MCP quota tool, or custom bot. Do not invent numbers. Do not start from a remembered URL.

The Cursor rings stayed “…” because a reader hit a 404 on an unpublished host. That is the failure this procedure exists to stop.

## Rules

1. Open that vendor’s **current** official docs (`docs`, `developers`, `platform`, `llms.txt`, API reference). Do not reuse last month’s URL from memory.
2. Pick **one** documented transport: HTTP usage/quota JSON, CLI/ACP usage JSON, MCP tool the vendor documents as the meter, or dashboard JSON the vendor already publishes. Stop if none exists.
3. Record leftover **or** used (never both as the same number), reset time, context window, model list, and the transport (HTTP / ACP / MCP / CLI).
4. Workhorse rings are **leftover**. If the source is “% used”, leftover is `100 − used`. If the source is remaining/limit, leftover is remaining/limit. If the source is used/limit (requests or tokens), leftover is `100 − (used/limit)×100`.
5. Missing field, 404, empty body, or unpublished URL → leftover **unknown**. Never write 0% or 100%. Never scrape `api2.*` or other private hosts.
6. A live send that fails before prompt invents no tokens.
7. Each import keeps its own ring. Never fold one vendor’s leftover into Grok, Cursor Models, or another bot.

Scale follows the docs. If the field is already 0–100, `1` means 1% used (leftover 99%), not a 0–1 fraction.

## Classify the import

| Kind | How it lands on the desk | Meter home |
|---|---|---|
| Stock ACP vendor (`grok` / `codex` / `claude` / `cursor` or a new ProviderId) | Vendor login + ACP child | `electron/<vendor>-plan.ts` → `ipc <vendor>:plan-usage` → `plans.<vendor>` |
| Custom HTTP bot | `workhorse_setup_custom_bot` (`baseUrl`, model, key) | `customPlanRemainsUrl` + `parseCustomPlanUsage` → `plans.custom[botId]` |
| MCP quota/usage tool | Only if the vendor’s docs name that tool as the meter | Same parse contract; still one `GrokPlanUsage` object |
| CLI / ACP usage JSON (statusline, `/status`, oauth usage) | Same login as the child | Same parse function the HTTP path would use |

Dashboard-only with no documented JSON → leftover stays unknown. Do not invent a reader.

## Find the source

1. Official site first. Search that page for usage, quota, billing, rate limit, remains, subscription.
2. Confirm method + host + auth header on that page. A blog, gist, or GitHub issue is not enough.
3. Note whether the field is **used** or **remaining**, the unit (percent, requests, tokens), reset field, and whether there are separate pools/lanes.
4. Also copy the documented model list and context-window size. Those are metadata, not leftover.
5. If the page has no usage/quota JSON or documented MCP/CLI meter, say leftover is unknown.

## Wire into leftover metering

Every import, new or repaired, ends on the same contract: `GrokPlanUsage` `{ usedPercent, leftPercent, period, resetsAt, products[] }` then `leftoverForCard` (`src/lib/usage.ts`).

1. Attach the slot (`workhorse_list_bots` / login / `workhorse_setup_custom_bot`). Do not invent a key.
2. Fetch **one** official payload. 404 or unpublished host → stop; leftover unknown.
3. Parse with a shipped function. Add or extend `parse*PlanUsage` / `customPlanRemainsUrl` only when live docs require it.
4. Stock vendor: `electron/main.ts` `ipc <vendor>:plan-usage`. Custom bot: `custom:plan-usage` with that bot’s `baseUrl` + stored key.
5. Map the ring: stock → `plans.<vendor>`; custom → `plans.custom[botId]` (`focus` `bot:<id>`); lanes → `products[].product` and `leftoverForCard` per lane.
6. Settings → Usage and Watch must call `leftoverForCard`. Do not add a second meter.
7. Tests drive the **shipped** parse function: used-source inverts; remaining-source stays leftover; missing/404 → `undefined`; this import’s leftover is not Grok’s or Cursor Models’.

If the official meter is gone, say leftover is unknown. Do not guess. Do not keep a 404 reader.

## Repair loop

1. `workhorse_list_bots` — is the slot attached and `canCall`?
2. Re-open current docs. Confirm the fetch URL or MCP/CLI path still exists.
3. Parse with the shipped function. Fixture as above.
4. Confirm Settings → Usage leftover comes from `leftoverForCard`.
5. If docs moved, update the parser to the new documented fields and drop the dead URL.
