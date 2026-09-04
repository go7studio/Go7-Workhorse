# Workshop packs — host/pack contract (v1 design, 2026-09-04)

Status: built. The contract is `src/lib/workshop-pack.ts`; the host is
`electron/workshop-host.ts` (poll, namespace, caps) and
`electron/workshop-install.ts` (tag archive or folder, staged, validated);
the renderer is `src/ui/workshop-paint.tsx`; the install UI is
`src/ui/WorkshopBlock.tsx`. Workhorse ships no pack. The DGX Spark packs and
their collector live at `github.com/go7studio/workshop-pack-dgx-spark`.
`test/workshop-never.test.ts` pins that no vendor word returns to the host.

Workshop is two things: the **host** (Workhorse: rail, renderer, fetcher,
install UI — ships on the app's cadence) and **packs** (dashboards for one
system, in their own repos, added by the user from Settings → Skills →
Workshop).

Additions since review, all in the contract file: `text` takes `parts` like
`kv` (a primary line joined with ` · `); `basename` format; a json source may
set `namespace` (defaults to the pack id). The DGX packs use `namespace: "v0"`
so URLs join to the gateway allowlist `/workshop/v0/feed`; the confirm screen
shows the full URL either way.

## 1. What a pack is

A pack is a folder of data. **No pack code ever runs on the desk.**

```
pack.json     id, name, version, contract, description, homepage,
              sources[], strip[], cards[]
collector/    optional. Scripts the OPERATOR installs on the remote box.
              The desk stores them, shows them, never executes them.
README.md     what the pack reads, how to install the collector
```

One pack = one module on the rail. An archive may hold several pack folders
(root or `packs/*`); each installs as its own module. Job log stays its own
module beside Box monitor, as `RAIL.md` locks.

`contract` is the vocabulary major this pack was written against (`1`).
It is not a Workhorse version. Additive widgets keep the major; a rename or
a removal bumps it.

## 2. Sources — the only thing the host fetches

```json
"sources": [
  { "id": "feed",  "kind": "json",   "path": "feed", "pollMs": 2000, "freshMs": 120000, "asOf": "/asOf", "schema": "go7-workshop-feed/v0", "maxBytes": 262144 },
  { "id": "infer", "kind": "probes", "probes": ["healthz", "readyz", "models"], "pollMs": 5000 }
]
```

- Every read is a GET through one **Local Compute host** the user already
  configured, with that host's bearer. The user picks the host at grant time.
- `json` sources are confined to a gateway namespace under `/workshop/`:
  the host builds `<baseUrl>/workshop/<namespace ?? pack-id>/<path>`. Packs
  that share one feed (or match a host allowlist like `/workshop/v0/feed`)
  set `namespace` explicitly. `path` matches
  `^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*$` — no leading slash, no
  `..`, no `//`, no `:`, no `?`, no `#`, no backslash, no percent-escapes.
  After the join the host asserts `url.origin === host origin` and that the
  pathname starts with `/workshop/<namespace>/`. A pack cannot name `/v1/keys`.
- `probes` come from a fixed host-owned list (`healthz` → `/healthz`,
  `readyz` → `/readyz`, `models` → `/v1/models`). A pack picks names, never
  paths. Probe results are `ok | unauthorized | down | unknown` plus an
  `http-NNN` detail; the `models` probe also yields the id list.
- Host clamps: `pollMs ≥ 2000`, `maxBytes ≤ 256 KiB` streamed with a hard cap
  (not measured after `text()`), total and idle deadlines, `redirect: "error"`,
  at most 4 sources and 8 probes per pack, one in-flight request per source,
  jitter and backoff on failure. `schema` is a compatibility string the host
  compares; shape is validated by the host (object root, depth ≤ 16, ≤ 4 000
  nodes, strings ≤ 16 KiB).
- Freshness: the document at `asOf` must be within `freshMs`; otherwise the
  source is `stale` and its values paint `—`.
- Main owns the timers. The renderer never fetches; it receives
  `{ layout, documents, status }` over IPC.

## 3. Cards — a closed vocabulary, painted by Workhorse

Values bind by JSON pointer (RFC 6901, own properties only, `__proto__` /
`constructor` / `prototype` segments rejected) into a source document:
`"feed:/job/live/step"`. A synthetic `desk:` document carries what only the
desk knows: `desk:/feed/present`, `desk:/feed/asOf`, `desk:/host/emptyCapabilities`,
`desk:/pack/name`.

Widgets (v1): `ring` (percent fields only), `bar` (`num`/`den`), `text`, `kv`,
`pair` (two big numbers with sub-lines), `meta` (joined parts), `chips`,
`probes`, `flags` (`words` map), `log` (`lines ≤ 200`), `hbox` (children side
by side), `switch`.

`switch` is the one conditional and replaces every desk-side branch today:

```json
{ "w": "switch", "cases": [
  { "when": "feed:/job/durable/jobComplete",    "is": true,  "paint": { "w": "text", "value": "complete" } },
  { "when": "feed:/job/durable/undertrainedFlag", "is": true, "paint": { "w": "text", "value": "undertrained" } },
  { "when": "feed:/job/durable/jobComplete",    "is": false, "paint": { "w": "text", "value": "open" } }
], "else": { "w": "text", "value": "—" } }
```

Formats: `int`, `fixed1`, `fixed2`, `tokens`, `watts`, `hours`, `wall`,
`clock`, `age`, `writer`, `map` (`{ "true": "parked", "false": "up" }`),
`strip` (`{ "prefix": "NVIDIA " }`). No expressions. No arithmetic on the desk:
derived numbers (pct, remain, hours to floor, s/it) are published by the
collector in the feed. The desk only formats and draws `bar` ratios.

Unknown widget or format, unknown source kind, bad pointer, bad path: the
install or update is **refused** with "needs a newer Workhorse" or the exact
field. A pack already installed when Workhorse is downgraded paints that row
as `—` with the reason in its title; nothing else changes.

There is no action widget. Nothing in the vocabulary can start, stop, route,
lease, or write. `test/workshop-never.test.ts` pins that.

## 4. Grants — generic, worded by the pack

Host-enforced kinds: `read.json` (one source) and `read.probes` (one probe
list), each bound to a host id. The confirm screen shows the host, the exact
URLs the host will build, cadence, and byte cap — never the pack's prose
alone. Settings store:

```ts
{ id, version, contract, hostId, on, sources: string[] }
```

`normalizeWorkshopSettings` learns these fields in the same change that adds
them, or a save strips them. Turn off clears `sources`. Remove deletes the
folder and the row.

## 5. Install — archive or folder, no git

Settings → Skills → Workshop → **Add pack**:

- Paste an `https` repo URL. The host resolves the highest semver tag and
  downloads that tag's archive (GitHub/GitLab archive URL) with Electron's
  `fetch`, the same path `app-update.ts` already uses. No `git` binary. Public
  repos only in v1.
- Or pick a folder (mirrors `desk:import-skill`). The folder is **copied**,
  never referenced.
- Either way: extract or copy into a private staging dir; refuse symlinks,
  hard links, absolute or `..` entries, reserved Windows names, > 2 000 files
  or > 8 MiB; validate `pack.json` against the host schema; derive the
  destination from the validated `id` (`PACK_ID`, case-folded uniqueness);
  then rename atomically to `userData/workshop/packs/<id>/`. Record
  `{ repo, tag, sha256 }` beside it.
- Update: fetch tags again; if `sources`, `hostId` needs, cadence, byte caps
  or `contract` changed, re-confirm before applying; card-only changes apply
  with a version note.
- `collector/` is shown ("View install notes", "Reveal folder") and never
  executed, chmodded, or copied to a remote. The desk does not install on the
  box.
- Marketplace (later): an index JSON in a go7studio repo listing
  `{ id, name, repo, description }`. The desk lists it; install is the same
  archive path. Nothing else changes because nothing from a pack runs.

## 6. Repos

| Repo | Holds |
| --- | --- |
| `go7studio/Go7-Workhorse` | host: rail, renderer, fetcher, install UI, this contract, JSON schema, tests, one fixture pack under `test/fixtures` (not shipped) |
| `go7studio/workshop-pack-dgx-spark` (new) | `packs/box-monitor/pack.json`, `packs/job-log/pack.json`, `collector/workshop-feed.py` + systemd units, README (the operator doc moves here from `METHOD.md`) |

`package.json` `extraResources workshop/packs` goes away; an artifact test
proves the installer carries no pack and no collector.

## 7. Migration — as built

1. **Contract + fetcher + renderer, packs still bundled.** `pack.json` schema
   and parser; namespaced GET with the path rule and post-join origin
   assert; streamed byte cap; `redirect: "error"`; generic renderer painting
   the DGX `pack.json` from the existing components, verified against the
   current rail in the harness. `deriveJob` stays on the desk as fallback for
   `go7-workshop-feed/v0` until the collector publishes `job.derived`.
2. **Settings shape + host picker.** New row fields, normalizer, legacy
   `box-monitor` / `job-log` rows become off with "review grants" — never
   silently widened to `read.json`.
3. **Add pack** (archive + folder), update, remove, staging rules and tests
   (zip-slip, symlink, size, id collision).
4. **Extract.** DGX repo created; bundled packs and `extraResources` removed;
   never-test rewritten to pin: no action widget, GET only, origin lock,
   no pack file executed or imported.

## 8. Reviewed

Adversarial reviews on 2026-09-04 by two independent models against the first
draft. Adopted: gateway namespace and post-join origin assert (both flagged
bearer exfiltration through a pack-supplied path); archive install instead of
`git clone`; staged link-free extraction; streamed byte cap; fail-closed
contract major; `hbox` and `switch` so Models, Router, Gate, Status, and Feed
age are expressible; `desk:` document; Job log stays a module; `deriveJob`
kept until `job.derived` ships; four PRs. Rejected for v1: marketplace index,
private repos, publisher signatures beyond the archive digest, sandboxed
webview panels (possible later escape hatch behind its own grant).
