---
name: workhorse-workshop-pack
description: >
  Design and ship modular Go7 Workhorse Workshop packs (toolbox builder /
  modular add-on / toolbox dashboard). Walks host vs pack split, closed widget
  vocabulary, sources and namespace, optional collector, release tags, and
  install confirm URLs. Use when the user asks to design a Workshop pack,
  toolbox builder add-on, pack.json, modular Workhorse dashboard, or rail card
  module. Full skill: ~/.cursor/skills/workhorse-workshop-pack/SKILL.md
---

# Workhorse Workshop pack (desk pointer)

Canonical skill for any harness: `~/.cursor/skills/workhorse-workshop-pack/`.
Read that `SKILL.md` and `references/pack-skeleton.json` before designing a pack.

In this tree: `workshop/PACKS.md`, `src/lib/workshop-pack.ts`, `workshop/METHOD.md`.
Example: [go7studio/workshop-pack-dgx-spark](https://github.com/go7studio/workshop-pack-dgx-spark).

## Law (short)

- Pack = data. Nothing from a pack runs on the desk.
- Closed widgets only; `switch` is the only conditional; no action widgets.
- JSON GETs under `/workshop/<namespace>/<path>` — **namespace defaults to pack id but may differ** (set `namespace` when the gateway path ≠ id).
- Probes are host-owned names only (`healthz`, `readyz`, `models`).
- Confirm screen URLs via `packSourceUrls`; grants = confirmed source ids.
- Collector is operator-installed; desk never runs it. Publish derived fields in the feed.
- Never: start/stop/route/lease/SSH/write; no domain math on the desk.
- Install: public repo highest semver tag, or folder. Ship by tagging; Update re-confirms when sources change.
- Validate with `parseWorkshopPack`. Checklist and skeleton live in the Cursor skill.
