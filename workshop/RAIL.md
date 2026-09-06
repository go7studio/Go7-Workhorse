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
| Desk rail **Manage** sheet | **INSTALL / GRANT / CATALOG** — primary manage home. Same `WorkshopBlock` (Installed / Available / Local). |
| Settings → Workshop | **Secondary deep-link** — same install/grant/catalog. Not the live watch surface. |
| Desk **Workshop rail** | **Live watch** — primary soak. Always-visible Manage chrome (including empty / all-Off). Collapsed strip + expand when packs On. |
| Breakout window | **Secondary detach** — same cards, optional. |
| Skills | **Not** the Workshop home. |
| Sidebar dock | **No** Workshop dock row. |

### Rail behavior

- **Empty / all-Off:** thin hairline stub (~56–64px) with a **single** CTA — **Add packs** when zero packs installed (Available-first sheet); **Turn packs on** when packs are installed but all Off (Manage, not Install). No meters, no Install hero on all-Off. Cold desk reaches catalog in ≤2 clicks without Settings or Skills.
- **Manage:** on collapsed and expanded headers; sheet title / aria-label **Manage packs**; hosts one `WorkshopBlock` (`surface="sheet"`). Focus trap while open; restore focus to opener on Escape / Close / backdrop.
- **Collapsed strip** (when any pack On): `GPU% · watts · writer · models one-liner` (Box monitor). Job log collapsed = short “log live” / off hint.
- **Expand**: full denser cards — Box / Models / Infer / Router / Job / Feed (same host grants; richer labels from existing feed/soak).
- **Multi-pack**: rail **stacks modules** when each is On (Box monitor, Job log, future packs) — not one monolithic page.
- Theme: inherit desk light/dark. Work-like chrome (hairlines, `.tiny`, present-tense). Not a second NVIDIA Dashboard.
- Sparklines **only** if a time series already exists in the feed. **v1: no new time-series store.** Use bars/chips from current snapshot only.
- Still never: vendor, leftover ring, live watch in Settings, start/stop/route/lease. Labels + soak only.

### Denser status (existing data only)

From feed + soak already granted: `probeUnit`, `qwen` parked/up, models line (ids or train-exclusive / empty-caps plain words), `/healthz` `/readyz` `/v1/models`, feed present + age from `asOf`, `oneWriter`, `latest.json` basename, GPU %, watts.

### Bible delta (one sentence append)

> Live watch is a desk-attached Workshop rail (collapsed strip → expand; packs stack when On). Manage opens a sheet with WorkshopBlock; Settings → Workshop is secondary; Skills is not the Workshop home; breakout remains optional detach.

## Out of scope v1

Inventing history sparklines, sidebar dock row, Usage/Watch fold-in, gateway/SSH changes.

## Paint

Wires, states, token notes, and the never check for this surface: `RAIL-PAINT.md` (2026-09-04).

## Packs

The rail is a host. Packs are installed separately and paint through a closed vocabulary: `PACKS.md`. Workhorse ships none; the DGX Spark packs are `github.com/go7studio/workshop-pack-dgx-spark`.
