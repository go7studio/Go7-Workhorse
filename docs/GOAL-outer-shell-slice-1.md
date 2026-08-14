# Goal: Workhorse outer-shell slice 1

Make the **already-wired Grok adapter** a real ACP client, and surface the first outer-shell controls from `docs/harness-gap-analysis.md`. Do **not** implement Claude or Codex live adapters in this slice.

This slice is implemented in the Grok adapter. Done when all of the following are true:

1. A Workhorse Grok chat persists the vendor ACP `sessionId` and **reloads** it with `session/load` after the child process is gone (app restart, dispose). `session/new` is only for a new chat or when load fails.
2. Permission modes are `ask` | `accept-edits` | `always-approve` | **`plan`**. `/plan` exists. Plan maps into Grok’s existing plan/read-only mechanism (not a fake user message).
3. The shell can set a Grok sandbox profile (`off` | `workspace` | `read-only` | `strict`) and `electron/grok-launch.ts` passes `--sandbox` when it is not `off`.
4. Settings can list MCP servers; those entries are passed as `sessionParams.mcpServers` on `session/new` and `session/load`. Workhorse does not host MCP itself.
5. Settings → LLMs → Grok `connected` is **detected** from this machine (binary + existing Grok login), not a manual toggle. Claude and Codex stay honest stubs (`connected: false` unless you later add adapters).
6. Extra linked folders and project references reach the agent (ACP extra roots if the protocol supports them; otherwise first-prompt context). `initialize` `clientCapabilities` declares only what Workhorse actually handles.
7. Thought/reasoning ACP updates render as a distinct, secondary row — not as the only assistant reply when real message text exists.

Out of scope: Claude / Codex / custom live adapters, skills/hooks runtimes, plugin marketplaces, cloud backends, worktrees, share links, schedulers, child-session UI.

Read `docs/harness-gap-analysis.md` (gaps G1, G2, G3, G5, G12, G14, G20, G21) and `docs/agent-goal-outer-shell-slice-1.md` before changing code.
