---
name: workhorse-workshop-pack
description: >
  Design and ship modular Go7 Workhorse Workshop packs (toolbox builder /
  modular add-on / toolbox dashboard). Walks host vs pack split, closed widget
  vocabulary, sources and namespace, optional collector, release tags, and
  install confirm URLs. Use when the user asks to design a Workshop pack,
  toolbox builder add-on, pack.json, modular Workhorse dashboard, or rail card
  module.
---

# Workhorse Workshop pack (toolbox builder)

A pack is **data**. Nothing from a pack runs in Workhorse. You design
`pack.json` (and optional operator-only `collector/`); the desk fetches,
validates, and paints.

Contract: Workhorse `workshop/PACKS.md` + `src/lib/workshop-pack.ts`
(`parseWorkshopPack`, `packSourceUrls`). Example:
[go7studio/workshop-pack-dgx-spark](https://github.com/go7studio/workshop-pack-dgx-spark).

## Host vs pack

| | Host (Workhorse) | Pack (separate repo) |
|---|---|---|
| Owns | Rail, renderer, poller, install UI, grants | `pack.json`, optional `collector/`, README |
| Runs | GETs through a Local Compute host the user picks | Nothing on the desk |
| Cadence | App releases | Your semver tags |

Folder shape:

```
packs/<id>/pack.json     required
packs/<id>/collector/    optional — operator installs on the remote box
packs/<id>/README.md     what it reads; how to install the collector
```

An archive may hold several pack folders; each installs as its own module.
`contract` is always `1` (vocabulary major), not the app version.

## Closed widget vocabulary

Bindings: `"<sourceId>:<json-pointer>"` (RFC 6901). Also `desk:` and `status:`.

| Widget | Use when |
|---|---|
| `switch` | Only conditional. Cases with `is` or `has`; optional `else`. Replaces desk-side branches. |
| `hbox` | Side-by-side children (1–6). |
| `bar` | Ratio from two numbers (`num` / `den`). Desk formats only; no other math. |
| `ring` | Percent gauge (`of` must be a percent field). |
| `kv` / `text` / `pair` / `meta` | Labels and values. `parts` join with ` · `. |
| `chips` | String array as chips. |
| `probes` | Paint a `kind: "probes"` source (`of` = that source id). |
| `flags` | Map of boolean/string keys → words (`words` object). |
| `log` | String array tail (`lines` 1–200). |
| `note` | Fixed short string. |

Formats: `int`, `fixed1`, `fixed2`, `tokens`, `watts`, `hours`, `wall`, `clock`,
`age`, `writer`, `map`, `strip`, `basename`. No expressions. Derived numbers
(pct, remain, hours-to-floor, s/it) ship in the feed from the collector.

Limits (refuse on install): ≤4 sources, ≤8 probes, ≤10 strip widgets, ≤12 cards,
≤24 rows/card, pollMs ≥ 2000, maxBytes ≤ 256 KiB, nesting depth ≤ 4.

## Sources

Two kinds only:

1. **`json`** — GET `<base>/workshop/<namespace>/<path>`.
   - `path`: relative, `^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*$` — no leading `/`, no `..`.
   - `namespace`: optional. Defaults to pack `id`. **Do not assume pack id == gateway path.**
     `namespace` must match the **gateway allowlist** route segment, not another pack's id
     unless that id is literally what the gateway serves. Spark live box-monitor / job-log
     feeds are `/workshop/v0/feed` → set `"namespace": "v0"`. The confirm screen shows the
     full URL either way (`packSourceUrls`).
   - Gateway allowlist must match the real route you declare.
2. **`probes`** — host-owned paths only. Pack picks names: `healthz`, `readyz`, `models`. Never custom paths.

Optional on json: `asOf` (pointer), `schema` (compatibility string), `freshMs`, `maxBytes`.

## Grants and confirm URLs

Settings store `{ id, version, contract, hostId, on, sources: string[], sourceFingerprints? }`.
`sources` = source **ids** the user confirmed. Fingerprints bind those ids to the confirmed
descriptors so an update cannot keep polling new URLs under old grants.

At Turn on, Workhorse lists exact URLs from `packSourceUrls(baseUrl, packId, source)` — never pack prose alone. User picks Local Compute host + which source ids to grant.

## Install and release

Desk: Settings → Skills → Workshop → **Add pack**.

1. Public `https` GitHub repo only → highest semver tag archive (no `git` binary), or **From folder** (copy, never reference). GitLab and other hosts are refused.
2. Stage → refuse symlinks / zip-slip / size → `parseWorkshopPack` → install under `userData/workshop/packs/<id>/`.
3. To ship: bump `version` in each `pack.json`, tag `vX.Y.Z`, push tag. User presses Update in Workshop. Source/cadence/contract changes force re-confirm for **every** affected pack in the archive (not only the row you clicked); card-only changes apply with a version note.

## Optional collector

Operator-installed scripts under `collector/` (point `"collector": "collector"` in pack.json). Desk stores, shows, reveals in Finder — **never executes, chmods, or copies to remote**. Prefer publishing derived fields in the feed so the desk only formats.

## Never

- No start / stop / route / lease / SSH / write widgets or IPC.
- No domain math on the desk (only format + `bar` ratio).
- No pack code imported or executed by Workhorse.
- No inventing probe paths or escaping `/workshop/<namespace>/`.

## New pack checklist

1. Pick `id` (`^[a-z0-9]+(-[a-z0-9]+)*$`), `name`, semver `version`, `contract: 1`, short `description`.
2. Map real gateway routes → `sources[].path` + optional `namespace` (align allowlist; id may differ from path segment).
3. Design `strip` + `cards` from the closed vocabulary; bind only declared sources (or `desk:` / `status:`).
4. Validate with `parseWorkshopPack` (Workhorse `src/lib/workshop-pack.ts`); fix refuse reasons exactly.
5. Optional: `collector/` + README for the operator; publish derived fields when possible.
6. Soak against a fixture feed (object root, depth/nodes/string caps).
7. README: what it reads, install collector, confirm URLs shape, never-list.
8. Tag release; install via GitHub repo URL or folder; confirm grants on the desk.

## Minimal skeleton

See [references/pack-skeleton.json](references/pack-skeleton.json). Optional `namespace` when the gateway route ≠ pack id (Spark live example):

```json
{ "id": "feed", "kind": "json", "namespace": "v0", "path": "feed", "pollMs": 2000, "freshMs": 120000, "asOf": "/asOf", "maxBytes": 262144 }
```

Shared-feed example (job-log reading the same Spark gateway feed as box-monitor):

```json
{ "id": "feed", "kind": "json", "namespace": "v0", "path": "feed", "pollMs": 5000, "freshMs": 120000, "asOf": "/asOf", "schema": "go7-workshop-feed/v0", "maxBytes": 262144 }
```

`switch` pattern:

```json
{ "w": "switch", "cases": [
  { "when": "feed:/done", "is": true, "paint": { "w": "text", "value": "complete" } }
], "else": { "w": "text", "value": "—" } }
```

## Pointers

- Contract: Workhorse worktree `workshop/PACKS.md`, `workshop/METHOD.md`, `src/lib/workshop-pack.ts`
- Example packs: `https://github.com/go7studio/workshop-pack-dgx-spark` (`packs/box-monitor`, `packs/job-log`)
