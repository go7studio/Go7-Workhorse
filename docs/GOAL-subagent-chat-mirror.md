# Goal: Compact read-only subagent chat

Make a spawned subagent conversation look like a **1:1 of the usual chat**, only smaller, and **you cannot talk to it**.

The right-hand agent pane (`AgentThreadPane`) and the nested popout preview must show the same turn format as the main transcript: who spoke, thinking, tool calls, elapsed work, and usage. They must not invent a second bubble language.

This is a UI contract. It does not change spawn, Watch, or who can send.

## Why this exists

Live failure, 2026-08-14, chat **Please summon subagents and do an intensive scrape…** (MiniMax, Spaceship battles):

1. The main chat used the usual format: MiniMax name + green dot, Work popout (thinking, tools, `Working · 1m 1s`, subagent rows), then the reply.
2. Opening a child on the right showed a different product: purple “agent bubbles”, a title, and the final report text.
3. Thinking, tool rows, finished-tool folds, and the context ring were gone. `subagentTurns()` **drops** `thought`, `tool`, `compact`, and `subagent` messages on purpose.
4. The user could not tell what the child was doing — only what it finally said.

The child session already has the same `messages` as a normal chat. The pane is throwing that away.

## Outcome

A subagent pane is a **compact spectator** of the usual chat.

| Usual chat | Subagent pane |
|---|---|
| `groupTranscript` → user / reply blocks | Same grouping of the **child** session |
| `turn-who` + model-color dot | Same, using `brainCaption` / `deskInk` |
| `WorkPopout` (thinking, live tools, finished fold, elapsed) | Same `WorkPopout`, compact CSS |
| `say final` reply + copy | Same reply, **Copy only** — no Fork |
| `ContextMeter` (retained tokens) | Same meter, scoped to the child session |
| Composer, This chat, Review, Terminal, Goal, Watch, Steer | **Absent** |

You can watch. You cannot prompt, queue, steer, or change that child’s model.

## Done when

1. **Same grouping.** The child pane renders `groupTranscript(child.messages)`, not `subagentTurns()` text-only rows. User turns use `UserTurn` (or a compact variant that still looks like the main user bubble). Assistant turns use the same who-row + `WorkPopout` + peeled body as `SessionPane`.
2. **Thinking and tools are visible.** Live thought streams in the Work popout. Tool rows show name + status + detail. Finished tools collapse under “N finished”. Elapsed time ticks next to `working` the same way as the main popout (`formatWorked`).
3. **Usage is visible.** The pane header includes the usual context ring for **that child** (`estimateChatContext` / live vendor occupancy on the child session). Clicking it opens the same Retained context popover. It does not show the parent’s tokens.
4. **Color matches the set model.** Header, tabs, and turn-who dots use `deskInk` / `brainCaption` (MiniMax green if that is the bot color). No default blue/purple peer wash on the transcript.
5. **Compact, not a second desktop.** Narrower type, tighter gaps, smaller Work popout and context ring. It must still be recognizable as the usual chat, not a new bubble skin. Tabs stay for multiple children.
6. **Read-only.** No composer, no `/`, no Steer/Queue, no This-chat setup, no Review/Terminal, no Goal bar, no Watch banners on the child pane. Fork is omitted. Copy on a finished reply is allowed.
7. **Nested popout stays a preview.** Clicking a subagent row still opens the right pane. The inline fold may stay a one-line status (`working · 1m 12s`); it must not become a second full transcript. The full 1:1 lives in the pane.
8. **Honest empty states.** Waiting / still working / Watch fail keep the current meaning. Do not fake a reply when the child has only thought or tools.

## Out of scope

- Letting the user send into a worker
- Promoting a worker into a sidebar chat
- Changing spawn, lineup, or folder binding (`docs/GOAL-orchestration.md`)
- A new vendor adapter
- Redesigning the main transcript

## Likely files

- `src/ui/AgentThreadPane.tsx` — render grouped child turns; add compact `ContextMeter` for the child
- `src/ui/SessionPane.tsx` — extract the reply block if that is the cheapest way to stay 1:1
- `src/lib/agent-thread.ts` — stop treating flattened `turns` as the display model; keep tab/live metadata
- `src/lib/subagents.ts` — `subagentTurns` can remain for popout one-liners; do not use it as the pane body
- `src/ui/WorkPopout.tsx` / `src/ui/ModelMenu.tsx` — compact variants or size props, no second implementation
- `src/styles/app.css` — `.agent-thread` compact transcript, drop `.agent-bubble` as the body language
- `test/workhorse.test.ts` — pane uses `groupTranscript`; no composer; context meter present; tools/thoughts not stripped

## Check

Open a live MiniMax spawn with three children. The right pane for “Battle HUD…” must show thinking, each tool row, working time, the reply in the usual `say` shape, and that child’s 22k-style ring — not a purple bubble with only the report. There is no input box at the bottom of that pane.
