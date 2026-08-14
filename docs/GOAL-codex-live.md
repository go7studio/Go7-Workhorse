# Goal: Codex live (same contract as Grok)

Make the **Codex / GPT** slot actually run. The first adapter shipped IPC and Settings detection, but a Codex chat dies with `Codex agent failed: spawn EINVAL`. Grok works because Electron spawns a real `grok.exe` that speaks ACP stdio. Codex must get that same working child.

This is **Codex only**. Do not implement Claude or Custom HTTP.

Done when all of the following are true:

1. A Workhorse chat whose provider is `codex` starts a **real** Codex ACP child on this Windows machine and answers. `spawn EINVAL` is gone.
2. That chat has the same contract as Grok: start in the project folder, stream text / thoughts / tool rows, use the existing permission bar, resume with `session/load`, cancel, and `recordUsage` with `provider: "codex"`.
3. Tools stay in Codex. Settings MCP + the built-in Workhorse MCP are passed through.
4. Settings → LLMs → Codex is **On** only when a spawnable ACP command **and** a Codex login exist. Desktop `codex.exe` alone is not enough.
5. The model picker already reads `~\.codex\models_cache.json` (GPT-5.6-Sol first). Keep that. Launch the selected slug (Sol / Terra / Luna / …).
6. Claude and Custom still echo `Preview only`. Grok’s spawn, login, and usage path stay unchanged.

Out of scope: Claude live adapter, Custom HTTP, `api.openai.com` from Electron, Codex cloud / worktrees, a Workhorse-owned tool runner.

Read `docs/agent-goal-codex-live.md` before changing code.
