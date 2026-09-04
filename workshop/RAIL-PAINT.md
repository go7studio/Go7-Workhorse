# Workshop rail — paint spec (2026-09-04)

Design pass on the surface locked in `RAIL.md`. Host, grants, and the
read-only law do not move. This file tells the builder what the rail looks
like, which classes and tokens it reuses, and what each state paints.

Reads `RAIL.md` first. Where the two disagree, `RAIL.md` wins.

## 1. Collapsed rail

Dock: right edge of `.workspace`, third grid column (`auto`). It is the last
column so the sidebar split handle and the main pane never move when a pack
turns On. Present only while at least one pack is On.

Width: **76px** (was 52). 52px cannot hold the models one-liner in plain
words; 76px holds it in three 10px lines. Content column is 64px.

```
┌──────────┐  76px
│ WORKSHOP ‹│  head · section-label 10px · whole head is the expand button
├──────────┤  hairline var(--line)
│  ╭────╮  │
│ ╱  96  ╲ │  GPU ring 44px · hairline track · accent arc · tabular 15px
│ ╲  %   ╱ │
│  ╰────╯  │
│   66 W   │  watts · 13px tabular · rounded to integer
│  ● one   │  writer · 11px · dot is var(--ok) when one, var(--warn) when no
├ ─ ─ ─ ─ ─┤  hairline
│ infer    │
│ down /   │  models one-liner · 10px · 3-line clamp · full text in title
│ train ex…│
├ ─ ─ ─ ─ ─┤
│ 19s      │  feed age · .row-meta 9px · "—" when feed off
└──────────┘
```

Order top to bottom is the locked strip: `GPU% · watts · writer · models`.
Feed age is the only addition; it qualifies every number above it.

Expand control: the head is a `button.tiny` with `aria-expanded`. The whole
strip below it is also a button (already so) — one click anywhere expands.
The chevron `‹` points at the main pane, meaning "grow into it".

Job log only (Box monitor Off): head, then one line `log live` when the tail
is a string, `log —` when unknown. No ring, no watts.

Both packs On: Box strip as above, then a hairline, then `log live` under it.
The collapsed rail does not scroll; if a third pack ever lands, the strip
shows the first two and a `+1` row-meta.

## 2. Expanded rail

Width: **296px** (fits the 300 lock; leaves 4px for the scrollbar gutter).
Transition: `width 160ms var(--ease)`; the global reduced-motion rule already
zeroes it.

```
┌────────────────────────────────────────────────────────┐ 296px
│ WORKSHOP                           feed · 19s ago  ›  │ head
├────────────────────────────────────────────────────────┤ hairline
│ Box monitor                         On · rail   ⌄      │ module head
│ ┌ BOX ─────────────────────────────────────────────┐   │
│ │  ╭──────╮   Watts            66 W                │   │
│ │ ╱   96   ╲  Writer           ● one               │   │
│ │ ╲   %    ╱  tok/param        —                   │   │
│ │  ╰──────╯                                        │   │
│ └──────────────────────────────────────────────────┘   │
│ ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ │ hairline between cards
│ MODELS                            [train exclusive]    │
│ infer down / train exclusive · http-502                │ 12px, wraps, never clips
│ ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ │
│ INFER                                                  │
│ (healthz · up) (readyz · down) (v1/models · down)      │ chips
│ ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ │
│ ROUTER                                                 │
│ Train fence             nvidia-spark-train-infer       │
│ Infer invoke            Local Compute                  │
│ probeUnit               active                         │
│ qwen                    parked                         │
│ labels only, never route/lease/start/stop              │ row-meta
│ ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ │
│ JOB · Bloom soak                                       │
│ Status                  running (one writer)           │
│ latest.json             latest.json          ⓘ title   │ basename only
│ ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ │
│ FEED                                                   │
│ present · 19s ago                                      │ row-meta
├────────────────────────────────────────────────────────┤ module break
│ Job log                             On · rail   ⌄      │ module head
│ ┌ mono 11px · max-height 160px · scrolls ───────────┐  │
│ │ step 18420 loss 2.31 tok/s 41k                     │  │
│ │ step 18440 loss 2.30 tok/s 41k                     │  │
│ └────────────────────────────────────────────────────┘  │
├────────────────────────────────────────────────────────┤
│ Detach                                                 │ foot · .tiny
└────────────────────────────────────────────────────────┘
```

Hierarchy, top down:

1. **Head** — `WORKSHOP` in `.section-label` weight, feed age chip on the
   right, then the collapse chevron `›`. Feed age is the one number a glance
   needs before trusting anything else. Tone: `ok` under 2 min (matches
   `WORKSHOP_FEED_FRESH_MS`), `warn` past it, `mute` when off.
2. **Module head** — one per pack that is On. Pack name in 12px 590 weight,
   `On · rail` as `.row-meta`, a fold caret. Folding a module keeps its head
   and hides its cards. Fold state is view-local; it is never journaled.
3. **Cards** — the six locked cards, in the locked order. `.workshop-card`
   hairline-top, `.section-label` heading, 8px/10px padding.
4. **Foot** — `Detach` as `.tiny`. It moves out of the head so the head has
   one job (glance + collapse). Detach opens the breakout; nothing else.

### Box card

The ring replaces the full-width bar and the `GPU %` meter row that
duplicated it. One number, one gauge, left column. Right column is three kv
rows. The card is 64px tall at rest.

Ring: SVG, 48px, `stroke-width: 3`, track `var(--line)`, arc `var(--accent)`,
`stroke-linecap: round`, `stroke-dasharray` from the snapshot percent. No
gradient, no red zone. The number is 15px 650 tabular with a 9px `%` under.
Unknown: track only, `—` centered.

Watts rounds to an integer for paint (`Math.round`). The snapshot is not
changed; the title carries the raw value.

Writer paints a 6px dot before the word: `var(--ok)` for `one`, `var(--warn)`
for `no`, `var(--text-tertiary)` for `—`.

### Models card

Heading `MODELS`; when a list is loaded the heading reads `MODELS · 2`. States
in §4.

### Infer card

One chip per tile, order `healthz`, `readyz`, `v1/models`, text `path · status`.
If any tile carries `detail`, one `.row-meta` under the row: `readyz · http-502`.

### Router card

Four kv rows. Drop the 1px `.workshop-track` between label and value inside the
rail: the track forces a single line and clips `nvidia-spark-train-infer`.
Value column is `1fr`, right-aligned, `overflow-wrap: anywhere`. The
`labels only, never route/lease/start/stop` line stays. It is the read-only
law stated where the labels are.

### Job card

Heading `JOB · Bloom soak` — name in the heading, not a row. Two rows:
`Status`, `latest.json`. `latest.json` paints the **basename** (per `RAIL.md`)
with the full path in `title`. Today's rail paints the full path and clips it.

### Feed card

One `.row-meta`: `present · 19s ago` or the host note verbatim (`Feed not
present. Every meter is —. This desk does not remote-install.`).

## 3. Two packs On

Modules stack in pack order: Box monitor, then Job log. Between modules a
full-width hairline plus 8px, so the break reads heavier than a card break
without a second color. Each module folds on its own. When both are folded,
the rail is head + two module heads + foot, about 120px tall.

The Job log card is a `<pre class="workshop-log">` at 11px `var(--mono)`,
`max-height: 160px`, `overflow: auto`. Newest line at the bottom; the builder
scrolls it to the end on each poll unless the user has scrolled up.

## 4. Models states

| Snapshot | Heading | Chip | Line |
| --- | --- | --- | --- |
| No metrics, or feed off | `MODELS` | — | `—` |
| `models` is a list | `MODELS · n` | one `.workshop-chip` per id | — |
| Train exclusive (qwen parked, or one writer with `/v1/models` down) | `MODELS` | `train exclusive` (mute) | `infer down / train exclusive · http-502` — detail only when the tile has one |
| Local Compute enabled with `allowedCapabilities: []` | `MODELS` | — | `Local Compute host has no allowed capabilities` |

Train exclusive is expected during the Bloom soak. The chip is `mute`, not
`warn`. The rail does not moralize a soak that is doing what it should.

Collapsed rail paints the same line, clamped to three lines with the full
text in `title`. Empty and unknown states paint `—` in the same slot so the
strip never reflows.

## 5. Token notes

Reuse, do not add:

| Need | Use | Not |
| --- | --- | --- |
| Hairlines | `var(--line)` | `var(--hairline, …)` — `--hairline` is not in `tokens.css`; every fallback grey today is the same colour in all three themes |
| Rail background | `var(--bg-sidebar)` | a new surface colour |
| Card heading | `.section-label` | new heading class |
| Meta lines, feed age, `On · rail` | `.row-meta` | new tiny text class |
| Buttons (expand, collapse, fold, Detach) | `.tiny` | `.primary`, `.ghost` |
| Ring arc, GPU emphasis | `var(--accent)` | the `#fc561e` literal fallback |
| Chip `ok` / `warn` | `var(--ok)` / `var(--warn)` | `#3d9a5f` / `#c48a1a` literals now in `.workshop-chip-ok/-warn` |
| Numbers | `font-variant-numeric: tabular-nums` | monospace |
| Log tail | `var(--mono)` | `font: inherit` |
| Motion | `160ms var(--ease)` on width | anything else animated |

Light: `--line` at 8% black reads as a hairline on `#f5f5f7`; the accent arc
is `#0071e3`. Dark: `--line` at 8% white on `rgba(44,44,46)`; arc `#0a84ff`.
Workhorse theme: hairline is the violet 16%, arc is sunset `#fc561e`. All
three come free once the `--hairline` fallbacks are replaced with `--line`.

New classes the builder may add, all under the `workshop-` prefix:
`workshop-rail-ring`, `workshop-rail-foot`, `workshop-module`,
`workshop-module-head`, `workshop-kv`. Nothing outside `app.css`.

Card headings stay literal text nodes `Models`, `Router`, `Job`, `Infer`,
`Box`, `Feed` inside `.section-label`; uppercase is the class, not the copy.
`test/workshop-never.test.ts` pins `section-label">Models` and
`section-label">Router` in `WorkshopRail.tsx`. A count or job name follows
the word (`Models · 2`, `Job · Bloom soak`) so the pin holds.

## 6. Never check

| Never | Rail |
| --- | --- |
| New Settings tab | None. Settings → Skills → Workshop stays install/grant. |
| Leftover ring, Usage, Watch fold-in | None. No token counts, no plan slot, no notice. |
| Start / stop / SSH / route / lease | No control paints one. Router card is labels + the read-only line. |
| Vendor | No vendor name, no brain picker. Grok Bot and ACP Grok do not appear. |
| Second NVIDIA Dashboard | One ring, no gradient gauge, no GB/GiB toggle, no chart area. |
| Invented history | No sparkline; no time series store. Ring and dot are the current snapshot. |
| Pack On/Off from the rail | Not in v1. The lock puts Off in Settings → Skills. A later rail toggle is a `RAIL.md` change first. |

Controls that exist: expand, collapse, fold a module, Detach. All four are
view-only.

## 7. Notes against the attached screenshots

`rail-expanded.png` (desk, Settings behind, rail at ~230px):

- **Head** — `Collapse` and `Detach` side by side as equal pills. Two actions
  of different weight; feed age is nowhere near. → Head becomes glance +
  chevron; Detach goes to the foot.
- **Box** — `GPU % 96` row, then a full-width bar that says `96%` again. Same
  number twice, 30px spent. → One ring, three kv rows beside it.
- **Watts 65.73** — two decimals at a glance. → `66 W`; raw in title.
- **Models** — `Loaded infer down / train exclusive · http-502` on one meter
  row with a 1px track; it wraps under the track. → Own line, no track, chip
  for the state word.
- **Infer** — chips are right. Keep. Replace literal greens/ambers with
  tokens.
- **Router** — `nvidia-spark-train-infer` sits hard against the right edge.
  → `1fr` value column, `overflow-wrap: anywhere`, no track.
- **Job this pack watches** — heading is a sentence; `latest.json` paints a
  `/home/go7-dgx-spark/workload…` path clipped mid-word. → `JOB · Bloom soak`,
  basename only.
- **Feed** — last card, `feed · 19s ago`. The freshness stamp is the last
  thing the eye reaches. → Also in the head.
- **Colour** — every hairline is the same neutral grey in light and dark
  because `--hairline` is undefined. → `--line`.

`rail-collapsed.png` (52px strip, from the current branch):

- Rotated `Workshop` toggle takes 70px of height for a word. → Horizontal
  `WORKSHOP ‹` at 10px fits in 76px.
- Models one-liner at 9px in 52px is not readable; it is an ellipsis.
  → 76px, 10px, three-line clamp.
- No feed age. → 9px `.row-meta` at the foot.
- Numbers are centred text with no gauge; the strip reads as a list, not a
  widget. → Ring for GPU, dot for writer.

DGX Dashboard reference: what to keep is *dense now-status in one glance*
and *one dominant gauge per card*. What not to keep: green-to-red arcs,
the blue chart blocks, GB/GiB toggles, the welcome header. The rail is a
Workhorse widget: hairlines, tabular numbers, present-tense words, one
accent.

## Success

Glance without Settings: collapsed 76px shows GPU, watts, writer, models,
feed age. Expand for detail: 296px, six cards, module heads. Multi-module
ready: packs stack and fold. Still clearly Workhorse read-only soak: no
control on the rail changes anything on the Spark.
