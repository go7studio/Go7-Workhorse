# Plan: Codex live spawn (Grok-parity)

Paste this file as the plan / goal for a **new implementer agent**. The first Codex slice (`docs/agent-goal-codex-acp-adapter.md`) shipped the IPC skeleton. It does **not** chat. Do not re-research harnesses from scratch. Do not implement Claude or Custom HTTP. Do not redesign the shell.

## Goal kind
implementation

## Objective
A Codex / GPT chat in Go7 Workhorse must work like a Grok chat: Electron main spawns a vendor ACP process, the renderer only talks IPC, tools stay in the vendor, the permission bar works, resume works, and `recordUsage` records Codex tokens.

Today the user sees **`Codex agent failed: spawn EINVAL`**. That is the first fault. Shipping more Settings or picker UI without a live child fails this goal.

## Why it is broken (do not rediscover this)

Measured on this machine, 2026-08-13:

| Fact | Value |
|---|---|
| Product | `C:\Users\lgovo\Projects\Go7-Workhorse` |
| Grok (works) | `C:\Users\lgovo\.grok\bin\grok.exe` via `grok agent --no-leader … --model … --reasoning-effort … stdio` |
| Desktop Codex (installed, **not ACP**) | `C:\Users\lgovo\AppData\Local\OpenAI\Codex\bin\8e8bf206e63ac436\codex.exe` (`codex-cli 0.147.0-alpha.6.6`) |
| Login | `C:\Users\lgovo\.codex\auth.json` exists |
| Model cache | `C:\Users\lgovo\.codex\models_cache.json` — listed: `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini` |
| `CODEX_ACP_BIN` | unset |
| `codex-acp` on PATH | **missing** |
| `where.exe codex` | **missing** (desktop exe is not on PATH) |

What the current code does:

1. Settings `detectCodexLogin` is **On** because desktop `codex.exe` + `auth.json` exist (`electron/codex-login.ts`).
2. Chat spawn uses `resolveCodexAcpCommand` → fallback **`"codex-acp.cmd"`** when nothing is on PATH (`electron/codex-launch.ts`).
3. `spawnCodexProcess` only `existsSync`-checks **absolute** paths. A bare `codex-acp.cmd` skips that check (`electron/codex-host.ts`).
4. `child_process.spawn("codex-acp.cmd", [], { stdio: "pipe", windowsHide: true })` **without `shell: true`** is invalid on Windows (Node throws **`EINVAL`** for `.cmd` / missing command). That string is what the chat shows.

Official `codex.exe` help has **no `acp` subcommand**. It has:

- `app-server --stdio` — Codex App Server protocol (VS Code). **Not ACP.**
- `mcp-server` — MCP. **Not** the chat protocol.
- `exec` — one-shot, no Workhorse permission bar / ACP stream.

Do **not** spawn desktop `codex.exe` as if it were ACP. Do **not** use `codex exec` or `codex mcp-server` as a fake Grok replacement.

## Locked launch path

Speak **ACP stdio**, same as Grok, so `GrokAgent` / `classifyAcpUpdate` / `parseAcpUsage` stay shared.

The ACP child is **`@agentclientprotocol/codex-acp`** (`codex-acp`). It starts Codex App Server internally and translates to ACP. Zed archived `zed-industries/codex-acp` — use the new package.

**Resolve the ACP command in this order. Every candidate must be a real file.**

1. `CODEX_ACP_BIN` if the path exists.
2. `codex-acp.exe` on PATH or under a Workhorse-owned bin dir.
3. The **node entry** of a local install: `process.execPath` (or a found `node.exe`) + the package’s `bin` script from `node_modules/@agentclientprotocol/codex-acp`. Prefer adding that package as a **project dependency** (or a pinned vendor copy) so Electron does not need a global install.
4. If none exist, you may **install or vendor** `@agentclientprotocol/codex-acp` as part of this slice (npm dependency, or a Windows release binary copied into e.g. `%LOCALAPPDATA%\Go7 Workhorse\bin\codex-acp.exe`). That is required. The previous goal forbade runtime downloads and then shipped a phantom command — do not repeat that.

**Then set `CODEX_PATH`** to the detected desktop / PATH / `~/.codex/bin` `codex.exe` so the adapter uses this machine’s login (`~\.codex\auth.json`), not a second anonymous CLI.

**Windows spawn rules (gating):**

- Never spawn a bare `codex-acp.cmd` / `npx.cmd` / `npm.cmd` with `spawn` and no shell. That is the EINVAL bug.
- Never fall back to a command name that is not on disk.
- Prefer `.exe` or `node.exe` + `.js`. If you must run a `.cmd`, use `cmd.exe` `/d` `/s` `/c` with a quoted line — last resort only.
- Missing ACP → throw a clear error: `Codex ACP is not installed. …` **before** `spawn`. The chat must never show raw `spawn EINVAL`.
- Do not `spawn("grok")` on the Codex path.

Keep model / effort / sandbox / approval in `CODEX_CONFIG` + session `_meta` + `INITIAL_AGENT_MODE` (already in `buildCodexLaunchSpec`). Pass live slugs through (`gpt-5.6-sol`, etc.). Default model is `gpt-5.6-sol`.

Documented adapter env (from the package README): `CODEX_PATH`, `CODEX_CONFIG`, `INITIAL_AGENT_MODE`, `CODEX_API_KEY` / `OPENAI_API_KEY`, `NO_BROWSER=1` in this desktop spawn so it does not pop a browser.

## Acceptance criteria

1. **Live child.** `session.provider === "codex"` → `codexPrompt` → a running ACP stdio process. One user prompt returns streamed assistant text (or a real Codex/ACP protocol error, not `EINVAL` / not `Preview only`).
2. **Same contract as Grok.** Start in `folders[0]` or `process.cwd()`. `initialize` → `session/new` or `session/load` → `session/prompt`. Stream chunks, thoughts, tool rows. `session/request_permission` → existing Allow once / session / Deny. Cancel. Persist `vendorSessionId`. After dispose, next prompt `session/load`s. Launch-key change (model / effort / mode / sandbox / cwd / MCP) → new session.
3. **Tools + MCP.** Codex’s own file/shell tools run in the child. Settings `mcpServers` + `workhorseMcpServer()` are on `session/new` and `session/load`. Workhorse does not host tools.
4. **Usage.** `recordUsage` with `provider: "codex"`, shared `parseAcpUsage` + `finalizeTurnUsage`. No inclusive+exclusive double-count. No fake tokens. No `provider: "grok"` on Codex events.
5. **Honest Settings.** Codex `connected` requires **spawnable ACP command on disk** **and** a login artifact (`~\.codex\auth.json` or `CODEX_API_KEY` / `OPENAI_API_KEY`). Desktop `codex.exe` without ACP is **Off**, with copy that says the ACP adapter is missing. Recheck stays. Claude stays a stub.
6. **Models.** Keep `listVendorModels` / `~\.codex\models_cache.json`. Picker stays Sol-first. Launch the chosen slug. Hidden cache rows (`visibility: hide`) stay hidden.
7. **Parity extras (only if ACP exposes them).** Codex ACP advertises `/compact` (and review slash commands). If `session/compact` or an available command works, wire compact IPC like Grok. Rewind / fork / session-info: implement only if the adapter documents them; otherwise keep the current “clear `vendorSessionId` / Grok-only” comments. Do not fake them.
8. **Docs honest.** `README.md`, `GOAL.md`, `AGENTS.md`, `src/lib/providers.ts` say Codex is live **only after** the smoke below passes. Until then they must not claim it. Point at this file and `docs/GOAL-codex-live.md`.

## Verification plan (faults first)

Write tests in `test/codex-adapter.test.ts` (or a sibling imported by `npm test`). Drive shipped functions.

1. `gating` **No phantom command.** `resolveCodexAcpCommand` / `buildCodexLaunchSpec` never returns `codex-acp.cmd` or `codex-acp` unless that path `existsSync`. Missing ACP → structured “not installed” error. `spawnCodexProcess` on a missing/invalid Windows cmd must not be the user-visible path.
2. `gating` **Windows spawn.** Unit-test the spawn argv: `.exe` or `node` + script; `CODEX_PATH` set to a detected `codex.exe` when present; `command` is never `grok`. Injected fs/env like `detectCodexLogin`.
3. `gating` **Settings honesty.** Desktop `codex.exe` + auth, **no** ACP file → `connected: false`. ACP file + auth → `connected: true`. ACP file, no auth → `connected: false`. Does not mark Grok/Claude.
4. `gating` **No cross-talk.** Codex `send()` still only `codexPrompt`. Grok still only `grokPrompt`. Claude/Custom still `Preview only`.
5. `gating` **Launch spec.** Sandbox / mode / effort / live model slug / MCP + Workhorse MCP still mapped. `codexLaunchKey` still includes mode / approval / agentMode / `CODEX_CONFIG`.
6. `gating` **Resume + permissions + usage.** Existing fake-stdio host tests stay green (new/load/fail/launch-key, `parseAcpUsage`, `finalizeTurnUsage`, permission option ids).
7. `gating` **Grok regression.** Existing Grok tests stay green. `npm test` twice, both exit 0.
8. `gating` **Live smoke (required on this machine).** With the user’s desktop `codex.exe` + `auth.json`, spawn the resolved ACP child, `initialize`, `session/new` in `C:\Users\lgovo\Projects\Go7-Workhorse`, one short `session/prompt` (e.g. “Reply with the single word pong.”). Pass if you get assistant text **or** a parsed ACP error from Codex (auth/quota). Fail if spawn throws `EINVAL` / `ENOENT` / the child never speaks JSON-RPC. Write the transcript to `{SCRATCH}/codex-live-smoke.txt`.
9. `evidence`: `{SCRATCH}/codex-live-test-output.txt` = full `npm test` output from both runs. Note the resolved ACP command and `CODEX_PATH` in that file.

Optional UI check: after smoke, one Codex chat in the running app streams a reply and a Usage row with `provider: "codex"`. Not required if headless smoke is solid.

## Non-goals

- Claude live ACP, Custom HTTP, Chat Completions, `api.openai.com` from Electron.
- Treating desktop `codex.exe app-server` as the Workhorse chat protocol **unless** the ACP package cannot be made to spawn after the locked resolve order — if you take App Server, you must write a new client (not `GrokAgent`) and still hit every acceptance criterion. Prefer ACP.
- Codex cloud, worktrees, `/review` UI, image pipeline work beyond passing existing composer image blocks if ACP accepts them.
- SuperGrok-style weekly ring for ChatGPT.
- Redesigning the UI. Inventing a login toggle. Downloading packages on **every prompt**.

## Assumed scope

- Copy Grok’s shape; do not rewrite it: `electron/grok-agent.ts`, `electron/grok-host.ts`, `electron/grok-launch.ts`, `electron/main.ts`, `electron/preload.ts`, `src/lib/store.tsx` `send()`, `src/lib/usage.ts`.
- Change: `electron/codex-login.ts`, `electron/codex-launch.ts`, `electron/codex-host.ts`, Settings copy, tests.
- Prior: `docs/agent-goal-codex-acp-adapter.md` (skeleton, still useful), `docs/GOAL-codex-acp-adapter.md`, this file.
- Model discovery already shipped (`electron/vendor-models.ts`). Do not revert Sol-first.

## Implementation notes (lock these so you do not ask)

- Keep IPC names `codex:*`. Do not rename `grok:*`.
- Reuse `GrokAgent` for the ACP session. Inject spawn.
- `NO_BROWSER=1` on the Codex child.
- If you add the npm package, resolve its bin with `createRequire` / `import.meta` — do not assume `npx` works inside Electron.
- Hash folder under `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe` can change on update — keep the existing desktop scan.
- Compact/rewind IPC: only if you prove the method exists; otherwise leave the one-line “Codex ACP has no Workhorse-wired …” comments.
- User-visible error strings go through `vendorFailedMessage` (`Codex agent failed: …`). Make the inner message actionable (`Codex ACP is not installed` / protocol error), never `spawn EINVAL`.

## Faults you must prove cannot happen

| Fault | How the test / smoke catches it |
|---|---|
| `spawn EINVAL` from `codex-acp.cmd` | Resolve never returns a non-file; smoke spawn succeeds |
| Desktop `codex.exe` spawned as ACP | Launch spec command is the ACP adapter; `CODEX_PATH` is the CLI |
| Settings On while chat cannot start | `connected` requires ACP file + auth |
| Codex chat runs Grok | command ≠ grok; send() branch |
| Codex chat previews | no `Preview only` on `codex` |
| Usage on Grok / double-count | existing usage tests + `provider: "codex"` |
| Claude looks live | still `Preview only` |
| Grok regresses | existing Grok tests |

## Task checklist

- [x] Read this file, the first Codex goal (for context only), Grok spawn (`resolveGrokBinary` + `spawnGrokProcess`), current `codex-login` / `codex-launch` / `codex-host`, `store.tsx` `send()`.
- [x] Confirm `@agentclientprotocol/codex-acp` install or a Windows `codex-acp.exe`; lock the resolve order in `resolveCodexAcpCommand`.
- [x] Fix Windows spawn (no phantom `.cmd`, absolute/node entry, `CODEX_PATH`, `NO_BROWSER`).
- [x] Settings `connected` = ACP file + login. Update copy.
- [x] Keep live models; pass Sol (and the rest) through launch.
- [x] Fault tests above; `npm test` twice; required live smoke file.
- [x] Docs honest only after smoke.

## Follow-on (do not start)

**Claude ACP adapter.** **Custom HTTP** only if someone explicitly wants a no-tools fallback.
