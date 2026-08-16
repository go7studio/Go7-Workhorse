# Goal

Build **Go7 Workhorse** as a native, quiet desktop shell for multiple coding-agent vendors without merging their subscriptions, contexts, tools, or sandboxes.

Current shipped baseline:

1. Electron owns all privileged work; React talks through typed IPC.
2. Projects are named containers with optional folders/references, and chats can move between them.
3. Grok, Codex, Claude, and Cursor are live local adapters; custom Anthropic/OpenAI-compatible bots are live HTTP slots. Cursor Watch is two monthly pools (Cursor Models vs Other Models).
4. Codex has a capability-aware App Server boundary with ACP fallback, rather than claiming native features on an incompatible install.
5. Chats can use a local folder or an isolated managed Git worktree.
6. Git review and a persistent chat-scoped terminal operate in that exact execution directory.
7. Approval mode, filesystem sandbox, network access, and outside-workspace/root access are separate controls.
8. `/schedule` creates durable one-shot background work that survives restart and returns to its owning chat.
9. Settings surfaces native Codex thread/child-thread history and discovered user/project hooks when App Server and local configuration expose them; unsupported cloud selection stays explicitly unavailable.
10. The production build and automated adapter/shell suite must remain green.

Historical slice documents under `docs/GOAL-*.md` describe how individual adapters landed; they are not the current product boundary.

**Current work:** `docs/GOAL-join-turn.md` — send the crew and stop; stay talkable; when every worker is done the desk builds one join prompt (the original ask, the lineup id, each child report) and the orchestrator answers in a **new** message. Prior slice: `docs/GOAL-orchestration.md`.

**Next adapter:** `docs/GOAL-cursor.md` — Cursor Agent ACP as a fifth vendor, with Cursor Models vs Other Models watch as a ship gate. Implementer plan: `docs/agent-goal-cursor.md`. Not the open Cursor IDE window, and not Grok Bot.
