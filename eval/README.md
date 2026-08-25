# Go7 Workhorse eval kit

This is the Workhorse-specific descendant of the reusable SessionBoard/SaaS
evaluation kit. It preserves weighted areas, scripted journeys, per-item
evidence, cannot-judge versus real failure, manual follow-up, and a coverage
floor, but changes the subject from a browser SaaS clone to a native
multi-provider agent shell.

The kit is current and ready. The example remains baseline-only, zero-spend,
and no-network until an evaluator activates a run. An activated live adapter
smoke is one bounded call per explicitly enabled stock harness.

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

The current worker lane also proves stable names, compatible idle reuse,
explicit interrupted recovery, truthful live activity, and one join per wave.
Ordinary lineup fan-out may use one worker per callable bot; the two-root limit
belongs to the production-plan fixture.

Routing adds a third chain: task tier → input capability → capacity state →
selected model → runtime identity → usage. Attachments add kind → persisted
metadata → provider representation → model-visible evidence.

Manual chats stay pinned until Auto is selected. Settings Routing applies to
unassigned desk work, and explicit spawn assignments win. Usage evidence is
classified as turn, request, gauge, or unknown and is attributed to the actual
worker, connection, and model. Missing counts are never estimated.

Learning adds a fourth chain: visible recent human prompt → redacted stable
event → selected custom compiler bot and its credential → ephemeral brief →
scoped memory. Backfill is limited to one day, is idempotent, and creates no
Workhorse or vendor chat.

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

A direct Qwen 3.8 chat is evaluated on the Custom HTTP path, including a bot
named Spark when configured that way. Its native direct/thinking controls and
Skills-scoped MCP tools must remain exact. A Spark Local Compute machine is a
different execution-host surface under LLMs: it is not a vendor, custom bot, or
Usage ring. The eval keeps those identities, credentials, grants, and accounting
separate. The opt-in Custom HTTP smoke permits exactly two model requests and
never runs during the free/default gate.

## Free commands

    npm run eval:validate
    npm run eval:list
    npm run verify
    npm run eval:media-fixtures
    npm run eval:fixture-check
    npm run eval:plan-fixture-check
    npm run eval:admission-smoke
    npm run eval:device-probes -- --fixture eval/fixtures/device-capabilities.json
    npm run eval:capability-smoke

Opt-in local Spark/Qwen proof (requires explicit environment authorization):

    WORKHORSE_EVAL_LOCAL_MODEL_LIVE=1 \
    WORKHORSE_EVAL_SPARK_BASE_URL=http://127.0.0.1:PORT/v1 \
    WORKHORSE_EVAL_SPARK_API_KEY=... \
    WORKHORSE_EVAL_SPARK_QWEN_MODEL=Qwen/Qwen3.8-27B-FP8 \
    npm run eval:local-model-smoke

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
- Connect Grok Bot output covers Mac and Windows, names its MCP/CLI capability
  requirement without fixing a model, leaves worker routing to Workhorse, and
  keeps weekly usage production LLM-free;
- plan admission runs the shipped checklist, sibling-auditor, receipt, and
  ask-default helpers without a provider call;
- every routing/media source boundary in eval/capability-contract.json exists
  and every CAP rubric item is mapped;
- the local-model contract keeps Qwen Custom HTTP identity and sampling exact,
  MCP tools least-privilege, Spark Local Compute typed and role-granted, and
  both usage boundaries truthful;
- learning-memory commands and every LRN rubric item remain mapped;
- every observed regression maps to valid profiles, scenarios, rubrics,
  source boundaries, and verification commands;
- the large-desk performance contract maps its scale fixtures, rendering and
  persistence boundaries, verification commands, rubric items, and default tests;
- every provider usage profile covers direct and orchestrated calls, token and
  leftover provenance, pool identity, and the Cursor-only estimate exception;
- critical model, security, orchestration, usage, and release rubrics remain
  explicit release blockers;
- the baseline is a full commit and the example version matches package.json;
- config and provider profiles agree; native-command examples stay runtime-discovered;
- the Settings section inventory still matches the product.

This makes adding a core command or Settings section without updating the eval
kit a release-gate failure.

## Initialize a later evidence run

Copy the config and keep secrets in environment variables only:

    cp eval/config.example.json eval/config.json
    npm run eval:init -- --config eval/config.json

Initialization writes an ignored eval/runs/<timestamp>/ evidence plan. It
does not launch Workhorse, call a provider, or spend money. The run binds the
commit, branch, version, and exact worktree fingerprint it was initialized on.

The later evaluator records scenario evidence under that run and fills
results.json. Then:

    npm run eval:score -- --run eval/runs/<timestamp>
    npm run eval:finalize -- --run eval/runs/<timestamp>

Change `mode` to `active`, initialize the run, then start it before collecting
evidence:

    npm run eval:start -- --run eval/runs/<timestamp>

Each judged rubric must cite a generated `evidence/<scenario>.json`. Completed
scenario records need actions, observations, non-empty artifacts, SHA-256
hashes, the appropriate trust tier (`manifest`, `unit`, `source`, or
`packaged-live`), and the regression IDs they exercised. Evidence and artifact
paths cannot leave that run's evidence directory. A baseline-only run cannot
start, produce a certifiable headline, or finalize.

Verdicts are pass, partial, fail, not-found, cannot-judge, and not-run. Only
real judged verdicts enter the score denominator. Cannot-judge and not-run
reduce coverage instead of becoming product failures. The headline score is
withheld below 60% coverage, when any area is thin, or until every recorded
production regression has completed scenario evidence. A critical release
blocker that is anything other than pass also withholds the score.

## Required execution sequence for the full run

1. **Source identity:** fetch the approved ref and record commit/version.
2. **Free gates:** validate the kit, build, run unit/contract tests, and inspect
   the artifact inventory.
3. **Fresh-state desktop walk:** use isolated Electron userData; never mutate
   the user's normal Workhorse state.
4. **Local execution fixtures:** test both custom schemas, Qwen 3.8 reasoning,
   scoped MCP, and Spark's typed asynchronous capability/artifact plane before
   any paid endpoint or live host.
5. **Installed stock harnesses:** enable one profile at a time and collect
   sanitized launch/runtime evidence.
6. **Cross-provider journeys:** goal, schedule, plan, compact, custom history,
   switching, permissions, continuity, usage, learning backfill, and recovery.
7. **Orchestration lane:** import and approve the plan, then test routing,
   naming, reuse, concurrency, peer correlation, interruption, join, auditor
   admission, ask defaults, and resume.
8. **Capability lane:** test Watch fallback, Kimi visual work, media, a granted
   Spark Local Compute job/artifact/continuation, Godot, adb/Saga, and iOS
   simulator readiness.
9. **Performance lane:** load the isolated large-desk fixture, then measure
   project/chat navigation, search, progressive transcript/media/diff paint,
   Orchestrate transcript visibility during worker streaming, compact persistence,
   and restart recovery.
10. **Packaged/install lane:** compare source, package, running build, isolated
   shim ownership, Windows installer/update, macOS installer, and
   architecture-matched macOS update.
11. **Manual evidence:** credentials, support-report redaction, OS install/update,
   and anything automation could not prove.
12. **Score and defect ledger:** retain exact reproductions separately from
   rubric verdicts.

## Spend and safety fences

- Live execution remains blocked by the baseline-only mode and zero-spend
  default until an evaluator explicitly activates the run.
- The example config enforces MiniMax-M3 for the main eval, internal tool
  calling, and all child-agent cascades.
- Existing provider/API or OAuth profiles may be enabled for a minimal adapter
  smoke call with a per-profile ceiling; those calls cannot spawn children.
- Eval cascades use MiniMax-M3, low effort, depth two, a plan-specific two-root
  limit, a 10,000-token worker ceiling, and a 5,000-token helper ceiling.
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
- introduces a new standard user journey;
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
- local-model-contract.json — Qwen identity/reasoning, scoped MCP, Spark Local
  Compute, artifacts, replay, continuations, usage, and bounded-live proof.
- execution-plan-contract.json — plan import, approval, routing, and resume rules.
- device-capability-contract.json — read-only Godot, adb, and iOS probes.
- regression-contract.json — durable coverage for observed production defects.
- performance-contract.json — scale fixtures and rendering, navigation, and
  persistence invariants.
- config.example.json — no-secret run configuration.
- schemas/ — evidence and results interchange formats.
- scripts/workhorse-eval.mjs — validation, inventory, run initialization,
  and evidence scoring.
