# Campaign: borrow the campaign layer, keep desk-owned join

Source: "Orchestration: Cursor agent vs Go7 Workhorse" (Cursor, conv e9e31861).
Run using the shape the document recommends — scout, review, GATE, build,
adversarial verify — so the process is its own first proof.

## Why (the argument the source document did not make)

Its six recommendations are argued on quality. The strongest case is cost.
A phased gate is a spend brake: a wave that must stop for approval cannot run
thirteen deep agents overnight. On 2026-08-26 an ungated fan-out spent $1,468
in a day, $365 in one hour, against a ~$3,150 weekly plan. Structured reports
are also *bounded* reports. Both items are safety features, not polish.

## Phases

| # | Phase | Parallel? | Gate |
|---|---|---|---|
| 1 | Scout — map the real surfaces | yes, read-only | none |
| 2 | Design + rank | coordinator | **human approval before any mutation** |
| 3 | Build — file-owned slices | yes, allowlisted | tests in-slice |
| 4 | Adversarial verify | Cursor Grok 4.6 | ship / do not ship |

## Scope, ranked (from the source doc + the cost argument)

1. **Structured worker reports + structured join** — typed findings survive the
   join instead of being paraphrased out of a 6,000-char clip.
2. **Phased gates in Mission mode** — scout → review → approve → build, with
   continuation only after the gate clears.
3. **Spawn briefs with file ownership** — path allowlists on the lineup row.
4. **Desk-harden stop-after-spawn** — mechanical, not bible-only.

Deferred unless the scout says otherwise: mission board UI, lightweight wave
events. Both are surface work that depends on 1 and 2 landing first.

## Corrections to the source document

- Join clip is `clipJoinReport(..., limit = 6_000)` in `src/lib/lineup.ts:489`,
  not ~4k.
- "Anti-runaway: hard" was not true when written: `tokenBudget` defaulted to
  undefined, so `exceeded` returned false forever. Fixed 2026-08-27 (`7d437d0`).
- "Join quality — winner: Cursor" names the wrong component. Cursor's join is
  better because its *reviewers returned structured rows*. The defect is the
  worker return shape, upstream of the join.
