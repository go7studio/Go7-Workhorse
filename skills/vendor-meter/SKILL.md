---
name: vendor-meter
description: Attach or repair a Workhorse usage meter for a vendor or custom bot. Use when leftover rings show “…”, when Claude MiniMax or Synthetic usage is empty, when adding a billing or quota API, or when the user asks how to fill Settings → Usage from official docs.
---

# Vendor meter

Fill a Workhorse leftover ring from an **official** usage source. Do not invent numbers.

## Rules

1. Open that vendor’s **current** docs (docs index / `llms.txt` / API reference). Do not reuse last month’s URL from memory.
2. Pick **one** documented transport: HTTP usage/quota JSON, CLI/ACP usage JSON, or a dashboard JSON the vendor already documents. Stop if none exists.
3. Record leftover **or** used (never both as the same number), reset time, context window, model list, and the transport (HTTP / ACP / CLI).
4. Workhorse rings are **leftover**. If the source is “% used”, leftover is `100 − used`. If the source is remaining/limit, leftover is remaining/limit.
5. Missing field, 404, empty body, or unpublished URL → leftover **unknown**. Never write 0% or 100%. Never scrape `api2.*` or other private hosts.
6. A live send that fails before prompt invents no tokens.

## Find the source

1. Official site first: `docs`, `developers`, `platform`, `llms.txt`.
2. Confirm the path in that page (method + host + auth header). A blog, gist, or GitHub issue is not enough.
3. Note whether the field is **used** or **remaining**, and the unit (percent, requests, tokens).
4. Also copy the documented model list and context-window size. Those are metadata, not leftover.
5. If the page has no usage/quota JSON, say leftover is unknown. Do not invent a reader.

## Desk path

- Stock vendor (Claude): Settings → LLMs connected + official plan fetch. Parser is `parseClaudePlanUsage` / `fetchClaudePlanUsage` (`electron/claude-plan.ts`).
- Custom bot (MiniMax, Synthetic): `workhorse_list_bots` then `workhorse_setup_custom_bot` with documented `baseUrl`, model, and key. Plan fetch uses `customPlanRemainsUrl` + `parseCustomPlanUsage` (`electron/custom-plan.ts`).
- Usage card leftover is `leftoverForCard` (`src/lib/usage.ts`). Claude → `plans.claude`. Custom → `plans.custom[botId]`. Never fold into Grok or Cursor Models.

## Known official shapes (verify against live docs before changing code)

| Slot | Documented source | Leftover |
|---|---|---|
| Claude | Claude Code statusline `rate_limits.five_hour` / `seven_day` (`used_percentage` = **used**). Shipped fetch: `GET https://api.anthropic.com/api/oauth/usage` with Claude Code OAuth + `User-Agent: claude-code/*` (`utilization` / `percent` = **used**). | `100 − used` |
| MiniMax | `GET https://www.minimax.io/v1/token_plan/remains` (or minimaxi.com). `current_weekly_remaining_percent` / `usage_percent` = **remaining**. | remaining as leftover |
| Synthetic | `GET https://api.synthetic.new/v2/quotas`. `{ subscription: { limit, requests, renewsAt } }`. `requests` = used, `limit` = pack size. | `100 − (requests/limit)×100` |

If the live JSON no longer matches, update the parser to the new documented fields. Do not keep a 404 reader.

## Repair loop

1. `workhorse_list_bots` — is the slot attached and `canCall`?
2. Confirm the fetch URL from current docs, not from this table if docs moved.
3. Parse with the shipped function. Fixture: used-source inverts; remaining-source stays leftover; missing → `undefined`.
4. Settings → Usage leftover must come from `leftoverForCard`, not a second meter.
5. If the official meter is gone, say leftover is unknown. Do not guess.
