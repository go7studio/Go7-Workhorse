# Go7 Workhorse evaluation baseline

**Source frozen for the kit:** 5d02f78e79a688b316aba9d4f6575df909b2a52b
(origin/main, 2026-08-15)

**Package version:** 0.1.4

**Baseline activity:** static source/product-surface walk only; no app launch,
no provider prompt, no direct API request, and no scored eval run.

This describes the pre-run baseline. It was subsequently activated in run
`2026-08-15-v0.1.4-minimax-m3-01`; all live model calls used MiniMax-M3 and
the durable outcome is recorded in `FINDINGS-v0.1.4.md`.

## Product inventory frozen into the suite

- Native Electron shell with persisted projects, chats, permissions, Settings,
  usage, Watch, goals, schedules, terminal, review, skills, and attention
  surfaces.
- Stock ACP profiles: Grok, Codex, Claude.
- Direct HTTP: OpenAI Chat Completions and Anthropic Messages shapes.
- Current custom provider presets: MiniMax, Synthetic, OpenRouter, Groq, and
  DeepSeek. Presets remain hints; an endpoint/model probe is separate proof.
- Five Settings sections: Profile, LLMs, Skills, Usage, Watch.
- Twenty-five core Workhorse commands plus provider-native augmentations.
- Seven Workhorse desk tools for chat discovery, transcript reading, peer
  messaging, child spawning, bot discovery, and skill discovery/reading.
- Canonical portable history and Workhorse fallbacks for cross-provider
  continuity.

## Initial findings

These findings determine what the first full run must target. Except where
explicitly labeled a static gap, they are risks—not runtime verdicts.

### 1. First-run setup is not yet a Getting Started experience

src/ui/Welcome.tsx offers Create a project, Link an existing folder, and
either Start a chat or Connect an agent. It does not inventory recognized
harnesses, explain detected versus authenticated state, introduce both custom
API shapes, or provide a reopenable walkthrough.

Baseline: SET-01 not-found; SET-02 partial.

### 2. Harness discovery exists deeper than the first screen

Electron has distinct Grok/Codex/Claude detection boundaries, Settings renders
stock and custom bots, and the custom catalog has several presets. The later
walk must prove how missing binary, missing login, disabled, detected, and live
states differ. A single connected dot is not enough evidence.

### 3. Model identity needs a five-layer audit

Model caches and fallback catalogs can populate the menu even when runtime
proof is absent. The baseline therefore refuses to infer the actual model from
the selected label or answer style. Every provider must reconcile UI
selection, launch/request, runtime observation, transcript stamp, and usage
bucket. Silent fallback is a failure.

Baseline: MOD-01 through MOD-06 unrun.

### 4. Canonical and provider-native command language are mixed

/goal, /schedule, /plan, /compact, and the security modes are common
Workhorse language. Grok also exposes a large native command set including
/loop; Codex exposes /review and /skills; Claude exposes /skills. The product
must keep canonical semantics portable while using native capabilities only
when discovered. In particular, /schedule every is the portable recurring
primitive; a native /loop is an augmentation.

Baseline: CMD-01 through CMD-06 unrun.

### 5. Title protection exists statically, but runtime retitling must be broken

The title helpers honor titleLocked, and provider changes stamp prior turns.
The live run still needs to send multiple turns, accept any provider-generated
title events, switch models/providers, restart, and prove a manual rename never
changes.

Baseline: PRJ-04 and MOD-06 unrun.

### 6. Capability claims are descriptive contracts, not proof

The registry currently claims native resume for Grok, Codex, and Claude;
native rewind/fork/compact for Grok; and Workhorse fallbacks elsewhere. The
run must observe actual session load, fork/rewind/compact behavior and downgrade
any unsupported installed-harness version rather than trusting the registry.

### 7. Usage presentation has ambiguity worth targeting

The supplied v0.1.2 screenshot shows distinct provider/model rows and plan
rings, but a MiniMax row displays 100% beside 0 in and 0 out. That may mean
plan remaining rather than consumed tokens, yet the visual alone does not say
so. The suite separates context occupancy, subscription remaining, local
budget, and recorded tokens and requires source/time/unit labels.

Baseline: USG-01 through USG-06 unrun.

### 8. Source, tagged version, package, and installed app can diverge

The approved source and package now agree on v0.1.4. The packaged/install lane
must still record commit, artifact hash, package version, platform, and running
version before results are considered valid; the user's prior installed build
may be older than the source target.

Baseline: REL-01 unrun.

### 9. Dependency risk is recorded separately

The fresh dependency install reported two high-severity audit findings. This
baseline does not apply a forced or breaking dependency update. The release
lane records the exact advisory state; product behavior and supply-chain risk
remain separate findings.

### 10. Orchestration exists in source but needs product-level proof

Workhorse already has child sessions, a nested agent transcript pane,
provider/model/effort selection, token and time budgets, shared/worktree
isolation, changed/conflict file records, chat discovery/read/ask tools, a
peer inbox, and persistent /goal state.

The source does not yet prove that two children overlap while the parent stays
responsive, that automatic routing is skill-aware and explainable, or that a
goal continues iterating through evidence-gated completion. The visible
language must also keep four operations distinct: attach prior context,
message an existing chat, resume a child, and spawn a new child.

Cursor 3.16.17 was walked as a reference with a no-repository Multitask goal.
It launched two named read-only children in parallel, displayed child model,
effort, status, stop controls, transcripts, UUID links, and let the parent
synthesize both. Cursor's past-chat references attach context; they do not
deliver a chat-to-chat message. Workhorse's peer inbox can intentionally go
beyond that baseline, but only after real delivery, correlation, runtime
identity, restart, and deduplication are proven.

Baseline: ORC-01 through ORC-09 partial from static source evidence; ORC-10
not-found because explicit nesting depth/concurrency guards and a root-goal
aggregate budget view are not established.

## Activated for the v0.1.4 full run

- Launch and walk the existing/new packaged app.
- Use the user's installed vendor harnesses or approved fresh installs.
- Send direct custom API probes.
- Exercise permissions, sandbox/network/outside-root boundaries.
- Test /goal, schedules, plan, compaction, native loops/workflows, and
  provider switching.
- Reconcile actual model and usage identity.
- Run two or more child agents concurrently, inspect their linked sessions,
  exercise user-assigned and automatic routing, and reconcile child evidence.
- Distinguish prior-context attachment from bidirectional peer messaging;
  verify immutable session addressing, correlation, failure, and restart.
- Drive a /goal orchestrator through progress, child failure, pause/restart,
  resume, evidence-gated completion, blocked, and cancelled terminal states.
- Interrupt/restart sessions and verify journal/state recovery.
- Score any rubric item.

The run starts from the exact v0.1.4 source identity above. The eval branch
adds only the eval kit and an opt-in WORKHORSE_USER_DATA_PATH launch boundary
so the desktop walk cannot touch the user's normal profile. That deviation is
recorded in run provenance and receives its own release finding. Static
existence alone never upgrades an item to pass.
