# Goal: Grok `/goal` is a 1:1 Grok Build goal (Grok vendor only)

When This chat’s vendor is **Grok**, `/goal` must run **Grok Build’s** goal driver — writer, skeptic, verifier, evidence review, token budget, complete/pause with gaps. It must not become a Workhorse orchestrator spawn of MiniMax “Skeptic native goal” workers.

Desk `/goal` stays for Codex, Claude, MiniMax, and custom. Do not change those.

This is a **Grok-session contract**. Do not reimplement Grok’s kernel. Do not clone the Grok TUI HUD. Make Grok’s process actually run `/goal`, and stop Workhorse from stealing the turn.

Read first: `docs/GOAL-grok-native-goal-skills.md` (send-path already forwards the slash), `docs/grok-build-workhorse-gaps.md`, `src/lib/workhorse-rules.ts` (`WORKHORSE_SESSION_RULES`, `withSpawnHint`, `looksLikeSpawnRequest`), `src/lib/context-preface.ts` `composeVendorPrompt`, `electron/grok-launch.ts` session `_meta.rules`, `~/.grok/docs/user-guide/04-slash-commands.md` `/goal`, `05-configuration.md` goal / `GROK_WORKFLOWS`.

Live failure, 2026-08-15, chat **`/goal Prove this Workhorse chat is...`** in **Workhorse Dev**:

1. Composer sent the literal `/goal …` slash. Goal bar mirrored. That send-path slice is done.
2. Grok did **not** run `update_goal` or the workflow goal driver.
3. `looksLikeSpawnRequest` matched “subagents” in the objective. `composeVendorPrompt` prepended `SPAWN_TURN_HINT`. Session rules already say: bind folder, `workhorse_list_bots`, `workhorse_spawn_agent` on every `canCall` row.
4. Grok spawned three **MiniMax desk workers** titled Skeptic / Verifier / Collect evidence. Sidebar said Worker. Join said “If you want this same transcript on Grok Build, switch Vendor → Grok Build.”
5. After the join turn went idle, the **Active goal** bar stayed up (fixed in `goalDisplayForSession` / `grokGoalAfterTurnIdle` — do not regress).

Same prompt to prove this goal after implementation (new **Grok** chat, not MiniMax):

```
/goal Prove this Workhorse chat is running Grok Build native /goal. Do not edit files.
```

Do **not** put the words spawn / subagent / skeptic in the test prompt if you are testing that an ordinary `/goal` is enough. A second case **must** still be native even when the objective contains those words.

## Outcome

| On a **Grok** chat | Must happen |
|---|---|
| `/goal <objective>` | Grok’s **goal driver** runs. Writer works the objective. Independent skeptic/verifier (host workflow driver, or `update_goal` + verification) reviews completion. Children are Grok `spawn_subagent` / Grok verifier shards — **not** `workhorse_spawn_agent`. |
| Objective mentions “subagents” / “skeptic” / “spawn” | Still a Grok goal. `withSpawnHint` / `SPAWN_TURN_HINT` must **not** attach. `looksLikeSpawnRequest` must not treat a `/goal` line as a desk spawn request. |
| `/goal --budget N …` | Budget stays on the line Grok receives. Grok’s token budget applies. |
| `/goal pause` / `clear` / `resume` / `status` | Literal slash to Grok (existing halt-then-forward). Bar matches: pause stays, clear hides, complete/idle-after-set hides the local mirror unless Grok still reports an active goal. |
| ACP stream | Thought + Grok tools (`update_goal` and/or workflow / `spawn_subagent` explore-plan-general-purpose). No MiniMax worker lineup for a `/goal`. |
| Codex / Claude / custom `/goal` | Unchanged desk goal. |

“1:1” means the **inner loop** is Grok’s: writer → evidence → skeptic/verifier → complete or pause with gaps. Workhorse is the window. It does not invent a second crew.

## Done when

### Do not steal `/goal` into desk spawn

1. `looksLikeSpawnRequest("/goal … subagents …")` is **false**. Any `/goal` / `/goal ` line is not a desk spawn ask.
2. `withSpawnHint` on a `/goal` line returns the line unchanged (no `SPAWN_TURN_HINT`).
3. `composeVendorPrompt("/goal prove native", WORKHORSE_SESSION_RULES, …)` does **not** contain `workhorse_spawn_agent` as an instruction for this turn. Session rules may still exist for other prompts; they must not rewrite a `/goal` send.
4. `WORKHORSE_SESSION_RULES` (or the Grok-specific rules passed in `grok-launch` `_meta.rules`) must not tell Grok that `/goal` means desk `workhorse_spawn_agent`. If Grok needs a slimmer rule set on goal turns, use it. Do not delete desk spawn rules for ordinary “summon subagents” prompts.

### Grok’s driver actually runs

5. Launch/session enables Grok **goal mode** (see user-guide: `/goal` appears when goal mode is on). If that is a launch flag, env (`GROK_WORKFLOWS`), or `_meta`, pass it for Grok chats. Document which one you used. Do not fake it in the desk.
6. A live or recorded ACP `session/prompt` of `/goal …` is **not** rewritten to `goalVendorPrompt`. Outgoing prompt text is the `/goal` line (plus allowed Workhorse preface that does **not** include `SPAWN_TURN_HINT`).
7. On a logged-in Grok chat, `/goal` produces Grok goal behavior: `update_goal` **or** the workflow/host verifier path, and/or Grok-native `spawn_subagent` — **never** a desk lineup of MiniMax workers titled skeptic/verifier.
8. If Grok rejects (goal mode off), the user sees **Grok’s** failure in the transcript. No silent fallback to `workhorse_spawn_agent` or `goalVendorPrompt`.

### Goal bar (do not regress)

9. `goalDisplayForSession` on Grok + `status: idle` + local `goal.status === "active"` is **null** (bar hidden). Paused still shows. Custom/Codex idle + active still shows the desk bar.
10. `grokGoalAfterTurnIdle("grok", active)` is `undefined`. Paused Grok and any custom goal are unchanged.
11. Store done/error/idle paths still call `grokGoalAfterTurnIdle`. GoalBar still uses `goalDisplayForSession`.
12. End / `/goal clear` still forwards to Grok and hides the bar.

### Honest empty

13. Do not label MiniMax (or any desk `workhorse_spawn_agent` child) as a Grok skeptic/verifier. If the parent is a `/goal` turn, desk spawn of those names is a **fail**.

## Out of scope

- Rebuilding Grok’s TUI goal HUD or Agent Dashboard
- Changing MiniMax / Codex / Claude desk `/goal`
- Desk spawn for a **plain** “summon subagents” prompt (not `/goal`)
- Classifier `/auto`, `--worktree`, `--json-schema`

## Likely files

- `src/lib/workhorse-rules.ts` — `/goal` is not `looksLikeSpawnRequest`; `withSpawnHint` no-ops on `/goal`
- `src/lib/context-preface.ts` — do not attach spawn hint to Grok `/goal` vendor text
- `electron/grok-launch.ts` — enable goal mode / do not force rules that override `/goal`
- `src/lib/goal.ts` / `src/ui/GoalBar.tsx` / `src/lib/store.tsx` — keep idle-clear / display hide
- `test/workhorse.test.ts` — extensive cases below
- Optional `test/grok-goal-1to1-live.ts` — skip if Grok not logged in

## Tests (required, extensive)

Drive **shipped** functions. Do not reimplement spawn detection in the test.

### Spawn steal

1. `looksLikeSpawnRequest("please spawn subagents")` is still **true**.
2. `looksLikeSpawnRequest("/goal ship the backlog")` is **false**.
3. `looksLikeSpawnRequest("/goal assign skeptic verifier subagents")` is **false**.
4. `withSpawnHint("/goal assign skeptic and spawn subagents")` equals that string (no `SPAWN_TURN_HINT` prefix).
5. `withSpawnHint("Summon multiple subagents")` still starts with `SPAWN_TURN_HINT`.
6. `composeVendorPrompt("/goal prove native /goal", WORKHORSE_SESSION_RULES, "session/load")` does not include `SPAWN_TURN_HINT` and does not start with the spawn-orchestrator paragraph.
7. `prepareVendorSend({ provider: "grok", text: "/goal assign skeptic verifier" }).vendorText` is exactly `/goal assign skeptic verifier`.

### Driver vs desk

8. `prepareVendorSend` Grok `/goal migrate auth` still equals that string (no `goalVendorPrompt`).
9. Custom `/goal migrate auth` still uses `goalVendorPrompt`.
10. Store send-prep still used for Grok `/goal` (existing `prepareVendorSend` wiring).
11. Source: Grok `/goal` path does not call `workhorse_spawn_agent` as a desk intercept (no store branch that spawns on `/goal`).

### Bar

12. `goalDisplayForSession({ provider: "grok", status: "idle", goal: { status: "active", objective: "x" } })` is `null`.
13. Same with `status: "running"` is a visible active view.
14. Grok paused + idle still shows paused.
15. Custom idle + active still shows.
16. `grokGoalAfterTurnIdle` as above. Store still contains `grokGoalAfterTurnIdle`.
17. GoalBar still uses `goalDisplayForSession`.

### Regression

18. Desk spawn tests for “Summon multiple subagents” still attach the hint.
19. MiniMax / custom `/goal` halt-without-send still holds.
20. `npx tsx --test test/workhorse.test.ts` green.

### Live (if `grok` on PATH and logged in)

21. Optional `test/grok-goal-1to1-live.ts`: ACP `session/prompt` with `/goal status` then a short `/goal` that does not mention spawn. Assert outgoing text is the slash. Accept Grok’s own “no goal set” / goal-mode-off / `update_goal` / verifier tools as success of the **driver path**. Fail if the child is instructed to `workhorse_spawn_agent` for that `/goal`. Skip cleanly without login.

## Check

Open a **Grok** chat (not MiniMax). Type `/goal prove native goal driver. Do not edit files.`

- Transcript user line is that `/goal`.
- Work popout shows Grok thought/tools: `update_goal` and/or Grok `spawn_subagent` / workflow verifier — **not** MiniMax workers named Skeptic/Verifier.
- Sidebar does **not** grow three green Worker rows from `workhorse_spawn_agent` for this `/goal`.
- When the turn goes idle, the Active goal bar is **gone** (unless Grok paused or still reports active and you have a real Grok state mirror).
- `/goal assign a skeptic and verifier` still does **not** desk-spawn MiniMax.

Open a **MiniMax** chat. `/goal` is still the desk bar. “Summon subagents” still desk-spawns.
