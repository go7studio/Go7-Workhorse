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

## Decisions taken at the gate (2026-08-29)

1. **All four slices.**
2. **The gate binds the first wave, not only continuation.** Scout B proved a
   continuation-only gate leaves `workhorse_spawn_agent` free to open an
   ungated opening fan-out — and the opening fan-out is what cost $1,468.
3. **`reportRef` is removed, not resolved.** It names a message id nothing can
   resolve; a footer that points nowhere is worse than no footer. The
   truncation notice must instead name a recovery path that works today
   (`workhorse_read_chat` by worker id).

## Lanes, sequenced by the collision this plan found

Slices 1+2 are one lane: both rewrite the report path in `subagents.ts`.
Slices 3+4 follow: both touch `types.ts` and `store.tsx`, so they cannot run
beside 1+2 or beside each other as separate writers.

| Wave | Slices | Owns | Lane |
|---|---|---|---|
| 1 | typed findings, report bound, remove `reportRef` | `subagents.ts`, `lineup.ts`, `types.ts`, `workhorse-mcp.ts`, `session-bridge.ts` | Codex |
| — | adversarial verify of wave 1 | read-only | Cursor Grok 4.6 |
| 2 | first-wave gate, path allowlists, wire the dead lease | `workhorse-mcp.ts`, `types.ts`, `store.tsx`, `subagents.ts` | Codex |
| — | adversarial verify of wave 2 | read-only | Cursor Grok 4.6 |

## The dogfood

Wave 2 builds the gate. Once it lands, the desk must refuse to continue this
very mission without a human clearing the phase. If our own continuation walks
straight through, the gate does not work — and that failure is the test.

## Wave 1 adversarial verdict (Cursor Grok 4.6, 2026-08-29): DO NOT SHIP

Proved by construction and by mutation, not by reading.

MET: restart round-trip (deleting the `normalizeAgentRun` keep made the test
fail — the pipeline is real, not decorative); `reportRef` removal and the new
footer (live check: `workhorse_read_chat` genuinely returns the full text);
additive-safety (no protocolVersion move needed).

NOT MET, and blocking:

1. **The parser silent-drops realistic model output.** `parseWorkerFindings`
   (`src/lib/subagents.ts:713`) demands four CONSECUTIVE lines, exact labels,
   exact order. Verified failures, all returning `[]`: a blank line between
   FINDING and TITLE, markdown bold, `- ` bullets, TITLE before FINDING,
   `FINDING: high (must fix)`, an extra OWNER line, a `### FINDING` heading.
   `parseAuditorReport` (`plan.ts:272`) — same desk, same four-line idea —
   already uses independent `/^\s*LABEL:\s*…$/im` matches and survives all of
   it. One blank line from a model and the whole feature yields nothing while
   the 4,000-char clip still eats the prose.
2. **It forked the desk after all.** `WorkerFinding` (`types.ts:297`) is a
   third dialect beside `WorkerHandoff` and `AuditorReport`; the join still
   ignores the other two. This is the exact outcome the plan told wave 1 to
   avoid.
3. **One test is mock-echo, not coverage.** Gutting `parseWorkerFindings` to
   return `[]` left `test/workhorse-link.test.ts:950` green: it stubs
   `agent_status` and asserts its own stub.

PARTLY HONEST: the 4,000 prose cap was kept to bound payloads, but findings are
capped only per-row/field — worst case ~36k on `agent_status` and again in the
join, larger than any report it refused to carry.

### Queue, in order (later items are blocked by earlier ones)

1. WAVE 2 lands (gate + path ownership) — in flight, owns `subagents.ts`.
2. FIX-1 parser tolerance: match `parseAuditorReport`'s independent-label
   approach. A `FINDING:` opens a receipt; TITLE/FILE/EVIDENCE attach until the
   next `FINDING:`. Blank lines, extra lines and label order must not drop a
   row; a missing required field still drops that row. Keep the type name so
   wave 2 does not collide.
3. FIX-2 tests that fail when tolerance is removed: blank line between FINDING
   and TITLE, extra OWNER line, `FINDING: high (comment)`, second receipt after
   a blank line. Replace the mock-echo assertion with production-parse coverage.
4. FIX-3 reconcile the dialects, or write down why three is correct.
5. Adversarial verify of wave 2 + the fixes.
6. Push to main, then verify against the installed desk.

## Real-output evidence for FIX-1 (harvested from this desk, 2026-08-29)

445 real terminal worker reports across every vendor on this machine were
scanned for how models actually format labelled structured output:

| Shape | Reports | Current `parseWorkerFindings` |
|---|---|---|
| `- Label:` bullet lines | **82** | silently drops |
| bare `LABEL:` lines | 59 | only if four are consecutive and in order |
| `**BOLD**:` labels | 1 | silently drops |

Real samples, verbatim from worker transcripts:

    Verdict: **PASS** — all four required controls confirmed
    VERDICT: YES — live app on localhost:8080 matches commit 48b65ec.\n\nGit\n- HEAD: ...
    Workers used: 1 — this coordinator.\n\n**VERIFICATION (item 5) — all green**

So: mixed case, markdown inside the value, blank lines inside the block, and
bullet prefixes are all NORMAL output from the models this desk actually runs.
The bullet form is the single most common shape and the parser rejects it.

FIX-1 must be tested against these real shapes, not invented ones. The adversary
already proved the synthetic failures; this proves they are the common case.
