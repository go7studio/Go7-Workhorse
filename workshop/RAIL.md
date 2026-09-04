# Workshop rail (paint surface) — locked 2026-09-04

Steve UX redirect. Host / grants / read-only law unchanged. **Paint surface changes.**

## Problem

1. Breakout meters are too sparse for Spark soak glance.
2. Watching from Settings → Skills feels wrong (that surface is install/grant).
3. Want a small side widget / dash popout — DGX Dashboard *vibe* (dense now-status), Workhorse-styled, not NVIDIA clone, not a Settings page.
4. Small but expandable; Workshop is an **add-on rail** where several tool modules stack later.

## Lock

| Surface | Role |
| --- | --- |
| Settings → Skills → Workshop | **INSTALL / GRANT only** — opt-in, confirm grants, turn off. Not the live watch surface. |
| Desk **Workshop rail** | **Live watch** — primary. Collapsed strip + expand. |
| Breakout window | **Secondary detach** — same cards, optional. |

### Rail behavior

- **Collapsed strip** (always when any pack On): `GPU% · watts · writer · models one-liner` (Box monitor). Job log collapsed = short “log live” / off hint.
- **Expand**: full denser cards — Box / Models / Infer / Router / Job / Feed (same host grants; richer labels from existing feed/soak).
- **Multi-pack**: rail **stacks modules** when each is On (Box monitor, Job log, future packs) — not one monolithic page.
- Theme: inherit desk light/dark. Work-like chrome (hairlines, `.tiny`, present-tense). Not a second NVIDIA Dashboard.
- Sparklines **only** if a time series already exists in the feed. **v1: no new time-series store.** Use bars/chips from current snapshot only.
- Still never: vendor, leftover ring, new Settings tab, start/stop/route/lease. Labels + soak only.

### Denser status (existing data only)

From feed + soak already granted: `probeUnit`, `qwen` parked/up, models line (ids or train-exclusive / empty-caps plain words), `/healthz` `/readyz` `/v1/models`, feed present + age from `asOf`, `oneWriter`, `latest.json` basename, GPU %, watts.

### Bible delta (one sentence append)

> Live watch is a desk-attached Workshop rail (collapsed strip → expand; packs stack when On). Settings → Skills → Workshop stays install/grant only; breakout remains optional detach.

## Out of scope v1

Inventing history sparklines, new Settings tab, sidebar dock row, Usage/Watch fold-in, gateway/SSH changes.

## Paint

Wires, states, token notes, and the never check for this surface: `RAIL-PAINT.md` (2026-09-04).
