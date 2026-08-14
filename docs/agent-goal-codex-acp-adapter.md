# Plan: Codex ACP adapter (GPT tools + usage)

Paste this file as the plan / goal for a **new implementer agent**. Do not re-research harnesses. Do not implement Claude or Custom HTTP. Do not redesign the shell.

## Goal kind
implementation

## Objective
Ship a **live Codex ACP adapter** so the existing Codex / GPT-5.4 composer slot behaves like Grok: vendor process, tools, permission bar, resume, and honest `recordUsage`.

Workhorse stays an outer shell. Codex remains the inner harness (model loop, file/shell tools, sandbox kernel). Workhorse does not call `api.openai.com` and does not execute tools itself.

## Why this shape
Grok is already: `store.send()` → IPC → `GrokSessionHost` → `grok agent … stdio` → ACP events → tool rows / permission bar / `recordUsage`.

Codex is still: `store.send()` preview echo (`Preview only. Codex would answer…`). Settings can toggle “Use local login” without a binary. Usage never sees `provider: "codex"`.

GPT in this product **is** the Codex slot (`src/lib/models.ts`: `gpt-5.4`, `codex`). A Custom base-URL + API key path would not get tools or MCP. Do not build that here.

## Acceptance criteria
1. **Live Codex path.** `session.provider === "codex"` in `src/lib/store.tsx` `send()` calls a Codex IPC prompt (`window.workhorse.codexPrompt` or equivalent). It must **not** call `grokPrompt` and must **not** fall through to the preview echo. Missing binary / ACP child failure surfaces as an honest assistant error on that chat (`Codex agent failed: …`), never as `Preview only`.
2. **Same adapter contract as Grok.** Electron main is the only process that spawns the vendor. Renderer stays IPC-only (`AGENTS.md`). Contract: start in folder (`folders[0]` or `process.cwd()`), `session/prompt`, stream, `session/request_permission` → existing Allow once / session / Deny bar, `session/load` resume after dispose/restart, cancel, optional compact/rewind if Codex ACP exposes them (if not, skip those IPC methods and document why in a one-line comment — do not fake them).
3. **Spawn Codex ACP, not `grok`.** Launch lives in new files (`electron/codex-launch.ts`, `electron/codex-host.ts`, `electron/codex-login.ts`, thin `electron/codex-agent.ts` only if the Grok ACP client cannot be reused). Detect the command in this order: `CODEX_ACP_BIN` (must exist), then `codex-acp` / `codex-acp.cmd` on PATH, then a `codex` binary that is documented to speak ACP stdio. **Do not** download packages at runtime. **Do not** spawn `grok`. Record the chosen argv builder as `buildCodexLaunchSpec` (mirror `buildGrokLaunchSpec`).
4. **Model + effort mapping.** Composer ids stay `gpt-5.4` and `codex` (`MODEL_CATALOG.codex`). Map them onto Codex ACP’s documented model flags in `buildCodexLaunchSpec` and leave a short comment with the exact flag names you used. Map Workhorse effort `low|medium|high|xhigh` onto Codex’s documented reasoning/effort flag. Unknown / missing flag → omit it; do not invent `--reasoning-effort` if Codex does not take it.
5. **Sandbox + permission modes.** Reuse `Session.sandbox` and `Session.mode`. Map Workhorse `off|workspace|read-only|strict` onto Codex’s documented sandbox (`read-only` / `workspace-write` / `danger-full-access` or equivalent). Map `ask|accept-edits|always-approve|plan` onto Codex ACP session meta / flags. Approvals stay the existing permission bar — do not add a second inbox.
6. **Tool calling + MCP passthrough.** Codex’s own tools run inside the child. Settings `mcpServers` plus the built-in Workhorse MCP (`workhorseMcpServer()` from `electron/grok-launch.ts`) are passed on `session/new` and `session/load`, same as Grok. Do not host MCP in Workhorse. Tool `session/update` events must render through the existing tool-row path (`upsertToolMessage` / `kind: "tool"`). Permission asks must set `provider: "codex"` on `PermissionRequest`.
7. **Resume.** Persist `vendorSessionId` (already on `Session`). After the Codex child is gone, the next prompt on that chat `session/load`s then `session/prompt`. `session/new` only for a new chat or failed load. Changing model, effort, mode, sandbox, cwd, or MCP list still starts a new vendor session (same launch-key idea as Grok) and replaces the stored id.
8. **Login detection (G12 for Codex).** Settings → LLMs → Codex `connected` is computed in Electron: binary found **and** a Codex login artifact (typical: `~/.codex/auth.json`, plus `CODEX_API_KEY` / `OPENAI_API_KEY` if present). Injected fs/env like `detectGrokLogin`. The Settings button becomes **Recheck**, not “Use local login”. Claude stays a stub toggle / `connected: false`. Grok detection is untouched.
9. **Usage (same pane, honest tokens).** Codex usage events call `recordUsage` with `provider: "codex"` and the session’s `model` / `projectId` / `sessionId`. Reuse `parseGrokUsage` (or extract a shared `parseAcpUsage` used by both adapters) **and** `finalizeTurnUsage`. Must handle Grok-style `cachedReadTokens` inclusive turn totals so Codex cannot regress the double-count bug (inclusive prompt + exclusive last request summed; output counted twice). Do **not** invent tokens for Claude/Custom preview. Do **not** write Codex events as `provider: "grok"`. Usage pane already rolls up by provider — Codex should light up when events exist. A Codex weekly-credit ring is **not** required (Grok’s SuperGrok ring stays Grok-only).
10. **Preface + thoughts.** Extra folders and project references use the same `buildVendorPreface` / first-prompt preface as Grok. ACP thought updates use the existing thought row. `initialize` `clientCapabilities` lists only what Workhorse implements (`sessionLoad`, `permissionPrompts`) — do not claim terminal/fs/edit.
11. **Docs stay honest.** Update `README.md`, `GOAL.md`, `AGENTS.md`, and `src/lib/providers.ts` so Codex is “adapter ready / uses your existing Codex login,” Claude and Custom remain stubs. Point at `docs/GOAL-codex-acp-adapter.md`. Do not claim Custom HTTP works.

## Verification plan (faults first)
Write tests in `test/workhorse.test.ts` (or a sibling imported by `npm test`). Drive **shipped** functions. No argv strings that ignore the implementation.

1. `gating` **No cross-talk.** Codex `send()` does not call `grokPrompt`. Grok `send()` still only uses `grokPrompt`. Claude and Custom `send()` still contain `Preview only` and do not call `codexPrompt` or `grokPrompt`. A helper that chooses the vendor bridge is unit-tested if you extract one.
2. `gating` **Launch spec.** `buildCodexLaunchSpec` is asserted for: default spawn command resolution (env override wins; missing env falls back to detected binary name), each sandbox mapping, each permission mode, model id `gpt-5.4` and `codex`, MCP list includes user servers + Workhorse MCP when the env for Workhorse MCP is set, and **never** contains `grok` as the command.
3. `gating` **Resume.** Fake stdio ACP child (same style as Grok host tests) injected into the shipped Codex host: new chat → `session/new` then `session/prompt`; same chat after dispose → `session/load` then `session/prompt`; failed load → `session/new` and new id stored. Launch-key change (model/effort/sandbox/cwd) → `session/new`, not load.
4. `gating` **Login.** `detectCodexLogin` with temp dirs / env: missing binary → not connected; binary without auth → not connected; binary + `~/.codex/auth.json` → connected; `CODEX_API_KEY` counts as artifact. Does not mark Claude or Grok.
5. `gating` **Usage faults.**
   - `parseAcpUsage` / shared parser: Codex/Grok `turn_completed` with `inputTokens: 527934`, `cachedReadTokens: 461440` → billed input `66494`, cache `461440`, output unchanged.
   - Exclusive snapshot `input_tokens` + `cache_read_input_tokens` is **not** subtracted.
   - `finalizeTurnUsage` on last-request exclusive + inclusive turn total → **one** copy, not the sum (594428 / 10404 style must not reappear).
   - `normalizeUsage` still repairs the stored double-count shape (`repairInflatedTurn`).
   - Preview / Claude / Custom paths never push usage events (no `recordUsage` in that branch).
   - A Codex usage event hydrates as `provider: "codex"` and appears in `byProvider` / `rollup`.
6. `gating` **Permissions + tools.** Permission option mapping still works when the request is tagged `provider: "codex"`. A classified ACP `tool_call` / `tool_call_update` still produces a tool row (reuse existing extractors if the payload is ACP). Do not require a live Codex binary for this.
7. `gating` **Honesty on failure.** If launch spec cannot resolve a binary, the host/store path yields an error result (or throws a message the store already renders as `Codex agent failed:`). It must not silently preview.
8. `gating` **Grok regression.** Existing Grok launch, login, resume, and usage tests stay green. `npm test` passes.
9. `evidence`: Write `{SCRATCH}/codex-adapter-test-output.txt` with the full `npm test` output. If a live `codex-acp` / `codex` binary **and** login exist, you may record one optional smoke (new chat, one prompt, one usage event with `provider: "codex"`). Smoke is **not** required to pass the goal.

## Non-goals
- Claude live ACP adapter (follow-on).
- Custom OpenAI-compatible HTTP, Chat Completions, or a Workhorse-owned function-call loop.
- Calling `api.openai.com` from Electron.
- Codex cloud, scheduled tasks, git worktrees, `/review`, image-only composer work (G15) unless Codex ACP prompt already accepts image blocks the composer already sends — do not build a new image pipeline.
- Skills / hooks runtimes, MCP server host, memory store, OS sandbox kernel.
- SuperGrok-style weekly credit ring for ChatGPT / Codex.
- Redesigning the UI, extra frameworks, merging vendor context or subscriptions.
- Pretending Claude is signed in.

## Assumed scope
- Product: `C:\Users\lgovo\Projects\Go7-Workhorse`.
- Copy Grok’s shape, do not rewrite it: `electron/grok-launch.ts`, `electron/grok-host.ts`, `electron/grok-agent.ts`, `electron/grok-login.ts`, `electron/main.ts`, `electron/preload.ts`, `src/lib/store.tsx` `send()`, `src/lib/usage.ts` (`parse` lives in `electron/grok-agent.ts`; merge/repair in `usage.ts`), `src/ui/Settings.tsx`.
- Prior analysis: `docs/harness-gap-analysis.md` **G13** (this product gap) and **G12** (login detection). Slice 1 already shipped Grok resume/plan/sandbox/MCP.
- Adapter contract in `README.md`: start in a folder, prompt, stream, permission, resume, `recordUsage`.
- Codex ACP reference: https://github.com/agentclientprotocol/codex-acp (stdio ACP in front of Codex App Server). Confirm flags against that repo / Codex CLI docs before locking argv. If the installed Codex binary already speaks ACP stdio without the shim, prefer that and note it in `buildCodexLaunchSpec`.

## Implementation notes (lock these so you do not ask)
- **IPC names:** add parallel `codex:*` handlers (`codex:prompt`, `codex:event`, `codex:cancel`, `codex:answer-permission`, `codex:detect-login`, plus compact/rewind/session-info **only** if implemented). Do not rename the working `grok:*` channel.
- **Share the event apply path.** Extract the `onGrokEvent` handler in `store.tsx` so Codex events reuse chunk / thought / tool / permission / usage / done / error. Do not duplicate the 200-line switch. Usage pending must stay **per session id** (already a map) so a Grok chat and a Codex chat cannot merge tokens.
- **Reuse ACP parsing.** Prefer importing `classifyAcpUpdate`, `parseGrokUsage`, `consumeAcpMessages`, permission option picker from `electron/grok-agent.ts` (rename to `acp-*.ts` only if the import graph stays small). Do not copy-paste a second parser that forgets `cachedReadTokens`.
- **Host class.** `CodexSessionHost` can wrap a shared ACP agent or clone `GrokSessionHost` with `buildCodexLaunchSpec`. Inject `spawn` for tests. One slot per Workhorse `sessionId`, same as Grok.
- **Workhorse MCP.** Reuse `workhorseMcpServer()` / `mergeMcpServers()`. Codex chats should see `workhorse_list_chats` / `workhorse_read_chat` / `workhorse_ask_chat` when the bridge env is set. Session rules string can stay the Workhorse one or a Codex-neutral restatement — do not tell Codex it is Grok.
- **Settings copy.** Codex row: Recheck + “Detected the local Codex login” / “Codex ACP binary or login not found.” Remove inventing `setLlmConnected("codex", …)` as the way to connect. Claude toggle may remain as a stub.
- **Usage budgets.** Optional `usageBudgets.codex` is already in `normalizeUsageBudgets`. No UI work required unless a one-line default is trivial.
- **Provider catalog.** `src/lib/providers.ts` Codex: tagline “Codex CLI via ACP”, statusNote that the adapter uses the existing Codex login. `connected` in the static catalog stays `false`; runtime Settings overlay uses detection.
- **store.send() images.** Grok already passes images if present. If Codex ACP prompt content allows image blocks, pass the same `buildAcpPrompt` payload. If not, send text only and drop images with a short comment — do not fail the slice on images.
- **Tests import shipped modules** from `electron/` and `src/lib/`.

## Faults you must prove cannot happen
| Fault | How the test catches it |
|---|---|
| Codex chat secretly runs Grok | Launch spec command ≠ `grok`; send() branch does not call `grokPrompt` |
| Codex chat silently previews | send() for `codex` has no `Preview only`; missing binary → error string |
| Claude/Custom start looking live | Those branches still `Preview only`; no Codex/Grok IPC |
| Usage attributed to Grok | Events stored with `provider: "codex"` |
| Inclusive + exclusive summed (2.9M bug) | Shared parser + `finalizeTurnUsage` cases above |
| Preview invents tokens | No `recordUsage` on preview path |
| Fake Codex connected | Detection unit tests; Settings Recheck |
| MCP dropped | Launch/session params include Settings list + Workhorse MCP |
| Resume always `session/new` | Host fake-child tests |
| Permission bar broken for Codex | Request `provider: "codex"` still maps Allow/Deny |
| Grok regresses | Existing Grok tests green |

## Task checklist
- [x] Read this file, `docs/GOAL-codex-acp-adapter.md`, `AGENTS.md`, `GOAL.md`, Grok adapter files listed above, `src/lib/store.tsx` `send()`, `src/lib/usage.ts`, `src/ui/Settings.tsx`.
- [x] Confirm Codex ACP binary/flags from `codex-acp` / local `codex` help; lock them in `buildCodexLaunchSpec`.
- [x] Add `detectCodexLogin`, `buildCodexLaunchSpec`, Codex host/agent, main + preload IPC.
- [x] Route `provider === "codex"` in `send()`; share the event apply + usage pending path.
- [x] Pass MCP + Workhorse MCP; map sandbox/mode/effort/model.
- [x] Detect Codex login in Settings; stop inventing connected via toggle.
- [x] `recordUsage({ provider: "codex", … })` through the shared parser/finalize path.
- [x] Update README / GOAL / AGENTS / providers so Codex is live, Claude/Custom are not.
- [x] Fault tests listed above; `npm test` green; save output to `{SCRATCH}/codex-adapter-test-output.txt`.

## Deviations
- Official `codex` CLI on this machine is App Server / MCP, not ACP stdio. Spawn is `CODEX_ACP_BIN` / `codex-acp`; `CODEX_PATH` points at the installed Codex CLI. Model/effort/sandbox/approval go in `CODEX_CONFIG` + session `_meta`, not Grok-style argv.
- No Codex compact/rewind/session-info/fork IPC — those stay Grok-only (`_x.ai/*`); editing a Codex turn clears `vendorSessionId` instead of faking rewind.
- `codexLaunchKey` now includes mode, approvalPolicy, agentMode, INITIAL_AGENT_MODE, and CODEX_CONFIG so ask→plan/always-approve/accept-edits starts a new vendor session (argv is empty so those were previously dropped).

## Follow-on (do not start)
**Claude ACP adapter** — same contract, separate goal. **Custom HTTP** — only if someone explicitly wants a no-tools completions fallback; it is not a substitute for this slice.
