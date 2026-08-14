# Plan: Workhorse outer-shell slice 1 (Grok ACP client + first surfaces)

Paste this file as the plan / goal for a **new implementer agent**. Do not re-research harnesses. Do not implement Claude or Codex adapters.

## Goal kind
implementation

## Objective
Ship the first **outer-shell** slice from `docs/harness-gap-analysis.md` against the **already-live Grok** adapter so the documented adapter contract is real: start in a folder, prompt, stream, permission, **resume**, `recordUsage`.

Workhorse stays an outer shell. Grok remains the inner harness. Do not reimplement skills, hooks, MCP hosting, memory, or sandbox kernels.

## Acceptance criteria
1. **Vendor session resume (G1).** Each Grok Workhorse session stores the ACP `sessionId` returned by `session/new` or `session/load`. After the child process is gone (restart, dispose), the next prompt on that chat calls ACP `session/load` with that id + cwd + mcpServers, then `session/prompt`. `session/new` is only for a brand-new chat or when load fails (then persist the new id). Changing model, effort, permission mode, sandbox, or cwd still starts a new vendor session (existing launch-key behavior) and replaces the stored id.
2. **Plan mode (G2).** `PermissionMode` includes `plan`. `/plan` is in `src/lib/commands.ts` and sets the active chat to plan. Launch/session params put Grok into its documented plan/read-only path (`~/.grok/docs/user-guide/19-plan-mode.md`, `22-permissions-and-safety.md`, `15-agent-mode.md`). Do **not** inject a fake user message `/plan` into the transcript.
3. **Sandbox profile (G3).** A Grok session (or last-used Grok default) has `sandbox: "off" | "workspace" | "read-only" | "strict"` (default `off`). `buildGrokLaunchSpec` adds `--sandbox <profile>` when not `off`. Keep `--no-leader`. `/sandbox` or Settings can set it. Approvals stay the existing Allow once / session / Deny bar.
4. **MCP passthrough (G5).** Settings store a list of MCP server descriptors (`name`, `command`, `args`, optional `env`). `session/new` and `session/load` receive them as `mcpServers`. Default remains `[]`. Workhorse does not speak MCP itself.
5. **Grok login detection (G12).** Settings → LLMs → Grok `connected` is computed in Electron (binary on PATH or `~/.grok/bin/grok.exe`, plus evidence of an existing Grok login/config on this machine). The manual “Use local login” toggle no longer *invents* a Grok connection. Claude and Codex stay `connected: false` and preview-echo only.
6. **Extra folders, references, client capabilities (G14, G21).** All linked project folders and references (file/url/note) reach the agent. Prefer ACP fields if Grok initialize/session params document them; otherwise a single system/context preface on the first prompt of a vendor session. `initializeParams.clientCapabilities` is no longer `{}` — it lists only capabilities Workhorse actually implements after this slice (permission prompts, session load). Do not claim terminal, fs, or edit capabilities the renderer does not handle.
7. **Thought surface (G20).** ACP thought updates render as a distinct message kind (collapsed/secondary), not merged into the assistant answer when message text exists. If there is no message text, keep today’s fallback so the user still sees something.
8. **Docs stay honest.** `README.md` / `GOAL.md` / `AGENTS.md` still describe Claude/Codex as adapters-next. Update `GOAL.md` out-of-scope line only if this slice lands (Grok resume/plan/sandbox/MCP/detection are now in scope; Claude/Codex still are not). Point at `docs/GOAL-outer-shell-slice-1.md`.

## Verification plan
1. `gating`: Extend `test/workhorse.test.ts` (or a sibling under `test/` imported by `npm test`) so `buildGrokLaunchSpec` is asserted for: default (no `--sandbox`), each sandbox profile (`--sandbox workspace|read-only|strict` + `--no-leader`), `always-approve` still adds `--always-approve` + `yoloMode`, `accept-edits` still sets `autoMode`, `plan` sets the documented plan signal and does **not** set `yoloMode`. Drive the **shipped** `buildGrokLaunchSpec` — do not reimplement argv in the test.
2. `gating`: Extract or test the real resume decision: given a stored vendor `sessionId` and a dead slot, `GrokAgent` / `GrokSessionHost` issues `session/load` then `session/prompt`; missing/failed load issues `session/new` and stores the new id. Use a fake stdio ACP child or a test double **injected into the shipped class**, not a copy of the protocol. Cover “new chat → session/new” and “same chat after dispose → session/load”.
3. `gating`: Tests for `normalizeSession` / persist: `vendorSessionId` and `sandbox` survive `hydrate` / `normalizeSession` in `src/lib/store.tsx` (or the module that owns them). `/plan` and `/sandbox` appear in `COMMANDS` and `filterCommands`. Claude/Codex `send()` still contains `Preview only` and does not call `grokPrompt`.
4. `gating`: A pure function `detectGrokLogin` (or equivalent in `electron/`) is unit-tested with temp dirs / env: missing binary → not connected; binary + login artifact → connected. Do not mark Claude/Codex connected. `npm test` passes.
5. `evidence`: Write `{SCRATCH}/slice1-test-output.txt` with the full `npm test` output. If a live `grok` binary exists, an optional one-shot `session/load` smoke may be recorded, but **must not** be required to pass the goal (CI/agents may lack login).

## Non-goals
- Claude, Codex, or custom **live** ACP adapters (follow-on goal).
- Implementing a skills runtime, hooks engine, MCP server host, memory store, or OS sandbox.
- Cloud backends, worktrees, share links, schedulers, `/review`, child-session UI, plugin marketplaces.
- Redesigning the Apple-like UI or adding extra frameworks.
- Merging subscriptions, context, or sandboxes across vendors (`AGENTS.md`).
- Pretending Claude/Codex are signed in.

## Assumed scope
- Product: `C:\Users\lgovo\Projects\Go7-Workhorse`.
- Prior analysis (read, do not rewrite as the deliverable): `docs/harness-gap-analysis.md` gaps **G1, G2, G3, G5, G12, G14, G20, G21**.
- Inner-harness reference: `C:\Users\lgovo\.grok\docs\user-guide\` especially `15-agent-mode.md` (`session/new` / `session/load`), `17-sessions.md` (stdio session management), `18-sandbox.md`, `19-plan-mode.md`, `22-permissions-and-safety.md`, `07-mcp-servers.md`.
- Adapter contract already named in `README.md`: start in a folder, prompt, stream, permission, resume, `recordUsage`.
- Keep Electron main as the only process that talks to `grok`. Renderer stays IPC-only (`AGENTS.md`).

## Implementation notes (lock these so you do not ask)
- Persist `vendorSessionId` on `Session` in `src/lib/types.ts` and include it in `normalizeSession`.
- `GrokSessionHost.ensureAgent` should `session/load` when `vendorSessionId` is set and launch key matches; otherwise `session/new`. Stream the resolved id back so the renderer can save it (new IPC event or prompt result field).
- ACP `session/load` shape (Grok docs): `{ sessionId, cwd, mcpServers }`.
- Map modes in `electron/grok-launch.ts` only — not in React. Plan must use Grok’s documented `_meta` / permission field after you read the user-guide; if ACP has no plan flag, set it on `session/new` `_meta` consistently with `yoloMode` / `autoMode` and record the exact field in a short comment.
- MCP list lives in `Settings` (LLMs or a small subsection). Schema stays serializable in `workhorse-state.json`.
- Extra folders: cwd remains `folders[0]` (or `process.cwd()`). Remaining folders + references are context, not a second cwd.
- Thoughts: reuse `onThought` already collected in `electron/grok-agent.ts`; add a `kind: "thought"` (or similar) chat row in `src/lib/grok-events.ts` + store event handler.
- Tests must import shipped functions from `electron/` and `src/lib/`. No hard-coded expected argv strings that ignore the implementation.

## Task checklist
- [x] Read `docs/harness-gap-analysis.md` (G1–G3, G5, G12, G14, G20, G21), `GOAL.md`, `AGENTS.md`, `electron/grok-agent.ts`, `electron/grok-host.ts`, `electron/grok-launch.ts`, `src/lib/store.tsx`, `src/lib/types.ts`, `src/lib/commands.ts`.
- [x] Add types + persist `vendorSessionId`, `sandbox`; implement `session/load` resume path.
- [x] Add `plan` mode + `/plan`; map into Grok launch/session params.
- [x] Add sandbox profile + `--sandbox` in `buildGrokLaunchSpec`; `/sandbox` or Settings control.
- [x] Pass Settings MCP list through `session/new` and `session/load`.
- [x] Detect Grok login in Electron; stop inventing Grok connected via the stub toggle.
- [x] Extra folders/references + honest `clientCapabilities`.
- [x] Render thought updates as a distinct row.
- [x] Update `docs/GOAL-outer-shell-slice-1.md` check-off / `GOAL.md` out-of-scope line if needed; keep Claude/Codex as stubs in README.
- [x] Tests in `test/` driving shipped functions; `npm test` green; save output to `{SCRATCH}/slice1-test-output.txt`.

## Deviations

## Follow-on (do not start)
**Codex ACP adapter** — same contract as Grok (folder, prompt, stream, permission, resume, `recordUsage`). See [docs/agent-goal-codex-acp-adapter.md](agent-goal-codex-acp-adapter.md). Claude remains a later slice.
