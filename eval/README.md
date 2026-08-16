# Go7 Workhorse eval kit

This is the Workhorse-specific descendant of the reusable SessionBoard/SaaS
evaluation kit. It preserves weighted areas, scripted journeys, per-item
evidence, cannot-judge versus real failure, manual follow-up, and a coverage
floor, but changes the subject from a browser SaaS clone to a native
multi-provider agent shell.

The baseline is now activated. The first full v0.1.4 run used MiniMax-M3 for
every live model call; stock harnesses were inspected only through redacted
readiness detection. See `FINDINGS-v0.1.4.md` for durable findings and the
ignored run directory for complete evidence.

## What is different for Workhorse

A URL-only browser walk is not enough. The evaluator must reconcile five
surfaces:

1. what Workhorse displays;
2. what it persists;
3. what Electron launches or sends over HTTP;
4. what the harness/runtime reports back;
5. what the transcript and usage ledger attribute.

Multi-agent work adds a second chain: root goal → parent orchestrator → child
task and immutable session identity → selected skills/tools/runtime → child
evidence → parent synthesis. Reading a prior chat, delivering a peer message,
resuming a child, and spawning a new agent are separate operations.

The five profiles remain in the compatibility contract, but this eval variant
permits live prompts only through custom-openai using MiniMax-M3 and MiniMax's
own OpenAI-compatible endpoint. Grok, Codex, Claude, and custom-anthropic are
static/detection-only unless a future explicitly approved variant changes the
policy. Anthropic's API is prohibited here.

Catalog names and model caches are discovery hints, not runtime proof. The
required provenance chain is selection → launch/request → runtime observation
→ transcript → usage.

## Free commands

    npm run eval:validate
    npm run eval:list
    npm run verify

The validator checks:

- all area weights total 100;
- scenario/rubric/profile references are valid and unique;
- every rubric item has pass criteria and an evidence contract;
- every runtime profile is covered;
- every core command in src/lib/commands.ts appears exactly in
  eval/command-contract.json;
- every orchestration desk tool and source boundary in
  eval/orchestration-contract.json still exists and every ORC rubric item is
  mapped;
- the Settings section inventory still matches the product.

This makes adding a core command or Settings section without updating the eval
kit a release-gate failure.

## Initialize a later evidence run

Copy the config and keep secrets in environment variables only:

    cp eval/config.example.json eval/config.json
    npm run eval:init -- --config eval/config.json

Initialization writes an ignored eval/runs/<timestamp>/ evidence plan. It
does not launch Workhorse, call a provider, or spend money.

The later evaluator records scenario evidence under that run and fills
results.json. Then:

    npm run eval:score -- --run eval/runs/<timestamp>
    npm run eval:finalize -- --run eval/runs/<timestamp>

Verdicts are pass, partial, fail, not-found, cannot-judge, and not-run. Only
real judged verdicts enter the score denominator. Cannot-judge and not-run
reduce coverage instead of becoming product failures. The headline score is
withheld below 60% coverage.

## Required execution sequence for the full run

1. **Source identity:** fetch the approved ref and record commit/version.
2. **Free gates:** validate the kit, build, run unit/contract tests, and inspect
   the artifact inventory.
3. **Fresh-state desktop walk:** use isolated Electron userData; never mutate
   the user's normal Workhorse state.
4. **Local direct-API fixtures:** test both custom schemas against deterministic
   local endpoints before any paid endpoint.
5. **Installed stock harnesses:** enable one profile at a time and collect
   sanitized launch/runtime evidence.
6. **Cross-provider journeys:** goal, schedule, plan, compact, switching,
   permissions, continuity, usage, and recovery.
7. **Orchestration lane:** parallel child agents, skill-aware/user-assigned
   routing, cross-chat read versus message, session links, worktree/conflict
   safety, and goal-owned iteration.
8. **Packaged/install lane:** compare source, package, and running build.
9. **Manual evidence:** credentials, support-report redaction, OS install/update,
   and anything automation could not prove.
10. **Score and defect ledger:** retain exact reproductions separately from
   rubric verdicts.

## Spend and safety fences

- Live execution remains blocked by the baseline-only mode and zero-spend
  default until an evaluator explicitly activates the run.
- The example config enforces MiniMax-M3 as the sole live model and rejects any
  other enabled profile during run initialization.
- Anthropic API calls are prohibited; local Claude readiness detection is not
  a model call.
- liveApiAllowed defaults to false and the approved budget defaults to zero.
- Direct API keys are environment-variable references, never JSON values.
- All file/tool probes stay inside the fixture workspace unless a boundary
  test uses a content-free canary path.
- The existing installation and normal user-data directory are preserved.
- A run against a different commit/version is invalid until explicitly rebased.

## When product features change

The same change must update this kit when it:

- adds or renames a core slash command;
- adds a Settings section or first-run surface;
- changes provider capability claims;
- adds a provider, transport, API schema, or provider-native command;
- changes model/effort selection, title behavior, usage attribution, security,
  persistence, recovery, or packaging;
- introduces a new standard user journey.
- changes subagent, peer-chat, session-link, skill/tool routing, isolation,
  concurrency, budget, or goal-orchestrator behavior.

Add the smallest scenario/rubric delta that proves the behavior. Do not mark
the baseline pass because code exists; only recorded runtime evidence earns a
verdict.

## Files

- suite.json — weighted areas, journeys, and requirements.
- provider-matrix.json — runtime profiles and identity evidence.
- command-contract.json — canonical language and native augmentations.
- orchestration-contract.json — Cursor reference walk, Workhorse desk tools,
  message/spawn semantics, routing rules, lifecycle, and ORC coverage.
- config.example.json — no-secret run configuration.
- schemas/ — evidence and results interchange formats.
- BASELINE.md — source baseline and activation boundary.
- FINDINGS-v0.1.4.md — durable findings from the first full run.
- scripts/workhorse-eval.mjs — validation, inventory, run initialization,
  and evidence scoring.
