# Goal: Solid bot orchestration

Make Workhorse **line up** bots the way a desk should: one live chat is the orchestrator, it predetermines who works and on what folder, workers do only their slice, and nobody reviews the wrong repo or summons another layer of MiniMax.

This is the next product contract after spawn-without-Allow and custom-bot self-spawn. It is not a new vendor adapter.

## Why this exists

Live failure, 2026-08-14, chat **PLease call subagents to strip threw...** (MiniMax-M3, Always, no `projectId`):

1. The user asked the main chat to call subagents and review **the project**.
2. **Spaceship battles** is on the desk and linked to `D:\Godot\Projects\spaceship-battle`. That project still said **No chats yet.** The MiniMax chat sat loose under **CHATS**.
3. The main bot listed bots, saw only MiniMax `canCall`, and spawned several MiniMax children with slices like “Review project identity and docs” and “src tree review”. That part (fan-out of the only callable vendor) is what the last rules asked for.
4. Those children inherited `projectId: null` and `environment: { kind: "local" }` with an empty folder. `list_dir` therefore walked the Workhorse app tree. The right pane reviewed `README.md`, `GOAL.md`, GitHub Actions, Electron, Grok/Codex/Claude — not `project.godot`.
5. Worse: the desk wrapped each child prompt as `From another Workhorse agent (“PLease call subagents…”):` plus “You are a MiniMax sub-agent **spawned**…”. `looksLikeSpawnRequest` matches `sub-agent` / `spawned`. `withSpawnHint` and `CUSTOM_HTTP_SESSION_RULES` then told the **worker** to `workhorse_list_bots` and `workhorse_spawn_agent` on every `canCall` row.
6. The worker in the popout said it would spawn *another* MiniMax to do the slice it had already been given. The orchestrator and the worker no longer knew who they were.

There is no useful point to that wave. It is a confused cascade on the wrong folder.

Prompt-only rules will not hold this. MiniMax already had “give each spawn the review task, not a request to summon more agents” and still re-spawned, because the **desk** prepended a spawn hint and left `workhorse_spawn_agent` on the worker.

## Roles

Every session on a spawn path has exactly one role. The desk sets it. The model does not choose it.

| Role | Who | Job |
|---|---|---|
| **Orchestrator** | The live sidebar chat the user typed into (`parentId` empty) | Resolve the workspace. List callable bots. Write a lineup. Spawn those workers. Wait. Synthesize. Talk to the user. |
| **Worker** | A hidden child (`parentId` set, `hidden: true`) | Do one named slice in one bound folder. Return a report. Stop. |

A worker is never an orchestrator. A worker does not plan a team. A worker does not spawn.

`workhorse_ask_chat` to an existing **sidebar** chat is not a spawn. That peer is already a live chat with its own role. Do not turn an ask into a worker, and do not turn a worker into a sidebar chat.

## The lineup (orchestrator must predetermine)

Before the first `workhorse_spawn_agent`, the orchestrator must have a lineup. The desk should make this easy and, where possible, structured — not a paragraph the model invents after the children are already running.

A lineup row is:

- **Name** — short label the popout already shows (`description`)
- **Vendor** — a `canCall` row from `workhorse_list_bots` (custom bots included; turned-off vendors never named)
- **Slice** — one job (identity/docs, `src/`, combat, one Godot scene — not “do the whole review by summoning more agents”)
- **Folder** — absolute cwd the worker will `list_dir`
- **Deliverable** — what comes back (report sections, files read, pass/fail)

Rules for building it:

1. **Workspace first.** If this chat has a project folder, that is the folder. If this chat is loose and a project is selected, or the user named a game/folder, bind that project to this chat (move, or create+attach) **before** spawn. If the user said “the project” and Spaceship battles is the selected/linked game, that is the project — not Go7-Workhorse.
2. **Never spawn into an unbound local cwd.** An empty `projectId` plus `list_dir` with no path is how Workhorse itself got reviewed. Fail closed: no worker starts until a real folder is bound, or the orchestrator searched and found one (same search rules as allocate: `D:\`, `C:\`, `Godot\Projects`, named folders).
3. **Vendors next.** `workhorse_list_bots`. Spawn only `canCall`. Skip no-go in one line. If they asked for several agents and only one vendor is callable, several workers of that vendor with **different slices**, not one worker that spawns the rest.
4. **Write the lineup, then spawn those rows.** Do not spawn a worker whose prompt is “please call subagents” or “spawn MiniMax to review src/”.
5. **One wave unless a worker failed or the user asked for more.** After results, the orchestrator writes the review. It does not open a second fan-out because a child mentioned spawn.

The orchestrator may call `workhorse_list_bots` once, then N `workhorse_spawn_agent` calls. It should not ask the user which vendor. It should not wait for Allow when the vendor is already `canCall`.

## Desk must enforce (code, not vibes)

Weak models will ignore a paragraph. The shell has to make the wrong move impossible.

### 1. Role on the session

Derive it: `parentId` set → worker. Persist it if a later UI needs to show it. Every spawn path (`store` spawn branch, custom host, MCP `workhorse_spawn_agent`, Grok/Codex/Claude prompt) must see the same role.

### 2. Workers do not get spawn tools

A worker’s tool list **must not** include `workhorse_spawn_agent` or `workhorse_request_vendor`. If a leaked call arrives anyway, the desk returns a hard error: `Workers cannot spawn. Do the assigned slice and return the report.` No Allow card. No second child.

`workhorse_list_bots` is orchestrator-only on a spawn path. Workers do not need a roster to review a folder.

Workers still get workspace tools (`list_dir`, `read_file`, and write/run when this turn allows) and, if useful, `workhorse_read_chat` of the parent. They do not get “talk to every sidebar chat and recruit them.”

### 3. Spawn hints never land on workers

Today `composeVendorPrompt` and `electron/custom-host.ts` run `withSpawnHint` on **every** user text that matches `SPAWN_ASK` (`spawn`, `summon`, `sub-agent`, …). Worker briefs contain those words by construction.

Fix:

- `withSpawnHint` / `withCustomPeerHint` **do not run** when the session is a worker.
- `looksLikeSpawnRequest` is **false** for desk-wrapped worker briefs (text that already has a worker role header, or `From another Workhorse agent`).
- Session rules split: orchestrator keeps the spawn-every-`canCall` paragraph; workers get a short worker paragraph and **must not** see “spawn every canCall row.”

### 4. The desk writes the worker brief

Do not send the parent’s raw `prompt` through as the child’s user turn. `formatSubagentPrompt` today is:

```
From another Workhorse agent (“PLease call subagents to strip threw...”):

<parent text>
```

That is what confused the child. Replace it with a desk-owned brief the parent cannot override:

```
ROLE: worker
ORCHESTRATOR: <parent title>
PROJECT: <project name or “(none — stop and say so)”>
FOLDER: <absolute cwd>
SLICE: <description>
VENDOR: <this bot’s name / model>

Do this slice only. Use list_dir / read_file on FOLDER. Quote real files.
Do not spawn. Do not list bots. Do not ask the user. Do not review any other tree.
Return the report as plain text.

TASK:
<parent’s slice text, stripped of “please spawn / call subagents / you are a sub-agent spawned”>
```

If the parent’s prompt is itself a spawn request and has no slice, **reject the spawn** with an error the orchestrator can read: `Worker prompt is a spawn request, not a slice. Write the actual job.`

### 5. Folder inheritance is required

On spawn:

- `child.projectId = parent.projectId` (already true) **and**
- if the parent has no project, **do not start the child** until the orchestrator bound one, **or** `workhorse_spawn_agent` accepted an explicit absolute `folder` that exists and the child runs there for this turn.
- `sessionExecutionCwd` for a worker must be that folder (or its worktree). Empty string is a bug.
- Isolation `worktree` only when that folder is a git root; otherwise `shared` in the bound folder. Do not fall back to the Workhorse repo.

Optional but wanted: `workhorse_spawn_agent` grows an optional `folder` (absolute). If omitted, use the parent project folder. If both missing, error.

### 6. Depth is one

Only the orchestrator may spawn. A worker cannot. There is no grandchild unless the **user** later opens that worker as a real chat and asks it to orchestrate — out of scope for this slice. One parent → N workers → reports back. Stop.

### 7. Orchestrator prompt contract

Keep “list bots, spawn every canCall, split tasks if only one vendor.” Add:

- Bind the folder first.
- Each spawn’s `prompt` is the slice, never “summon agents.”
- After workers return, synthesize. Quote their reports. Do not spawn a cleaner-up wave.

`skills/desk/SKILL.md` must say the same thing in the same order, and must say workers do not spawn.

## What the user should see

The popout already shows worker tabs. That is not enough if the tab is secretly another orchestrator.

1. **Orchestrator bubble** — after list_bots, a short lineup the user can read (name · vendor · folder · slice) *before* or as the workers start. Not a pick-one card. Not Allow.
2. **Worker pane header** — `ROLE worker` · project name · absolute folder · slice. If the folder is `C:\Users\lgovo\Projects\Go7-Workhorse` and the selected project is Spaceship battles, that header is how we catch the bug without reading the essay.
3. **Worker body** — the slice work. If the first sentence is “I’ll spawn a MiniMax sub-agent”, the slice failed.
4. **Rejected nested spawn** — a failed tool row on the worker, not a new tab.

## Done when

All of the following are true on this machine, with MiniMax as the only callable vendor if that is the live desk:

1. A MiniMax orchestrator in **Spaceship battles** (or moved there as part of the turn) that is told to call subagents and review the project spawns workers whose `list_dir` root is `D:\Godot\Projects\spaceship-battle`. Their reports mention Godot / `project.godot` / game scripts. They do not review Workhorse `electron/` or this repo’s `GOAL.md` unless that folder *is* the bound project.
2. Those workers do **not** call `workhorse_spawn_agent`. The popout does not grow a second layer of MiniMax tabs whose job is “spawn MiniMax to do my job.”
3. A worker brief that contains the words `spawn`, `sub-agent`, or `From another Workhorse agent` does **not** receive `SPAWN_TURN_HINT` and does **not** get spawn tools.
4. `workhorse_spawn_agent` with a prompt that is only “please call subagents / spawn MiniMax” is rejected. The orchestrator must send a slice.
5. A loose chat with **no** project does not start workers against the Workhorse app folder. It binds or searches first (same allocate search), or it errors.
6. Turned-off vendors stay unnamed. Daily-bank vendors stay one-line no-go. Only `canCall` rows are lined up. Several MiniMax workers with split slices is correct when MiniMax is the only callable row.
7. Existing desk behavior stays: no Allow card on `canCall` spawn, custom bots can spawn themselves, `ask_chat` still talks to sidebar chats, rename/move/delete fail-closed rules are untouched, grok.exe / the TUI are never killed.
8. `npm test` is green. New tests below are in that suite. A live MiniMax pass is recorded in the verification notes at the bottom of this file (or the PR body), with folder paths quoted from the worker header — not from the model’s memory.

## Out of scope

- New vendors, MiniMax keys in source, or treating MiniMax as a built-in.
- Asking the user which vendor when `canCall` is already known.
- Deep agent graphs, agent-to-agent markets, or turning every worker into a sidebar chat.
- Replacing vendor-native subagents inside Grok/Codex/Claude. This is the **Workhorse** spawn path (`workhorse_spawn_agent` + in-chat popout).
- Redesigning This-chat presets, Usage, or the composer.

## Test plan I would run

Cheapest proof first. Do not burn MiniMax tokens until the desk cannot emit the old brief or the old hint.

### Phase 0 — pin the failure (no code yet)

I would keep one screenshot and one state quote so we cannot “fix” the wrong thing:

- Worker popout whose first assistant line is “I’ll spawn a MiniMax sub-agent…”
- Parent session `projectId: null` while Spaceship battles exists
- Child `environment.kind === "local"` with no folder
- `formatSubagentPrompt` + `withSpawnHint` applied to that text

If a later change still produces that screenshot, the slice is not done.

### Phase 1 — unit tests (seconds, every save)

Add focused tests next to the existing spawn-hint block in `test/workhorse.test.ts` and the custom-http / watch suites. I would write these first and watch them fail on current main, then implement.

| # | Assert | Why |
|---|---|---|
| 1 | `looksLikeSpawnRequest("Summon subagents to review the project")` is true | Orchestrator still gets the hint. |
| 2 | `looksLikeSpawnRequest` is false for a desk worker brief that contains “sub-agent spawned” / “From another Workhorse agent” | Stops the live cascade. |
| 3 | `withSpawnHint(workerBrief)` returns the brief unchanged | Hint must not prepend. |
| 4 | `formatWorkerPrompt(...)` includes `ROLE: worker`, the absolute folder, the slice, and `Do not spawn` | Desk-owned brief. |
| 5 | `formatWorkerPrompt` strips a leading “Please call subagents…” from the parent text, or the spawn API rejects a prompt that is only a spawn request | Parent cannot export its own job. |
| 6 | Worker tool catalog (custom HTTP + MCP filter) does **not** contain `workhorse_spawn_agent` or `workhorse_request_vendor` | Hard lock. |
| 7 | Orchestrator catalog still contains `workhorse_spawn_agent` | Do not break the parent. |
| 8 | Spawn with `parent.projectId` set copies it and `sessionExecutionCwd` equals that project’s first folder | Inheritance. |
| 9 | Spawn with no project and no `folder` argument errors; it does not start a child on `""` | Fail closed. |
| 10 | Spawn with explicit existing `folder` sets worker cwd to that path | Escape hatch. |
| 11 | Nested spawn (`parentId` set) returns the hard error string and does not create a grandchild session | Depth. |
| 12 | Disabled / omitted vendors still do not appear on the roster; `canCall: false` is still a no-go | Last slice must not regress. |
| 13 | `composeVendorPrompt` / custom-host hint order: worker session never includes `SPAWN_TURN_HINT` even when the task text says “spawned” | Host path, not just the helper. |
| 14 | `skills/desk/SKILL.md` and both session-rule strings agree: orchestrator lines up, worker does not spawn | Docs cannot fight the code. |

Command: `npm test`. I would run the two files I touched first if I need a tighter loop (`tsx --test test/workhorse.test.ts test/custom-http.test.ts test/watch.test.ts`), then the full script before I call it done.

### Phase 2 — fixture / store contract (still no live API)

In `test/workhorse.test.ts` (or a small new file imported by `npm test`):

- Build a fake parent in Spaceship battles with folder `D:\Godot\Projects\spaceship-battle`. Resolve a spawn. Assert child `projectId`, cwd, role, isolation, and the exact brief prefix.
- Build a fake loose parent. Assert spawn without folder throws.
- Build a fake worker session and assert the spawn action in the inbox handler refuses.

No Electron window required. This is how I would catch “we wrapped the prompt but still passed `cwd: ''`.”

### Phase 3 — one live MiniMax orchestrator (paid, once the units are green)

Throwaway chat. Do **not** reuse the confused transcript.

1. New chat, MiniMax, Always, **already inside Spaceship battles** (move it first if the UI still leaves new chats loose).
2. User text: `Call subagents and give an in-depth review of what this project is.`
3. Watch the orchestrator: list_bots → lineup → N `workhorse_spawn_agent` with slice prompts.
4. Open **each** worker tab. Header folder must be `D:\Godot\Projects\spaceship-battle`. First tools must be `list_dir` / `read_file` on that tree. First files should look like `project.godot`, `*.gd`, game docs — not `electron/main.ts`.
5. Confirm **zero** nested `workhorse_spawn_agent` from any worker. If one appears, stop and fix Phase 1 #6/#11. Do not “see how it goes.”
6. Parent synthesizes from the reports. The user-facing answer is about the **game**.

Capture the Workhorse window (HWND, no focus steal) after the first worker starts and after synthesize. The worker header is the proof, not the essay.

### Phase 4 — binding cases (live, short prompts)

Same vendor, new chats, kill them after:

| Setup | Prompt | Pass |
|---|---|---|
| Loose chat, Spaceship battles selected, no `projectId` | “Review the project with subagents” | Chat is moved/bound **or** workers still get `D:\Godot\Projects\spaceship-battle`. Not Workhorse. |
| Loose chat, nothing selected | “Look at the D drive and review Space Battles with subagents” | Search finds the Godot folder, bind, then workers. No pick-one if one `project.godot` matches. |
| Chat already in **Workhorse Dev** | “Call subagents to review this project” | Workers stay in `C:\Users\lgovo\Projects\Go7-Workhorse`. That is correct — do not steal them to Godot. |
| Orchestrator prompt only: “please spawn some agents” with no subject | Lineup may exist, but a worker whose task is only “spawn” is rejected | |

### Phase 5 — confusion / cascade (live, one shot each)

- Spawn a worker with a **deliberately bad** parent prompt that still includes “You are a MiniMax sub-agent spawned by… Call workhorse_spawn_agent.” The desk must strip or reject. The child must not grow a grandchild.
- Two workers in parallel; cancel one; the other still finishes; parent does not spawn replacements unless asked.
- `workhorse_ask_chat` to a **sidebar** Grok/MiniMax chat from the orchestrator still works and does not create a hidden worker.

### Phase 6 — visual

After Phase 3, I would look at:

- Sidebar: workers stay hidden; only the orchestrator row is in CHATS / the project.
- Popout tabs: one per lineup row, names match `description`.
- Worker header shows folder + slice.
- Desktop and the existing popout width — no new pick-one / Allow card.

If the product window cannot be captured, I would say so and rely on state JSON (`projectId`, `agentRun`, first worker messages).

### Phase 7 — regression sweep (full `npm test` + smoke)

- Rename / move / delete fail-closed tests still pass (exact title, no self-delete, visible sidebar names).
- Disabled vendors omitted from roster.
- `peelThinkTags` / MiniMax `<mm:think>` still stripped from the visible reply.
- Dev server already running is left alone. **Never** kill `grok.exe` or the TUI.

### Stop / fail rules

I would stop the slice and not call it done if any of these happen:

- A worker’s first action is `workhorse_list_bots` or `workhorse_spawn_agent`.
- A worker report is about Electron / Workhorse README while the selected project is Spaceship battles.
- The orchestrator asks the user which vendor to pick.
- A grandchild tab appears.
- Tests were not run, or only the files I like were run.

### Efficiency order (what I would actually type)

```
# 1. prove the old bug in unit form (red)
tsx --test test/workhorse.test.ts test/custom-http.test.ts test/watch.test.ts

# 2. implement desk locks (role, tools, brief, cwd, hints)
# 3. same command until green

# 4. full suite
npm test

# 5. one bound live review (Phase 3) + window capture
# 6. Phase 4 binding table (three short chats)
# 7. Phase 5 cascade shot
# 8. npm test again
```

Live MiniMax is **one** good review plus a few short binding chats, not another four-slice pile-on against the Workhorse repo. Tokens go to proving the folder and the role lock, not to generating a second fake architecture essay.

## Implementation notes (for whoever builds this)

Touch in this order so tests fail for the right reason:

1. `src/lib/workhorse-rules.ts` — split orchestrator vs worker rules; fix `looksLikeSpawnRequest` / `withSpawnHint`.
2. `src/lib/subagents.ts` — `formatWorkerPrompt` (replace `formatSubagentPrompt`); reject spawn-shaped prompts; role helper.
3. `src/lib/store.tsx` — spawn branch: require folder, set cwd, refuse nested spawn, pass role into preface.
4. `electron/custom-host.ts` + `electron/custom-tools.ts` + `electron/workhorse-mcp.ts` — no spawn hint / no spawn tools on workers.
5. `src/lib/context-preface.ts` — worker preface: folder + slice + do-not-spawn; do not attach `SPAWN_TURN_HINT`.
6. `skills/desk/SKILL.md` — lineup, then spawn; workers do the slice.
7. Tests listed in Phase 1–2.

Do not “fix” this by telling MiniMax harder in `CUSTOM_HTTP_SESSION_RULES` while workers still receive `SPAWN_TURN_HINT` and `workhorse_spawn_agent`. That is how we got the screenshot.
