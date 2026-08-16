# Goal: Private adaptive learning

Make Workhorse learn from repeated human direction and verified agent outcomes without mixing vendors, leaking secrets, creating provider-chat clutter, or making hidden behavior unauditable.

This goal is a product capability, not a model-specific memory feature. It must work the same way in packaged Windows and macOS builds.

## Decision

The design is compatible with Windows and macOS if the learning database is owned by Electron main, stored below Workhorse `userData`, and reached through typed IPC. It must not depend on a shell, a background daemon, a home-directory convention, or a native npm SQLite addon.

Workhorse 0.1.6 uses Electron 43.4.0. Its bundled Node runtime exposes `node:sqlite`; a local runtime probe returned Node 24.18.1, SQLite 3.53.1, and a working FTS5 table. Use a `MemoryStore` interface around `node:sqlite` so the release-candidate API remains replaceable. Probe the same functions in every packaged artifact before enabling Learning.

Store the database at:

```text
path.join(app.getPath("userData"), "learning", "learning.sqlite")
```

Never put it in a linked project, vendor session folder, roaming chat folder, or repository.

## Product contract

Learning has two isolated memory classes:

| Class | Learns | May retrieve into |
|---|---|---|
| Human intent | Preferences, constraints, corrections, recurring goals, accepted decisions | The same user and project, or global user scope when explicitly promoted |
| Agent operations | Which skills, tools, models, efforts, routes, and workflows produced verified outcomes | The same provider by default; normalized aggregate metrics may inform routing across providers |

Raw vendor transcripts are not a shared memory pool. Cross-provider retrieval must never expose another vendor's hidden prompts, reasoning, session content, or tool output.

Learning is evidence, not authority. Current user instructions, permissions, project state, and system rules always win. Retrieved text is quoted as untrusted context and cannot grant tools, change permissions, select a project, or complete a plan step.

## What Workhorse records

Capture Workhorse-owned events at existing boundaries:

- Human prompts and explicit edits, redacted before persistence.
- Project, session, plan step, worker role, provider, model, and reasoning effort identifiers.
- Routing candidates, selected route, constraints, capacity inputs, user overrides, and the final rationale.
- Skills and tools selected by identifier, plus bounded result metadata.
- Duration, token usage, cost when available, cancellation, interruption, retry, and terminal status.
- User acceptance, correction, rejection, or replacement.
- Verified outcomes such as passing tests, inspected artifacts, committed changes, or adapter-confirmed completion.

Do not record credentials, environment values, keychain content, raw tool stdout, full file bodies, chain-of-thought, or provider-private context. Store hashes and bounded summaries for artifacts. Raw attachments remain referenced by Workhorse attachment IDs and are not copied into the learning database.

Agent-generated claims and plan evidence do not count as success by themselves. Success needs at least one independent signal: user acceptance, a deterministic test, an artifact check, or an adapter-reported terminal result.

## Storage model

Use schema-versioned migrations and these logical records:

### `learning_events`

Append-only, redacted observations.

- Stable event ID, timestamp, local-day key, event kind, and schema version.
- User, project, session, plan step, agent run, and correlation scopes when present.
- Actor class, provider, model, effort, skill IDs, and tool IDs.
- Bounded JSON payload, redaction version, sensitivity label, and source hash.
- Tombstone and purge state.

### `memory_items`

Compiled statements that are safe to retrieve.

- Memory class, scope, provider scope, statement, and structured tags.
- Source event IDs, compiler run ID, confidence, and verification state.
- Created, last confirmed, superseded, expires, and deleted timestamps.
- Contradiction and supersession links.
- Status: proposed, approved, active, superseded, or deleted.

### `compiler_runs`

Restart-safe work records.

- Input window and event watermark.
- Selected provider, model, effort, and selection rationale.
- Status, attempt, start/end time, token/cost totals, and error class.
- Output memory IDs and a deterministic input hash.

### `retrieval_audit`

An inspectable record of what memory affected a turn.

- Query scope, candidate IDs, selected IDs, exclusions, scores, and token budget.
- No copied prompt or secret content.

FTS5 indexes only active compiled statements and approved redacted prompt summaries. If FTS5 is unavailable, Learning stays healthy in capture mode and uses a bounded lexical fallback; it must not crash chat startup.

## Persistence and process ownership

1. Open one database connection in Electron main after `pinUserData()` and before renderer hydration.
2. Serialize all writes through one `LearningService`; renderers and provider hosts use typed IPC events.
3. Enable WAL only on the local `userData` database, set a bounded busy timeout, and use transactions for every event batch and compiler promotion.
4. Checkpoint and close on normal quit. On crash, reopen, run integrity and migration checks, then resume compiler work from the last committed watermark.
5. Never assume Workhorse remains open overnight. Compile during idle time and catch up on next launch.
6. Pause new compiler work during shutdown, update installation, database export, permanent purge, or migration.
7. Keep database operations small and bounded on Electron main. Move the store behind the same interface to a utility process only if measured latency requires it.

Windows-specific file locks must be covered: close the connection before restore or purge, retry bounded replace operations, and never leave a half-renamed database. macOS sleep, App Nap, and folder-consent behavior must not affect the database because it is not stored in a project folder.

## Daily compiler

The compiler turns eligible events into one optional Learning Brief with two sections: `Intent` and `Operations`.

It runs when all are true:

- Learning is not Off.
- There are uncompiled eligible events or corrected source events.
- The app is idle or catching up after launch.
- A connected provider satisfies the user's compiler policy.
- The provider can run without creating a visible Workhorse chat or durable vendor-thread clutter.

Thresholds, quiet periods, and context budgets are policy values, not hard-coded model rules. A day with ten prompts is an example, not a trigger baked into code.

The compiler receives redacted events, existing in-scope memories, and a strict output schema. It proposes additions, confirmations, contradictions, and supersessions. It cannot change routes, skills, permissions, or settings directly.

MVP compiler selection is a user-selected connected model and effort. Later, optional intelligent selection may use capability, task risk, measured quality, cost, latency, and Watch capacity. Never route by a fixed model-name table. The selection record must explain the candidates, the chosen model and effort, and every exclusion.

Provider adapters must declare an ephemeral auxiliary-call capability. If a provider cannot guarantee an ephemeral or automatically cleaned-up call, it is ineligible for automatic compilation. Learning must skip safely instead of creating Codex, Cursor, Claude, Grok, or custom-provider chat pollution.

## Retrieval

Start with inspectable, on-demand retrieval. Automatic retrieval remains feature-gated until the eval baseline passes.

1. Build a scoped query from the current project, goal, plan step, task class, selected provider, and skill/tool needs.
2. Retrieve human intent from the project and approved global user scopes.
3. Retrieve agent operations only from the selected provider's scope.
4. Rank by scope match, recency, repeated confirmation, verified outcome, and lexical relevance.
5. Apply contradiction, deletion, sensitivity, and expiration filters.
6. Enforce item and token caps before prompt composition.
7. Show the selected memory IDs in the turn details and write a retrieval audit.

The prompt section must be clearly marked as historical, fallible context. A remembered preference cannot override an explicit current request. A remembered tool result cannot be treated as current machine state.

## Settings and copy

Learning stays in Settings. Do not add a top-level sidebar destination.

Use short labels only:

- `Learning` — `Off`, `Capture`, `Review`, `Automatic`
- `Compiler model`
- `Learning brief`
- `Sources`
- `Export`
- `Forget`

`Review` requires approval before proposed memories become active. `Automatic` promotes only statements that pass policy and evidence gates. Destructive purge needs a clear target and confirmation.

Each active memory shows one statement, scope, source count, last confirmed date, and status. Detailed provenance belongs in a disclosure, not inline copy.

## Privacy, deletion, and portability

- Learning defaults to Off for existing installations and is explained during opt-in.
- Capture scope is selectable per project; sensitive projects can remain Off.
- Export is UTF-8 JSONL plus readable Markdown, with stable IDs and LF-normalized content.
- `Forget` first tombstones source events and invalidates every derived memory.
- Permanent purge closes the store, rewrites or rebuilds it without the target records, removes WAL/SHM remnants, reopens it, and verifies absence.
- Backups obey the same deletion and retention policy.
- Credential storage remains in the existing credential service; no keys enter learning events or exports.
- Workhorse does not sync memory between installations. OS-managed profile backup or roaming follows the user's platform policy; document it and support an administrator-selected local store path.

## Implementation plan

### Phase 0 — freeze the contract

- Add the event, memory, compiler, retrieval, and policy types under `src/lib`.
- Add a `MemoryStore` interface and pure redaction, scope, promotion, invalidation, and ranking functions.
- Define event producers at the store, plan, agent-run, routing, usage, and provider terminal boundaries.
- Add a compatibility probe for `node:sqlite`, FTS5, writable `userData`, schema version, and database integrity.

Done when the types compile, the compatibility probe is deterministic in tests, and no provider call or UI change is required.

### Phase 1 — local event ledger

- Implement the Electron-main SQLite store, migrations, WAL lifecycle, transactions, and typed IPC.
- Capture redacted human, routing, execution, correction, outcome, and usage events.
- Add size limits, retention policy, deduplication, and idempotent event IDs.
- Add export, tombstone, rebuild, purge, and recovery paths.

Done when a crash/restart preserves committed events, a duplicate IPC delivery does not duplicate an event, and permanent purge removes sources and derived records.

### Phase 2 — learning brief

- Implement restart-safe compiler jobs using event watermarks and deterministic input hashes.
- Add one schema-validated brief with separate Intent and Operations sections.
- Add Review approval and Automatic evidence gates.
- Add ephemeral auxiliary-call capability to provider contracts; do not reuse sidebar sessions.
- Record compiler provider, model, effort, usage, rationale, and terminal state.

Done when interrupted compilation resumes once, produces no duplicate memories, and creates no visible Workhorse or vendor chat thread.

### Phase 3 — retrieval and audit

- Add scoped FTS5 retrieval and the bounded lexical fallback.
- Add provider isolation, contradiction/supersession filters, hard item/token limits, and untrusted-context framing.
- Add retrieval details to existing turn metadata.
- Keep automatic injection behind a feature flag.

Done when every injected statement has visible provenance and a deleted, contradicted, wrong-project, or wrong-provider item cannot be injected.

### Phase 4 — Learning settings

- Add the four modes, compiler selection, brief review, source inspection, export, and forget controls.
- Keep every description to one sentence and every action label short.
- Add keyboard and screen-reader coverage for review and destructive confirmation.

Done when a user can understand, disable, inspect, approve, export, and erase Learning without opening a terminal.

### Phase 5 — intelligent routing feedback

- Aggregate only normalized, verified outcome metrics across providers.
- Add task class, model, effort, skill/tool set, quality, duration, cost, and capacity features to routing evidence.
- Let policy score candidates; do not hard-code Kimi, Grok, Codex, Claude, Cursor, MiniMax, or a reasoning level to a task.
- Respect explicit user assignments before learned recommendations.
- Show why a model and effort were selected.

Done when the same task can choose a different valid route as capacity, user policy, or verified history changes, while replaying the same inputs remains deterministic.

### Phase 6 — skill recommendations

- Recommend existing skills from verified outcomes.
- Require approval before creating or editing a skill.
- Preserve full required skill context; never silently shrink a required skill to meet a prompt budget.
- When context is too large, reduce unrelated memory first, choose a larger-context route, or block with a clear reason.

Done when Learning can suggest a relevant historical skill, but cannot silently mutate or truncate it.

## Eval-kit additions

Add a `learning-memory` area with deterministic fixtures and zero-call checks before live model tests.

| Scenario | Required result |
|---|---|
| Windows/macOS path parity | Database uses injected `userData`; no home path or separator assumption |
| Packaged runtime | `node:sqlite`, FTS5 or fallback, writable store, migrations, and integrity probe pass |
| Restart recovery | Committed events survive; an interrupted compiler resumes once |
| Windows locked files | Export, restore, and purge close the DB and recover from bounded replace failures |
| macOS sleep/resume | Idle compiler does not duplicate or lose a run |
| Provider isolation | Raw or summarized vendor-private content never crosses provider scope |
| Project isolation | Another project's intent is not retrieved without an approved global scope |
| Prompt injection | A stored instruction cannot grant tools, change permissions, or override the current request |
| Secret redaction | Keys, tokens, environment values, and keychain text are absent from DB and export fixtures |
| Evidence gate | Agent claims alone do not mark an outcome successful |
| Correction and contradiction | New correction supersedes the old memory and both remain auditable |
| Forget and purge | Source, FTS entry, derived memory, retrieval result, WAL/SHM residue, and backup are removed |
| Retrieval quality | Relevant approved memory wins within a fixed item/token cap |
| Memory Off | No event, compiler call, retrieval, or routing influence occurs |
| No chat pollution | Compiler creates no Workhorse chat, Codex thread, Cursor session, or other durable vendor chat |
| Adaptive selection | Model and effort follow policy inputs and explicit override, not name-based rules |
| Usage-aware selection | Optional capacity inputs alter the score without bypassing quality and risk floors |
| Skill integrity | Required skill content is preserved or the run blocks; it is never silently truncated |
| Bounded `/goal` | A finite review goal terminates, times out, or cancels with a durable terminal state |

Run pure storage and policy fixtures on Windows and macOS CI. Run one packaged smoke on each OS that opens the app, records an event, restarts, compiles with a stub provider, retrieves it, exports it, purges it, and verifies the packaged artifact rather than only the process exit code.

Live-provider evals come last and remain minimal: one ephemeral compiler call per supported provider capability, with assertions for no visible session pollution and correct usage attribution.

## Release gates

Learning cannot default to Automatic until all are true:

1. Windows x64 and macOS Apple silicon packaged smokes pass.
2. Capture adds no measurable chat-send regression at the agreed budget.
3. No secret or raw tool-output fixture reaches the database or export.
4. Provider and project isolation tests pass.
5. Forget and permanent purge pass with the app restarted.
6. Memory-off evaluation is no worse than baseline, and memory-on improves predefined intent adherence or operational efficiency without increasing critical errors.
7. Retrieval provenance and model/effort routing rationale are visible.
8. The compiler leaves no Workhorse or provider-chat clutter.

Roll out in order: internal Capture, internal Review, opt-in Review, opt-in Automatic. Keep a kill switch that returns the system to Off without affecting normal chats.

## Deferred until the baseline is green

- Embeddings or a vector database.
- Cross-device sync.
- Training or fine-tuning exports.
- Shared raw memories across vendors.
- Automatic skill mutation.
- Fully automatic Watch-aware compiler routing.
- Multiple daily reports or a new Learning sidebar.
- Background compilation while Workhorse is closed.

## Review record

Grok 4.6 at high effort and Grok Build at medium effort reviewed the earlier proposal through Workhorse. Both agreed with the local event ledger, intent/operations split, SQLite plus FTS5, evidence-based outcomes, export/forget controls, and memory-off eval. Their objections are incorporated here: no wholesale transcript duplication, no raw tool stdout, vendor-scoped operational memory, real purge semantics, launch-time catch-up, one brief instead of three reports, Settings-only UI, and delayed automatic routing and skill evolution.

The native `/goal` review did not terminate in a bounded time and was cancelled; the bounded ordinary calls completed. That behavior is now an explicit eval and product requirement rather than evidence that the learning design itself failed.

## References

- Electron app data paths: <https://www.electronjs.org/docs/latest/api/app>
- Electron 43 runtime: <https://www.electronjs.org/blog/electron-43-0>
- Node SQLite API: <https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html>
- Electron native module ABI warning: <https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules/>
- SQLite WAL: <https://sqlite.org/wal.html>
- Karpathy's compiled LLM Wiki pattern: <https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f>
- Hermes Agent memory design: <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md>
