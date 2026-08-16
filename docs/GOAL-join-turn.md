# Goal: Dispatch, then one join turn

The orchestrator **sends the crew and stops**. The user can keep talking. When every worker is done, the **desk** builds **one** prompt that names the orchestration call and pastes every report. The orchestrator answers that prompt in a **new** message. It does not keep writing on the dispatch bubble.

## Why this exists

Live MiniMax chat **PLease do a deep scrape of...** (`sess_k2lekk7gwqk0`) in **Spaceship battles** (`D:\Godot\Projects\spaceship-battle`), 2026-08-14.

User: `PLease do a deep scrape of this project with subagents`

What worked:

- The chat was already in Spaceship battles. Four MiniMax workers launched with `wait=false` into that folder.
- Slice 1 (structure/config) and slice 4 (assets/shaders/crafts) wrote real Godot reports onto `lineup.rows[].report`.

What failed (correct these):

| What happened | Why it is wrong |
|---|---|
| After spawn, the first assistant kept talking: crew table, “I’ll check back,” “Status snapshot in a moment.” | Dispatch is finished when the workers are sent. That turn should end. |
| Last tool on the parent is `workhorse_await_agents · running`. | Join is a desk job. The model must not sit on await in the same turn. The parent cannot stay talkable if it is blocked on that tool. |
| No `All workers finished.` note and no second assistant reply. | The review never became its own message. The user still only sees the dispatch bubble. |
| Scripts scrape and Scenes scrape show `toolStatus: failed` on the parent, but `lineup` still says `running`, and the children are `idle` with `agentRun.status: running`. | Status is inconsistent, so the crew never goes terminal and join never fires. Slice 2’s visible text is mid-scrape narration (~122k context), not a report. |
| Slice 3 opened by quoting Permission / Sandbox. | `looksLikePermissionQuestion` fired on the worker brief. That is not the job. |
| Nothing in the transcript says “this synthesis is the answer to that scrape, lineup X, children A/B/C/D.” | The desk never built a join prompt that names the orchestration call. |

Same prompt to run again after this goal is implemented (new MiniMax chat **inside** Spaceship battles):

`Please do a deep scrape of this project with subagents`

## The contract

Three phases. The desk owns the handoff. The model does not improvise it.

### 1. Dispatch (orchestrator, one turn)

1. Bind the folder. List bots.
2. Spawn every slice with `wait=false`.
3. Optional one short line: who is out, which folder.
4. **Stop.** No await. No “I’ll check back.” No 1 / 2 / 3.

That turn is over. The parent is idle and talkable. Anything the user types while the crew runs is a normal new turn. It is not the join.

### 2. Workers (own chats)

Each child fills its own nested chat under the parent. Worker role is unchanged: do the slice, do not spawn, do not list bots, do not lecture about Permission.

When a child finishes, fails, or dies mid-scrape, the desk writes `lineup.rows[]` (`status` + `report`) and keeps `agentRun` and the parent subagent marker in agreement. An idle child must not stay `agentRun: running`.

### 3. Join (desk) → answer (new orchestrator message)

When **every** row is terminal (`completed` / `failed` / `timed-out`):

1. Insert the visible break `All workers finished.`
2. Send **one** desk-owned prompt (hidden user is fine) whose body is:

```
ORCHESTRATION CALL
- User: “Please do a deep scrape of this project with subagents”
- Lineup: lineup_<id>
- Folder: D:\Godot\Projects\spaceship-battle
- Dispatched: <time>, N workers

REPORTS
### 1. <title>  child=<sess_…>  status=completed
<source report or “(no report)”>

### 2. …
```

3. The next **assistant** message is the answer to that call — one combined review, citing which slice each fact came from. New bubble. Not appended to “I’ll spawn four workers.”

Failed or empty slices stay in the prompt as `status=failed` / `(no report)`. The orchestrator says what is missing. It does not ask the user to pick.

The user can talk before join. Those turns stay separate. Join still fires **once** when the crew is terminal (`notifiedAt`).

## Desk must enforce

1. After the last `wait=false` spawn in a dispatch, do not leave `workhorse_await_agents` running on the parent. If the model calls it, return a status snapshot immediately.
2. `looksLikePermissionQuestion` is false on worker briefs and on text that only mentions Permission/Sandbox as workspace facts.
3. `lineupJoinPrompt` is desk-owned: original user sentence, lineup id, folder, each child id + title + status + report.
4. Persist `lineup.userText` from the user message that started the wave.
5. When a child goes idle, `agentRun` is terminal and the parent subagent marker matches, so four of four rows can complete.
6. Two assistant messages with body text are two replies. The join always inserts the system break first.
7. Parent `status` is idle after dispatch returns. Join is a later `send()` of the join prompt, not a continuation of the dispatch assistant id.

## Done when

On this machine, new MiniMax chat inside Spaceship battles, prompt exactly:

`Please do a deep scrape of this project with subagents`

1. Workers start on `D:\Godot\Projects\spaceship-battle`. The dispatch assistant **ends**. Parent is idle. You can type another message.
2. That dispatch turn does **not** sit on blocking await. No 1/2/3. No “status snapshot in a moment” as the last act.
3. Workers do **not** open with a Permission/Sandbox lecture.
4. When all rows are terminal, one system break + one new assistant message appears. That message is the combined scrape. It is not the same bubble as the dispatch table.
5. The join prompt (even if hidden) contains the original user sentence, the lineup id, and each child id/title/status.
6. Failed slices are labeled failed in that prompt. They do not leave `agentRun: running` on an idle child.
7. `npm test` is green. Live proof is two distinct parent assistant message ids in state (dispatch vs join answer).

## Out of scope

- New vendors, inventing MiniMax keys, Allow cards.
- Auto-binding a loose chat to whichever project is selected.
- Workers as top-level loose CHATS.
- Killing `grok.exe` / the TUI.

## Related

`docs/GOAL-orchestration.md` is the prior slice (roles, folder bind, workers cannot spawn). This goal is the handoff after that crew is already out.
