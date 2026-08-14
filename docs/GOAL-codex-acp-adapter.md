# Goal: Codex ACP adapter (GPT in Workhorse)

Wire the **Codex** slot the same way Grok is wired: Electron main spawns a vendor ACP process, the renderer only talks IPC, tools stay in the vendor, and `recordUsage` records that vendor’s tokens.

This is **Codex only**. Do **not** implement Claude or Custom HTTP in this slice.

Done when all of the following are true:

1. A Workhorse chat whose provider is `codex` talks to a live Codex ACP child (not the preview echo). Picking GPT-5.4 or Codex in the composer runs this path.
2. The adapter implements the same contract as Grok: start in the project folder, send a prompt, stream chunks / thoughts / tool rows, ask the existing permission bar, resume with `session/load`, cancel, and call `recordUsage` with `provider: "codex"`.
3. Tool calling is Codex’s (file/shell plus Settings MCP servers + the built-in Workhorse MCP). Workhorse still does not host MCP or invent tools.
4. Settings → LLMs → Codex `connected` is **detected** from this machine (ACP/Codex binary + existing Codex login). The “Use local login” toggle no longer invents a Codex connection.
5. Usage for Codex appears on the Usage pane (in / out / cache / turns / chats) the same way Grok does. Preview chats still invent no tokens. Inclusive turn totals are not double-counted (see the Grok usage repair).
6. Claude and Custom still echo `Preview only`. Grok’s spawn, login, and usage path are unchanged.

Out of scope: Claude live adapter, Custom OpenAI-compatible HTTP client, Codex cloud / worktrees / `/review`, a Workhorse-owned tool runner, merging Grok and Codex subscriptions.

Read `docs/agent-goal-codex-acp-adapter.md` before changing code.
