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

## Corrections — including to this plan

Scouts A (Codex), B (Opus) and C (Cursor Grok 4.6) read these surfaces
independently. Where they disagreed with this document, they were right.

- **The clip is 4,000, not 6,000, and this plan had it wrong.**
  `WORKER_REPORT_CHAR_LIMIT = 4_000` (`src/lib/subagents.ts:668`) is what
  `boundWorkerReport` applies on the live finish path.
  `clipJoinReport(limit = 6_000)` (`src/lib/lineup.ts:489`) is reached only by
  `lineupJoinFallback`, which has no production caller — dead on the happy
  path. The source document's "~4k" was correct; the earlier "correction" here
  was a grep for a constant without a check for callers. Arithmetic settles it:
  seven observed truncations imply full lengths of 13,008 / 15,771 / 13,555 /
  11,619 / 9,250 / 7,027 / 6,433 — every one exactly `omittedChars + 4,000`.
  Designing typed findings at `clipJoinReport` would have missed both
  `agent_status` and the real join.

- **Prose is NOT the only structured channel.** Zero hits for
  severity/finding in `lineup.ts`/`subagents.ts` is true but misleading.
  `WorkerHandoff` (`types.ts:289`), `parseAuditorReport` (`plan-admission.ts`),
  `workerProgressCheckpoint`, `MissionIteration` and `PlanEvidence`
  (`plan.ts:264-282`) already exist. The defect is that the join and the
  `agent_status` report key do not use them. **A greenfield findings type that
  ignores the auditor receipt and the handoff will fork the desk** — extend,
  do not invent.

- **`reportRef` is a dead API, not an escape hatch.** `setLineupRowStatus`
  (`lineup.ts:156`) never stores it, `read_chat` drops message ids
  (`session-bridge.ts:258`), and no get-message tool exists. The truncation
  footer names an id nothing can resolve. That is precisely the observed
  failure mode: the only way to the full text is `workhorse-state.json`.

- **A continuation gate is not the spend brake this plan claimed.** Gating
  `continue_mission` leaves `workhorse_spawn_agent` free to open an ungated
  first wave of any width — and the first wave is what cost $1,468. Gating
  continuation closes wave two onward, not wave one.

- **"Anti-runaway: hard" was not true when the source document was written:**
  `tokenBudget` defaulted to undefined, so `exceeded` returned false forever.
  Fixed 2026-08-27 (`7d437d0`).

- **"Join quality — winner: Cursor" names the wrong component.** Cursor's join
  is better because its reviewers returned structured rows. The defect is the
  worker return shape, upstream of the join.

- Do **not** reuse `BudgetPhase` for campaign phase (per-worker, meter-driven,
  reset each assignment — spend would read as approval), and do **not** reuse
  `approvePlanRun`: it is reachable by the agent itself through
  `workhorse_plan` with no UI caller, so an agent approves its own plan.

- Scale claim corrected: this tree has six Link hosts and ~17 advertised tools,
  not "~20 MCP bridges".

## The collision this campaign found in itself

The four build slices all touch `src/lib/types.ts` and `src/lib/subagents.ts`.
They cannot run as parallel file-owned lanes — which is the argument for the
allowlist feature, demonstrated by the campaign that proposes it. Slices 1 and
2 are sequenced on one lane; 3 and 4 can follow.
