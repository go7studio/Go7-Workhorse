# Go7 Workhorse eval kit

This is the Workhorse-specific descendant of the reusable SessionBoard/SaaS
evaluation kit. It preserves weighted areas, scripted journeys, per-item
evidence, cannot-judge versus real failure, manual follow-up, and a coverage
floor, but changes the subject from a browser SaaS clone to a native
multi-provider agent shell.

The baseline is now activated. The first full v0.1.4 run used MiniMax-M3 for
the live evaluation lane; the v0.1.5 repair run adds one bounded adapter smoke
call for each installed stock harness. See `FINDINGS-v0.1.4.md` for the initial
findings and the ignored run directories for complete evidence.

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

Routing adds a third chain: task tier → input capability → capacity state →
selected model → runtime identity → usage. Attachments add kind → persisted
metadata → provider representation → model-visible evidence.

The seven profiles remain in the compatibility contract. MiniMax-M3 through
MiniMax's OpenAI-compatible endpoint is the primary evaluator and the only
model used for internal tool calling or cascading agents. A provider's
existing API or OAuth subscription may receive one explicitly bounded smoke
call when needed to prove that adapter; smoke-call exceptions cannot cascade.
Production acceptance runs may select stronger task-appropriate models, but
their model, reasoning effort, capacity decision, and user override must be
recorded.

Catalog names and model caches are discovery hints, not runtime proof. The
required provenance chain is selection → launch/request → runtime observation
→ transcript → usage.

## Free commands

    npm run eval:validate
    npm run eval:list
    npm run verify
    npm run eval:media-fixtures
    npm run eval:fixture-check
    npm run eval:plan-fixture-check
    npm run eval:device-probes -- --fixture eval/fixtures/device-capabilities.json
    npm run eval:capability-smoke

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
- every routing/media source boundary in eval/capability-contract.json exists
  and every CAP rubric item is mapped;
- every observed regression maps to valid profiles, scenarios, rubrics,
  source boundaries, and verification commands;
- config profiles, native-command profiles, and provider profiles agree;
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
7. **Orchestration lane:** import and approve the plan, then test routing,
   concurrency, peer correlation, restart, and resume.
8. **Capability lane:** test Watch fallback, Kimi visual work, media, Godot,
   adb/Saga, and iOS simulator readiness.
9. **Packaged/install lane:** compare source, package, and running build.
10. **Manual evidence:** credentials, support-report redaction, OS install/update,
   and anything automation could not prove.
11. **Score and defect ledger:** retain exact reproductions separately from
   rubric verdicts.

## Spend and safety fences

- Live execution remains blocked by the baseline-only mode and zero-spend
  default until an evaluator explicitly activates the run.
- The example config enforces MiniMax-M3 for the main eval, internal tool
  calling, and all child-agent cascades.
- Existing provider/API or OAuth profiles may be enabled for a minimal adapter
  smoke call with a per-profile ceiling; those calls cannot spawn children.
- Cascades use MiniMax-M3, low effort, depth two, two root children, a
  10,000-token worker ceiling, and a 5,000-token helper ceiling.
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
- capability-contract.json — model routing, capacity, attachments, and CAP coverage.
- execution-plan-contract.json — plan import, approval, routing, and resume rules.
- device-capability-contract.json — read-only Godot, adb, and iOS probes.
- regression-contract.json — durable coverage for observed production defects.
- config.example.json — no-secret run configuration.
- schemas/ — evidence and results interchange formats.
- BASELINE.md — source baseline and activation boundary.
- FINDINGS-v0.1.4.md — durable findings from the first full run.
- scripts/workhorse-eval.mjs — validation, inventory, run initialization,
  and evidence scoring.
