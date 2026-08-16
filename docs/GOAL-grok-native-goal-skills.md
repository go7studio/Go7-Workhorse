# Goal: Grok Build `/goal`, skills, and vendor slashes function inside Workhorse

When This chat’s vendor is **Grok**, Workhorse must run **Grok Build’s** goal driver, skill commands, and the rest of Grok’s user-invocable slashes — not a desk rewrite, not a “use the installed skill” wrapper.

Desk `/goal` and desk skill wrapping stay for Codex, Claude, MiniMax, and custom. They must not steal the slash on a Grok chat.

This is a **surface / send-path** contract. Do not reimplement Grok’s goal kernel, skill runtime, hooks, workflows, or TUI modals.

Read first: `docs/grok-build-workhorse-gaps.md`, `src/lib/commands.ts`, `src/lib/goal.ts`, `src/lib/store.tsx` send path, `src/lib/skills-catalog.ts`, `electron/grok-agent.ts` `extractAvailableCommands`, `~/.grok/docs/user-guide/04-slash-commands.md`, `08-skills.md`.

## Why this exists

Today, on a Grok chat:

1. Workhorse `COMMANDS` owns `/goal` (`run: "goal"`). `mergeCommands` makes that name win over any Grok command, including ACP `available_commands_update` rows that already arrive as `run: "grok"`. `store.send` runs `parseGoalInput` **before** `matchCommand`. Set/resume become `goalVendorPrompt` prose (“Work toward this ongoing Workhorse goal…”). Pause/clear cancel the turn and **return without sending anything**. Bare `/goal` and `/goal status` never leave the desk. Grok never sees `/goal`. Grok’s token budget (`--budget`), evidence review, and `update_goal` / workflow goal driver do not run.
2. Grok skills from `~/.grok/skills`, `~/.grok/bundled/skills`, `~/.grok/plugins`, and project `.grok/skills` **are** on the palette (`skillHomes` + `commandsFromSkills`). Picking one sets `run: "skill"` and `invokeSkillPrompt` rewrites the send to “Use the installed skill … Follow its SKILL.md exactly.” That is not Grok’s user-invocable slash (`/pdf`, `/local:commit`, `/user:commit`, `/plugin:name`).
3. Typing `/skills` is already `run: "grok"` and is forwarded. `/workflow`, `/workflows`, `/hooks`, `/plugins`, `/marketplace`, `/mcps`, `/deep-research`, `/loop`, `/imagine` already follow that path. `/goal`, skill names, and `/create-workflow` must work the same way.
4. Existing tests **encode the bug**. `test/workhorse.test.ts` asserts `commandsForSession({ provider: "grok" })` `/goal`.run is `goal` and that `commandContinuesToVendor` is false. `test/desk-export.test.ts` asserts Grok palette `/pdf` is `run: "skill"`. Those cases must flip as part of this work — do not keep them green by preserving the steal.

Live effect: a Grok chat’s Goal bar and skill picks are a Workhorse imitation. The user asked for Grok Build goaling, skills, and the rest of that vendor surface **inside** Workhorse.

## Outcome

| Action on a **Grok** chat | Must happen |
|---|---|
| `/goal <objective>` | Grok receives exactly that string. `--budget <tokens>` stays on the line. Desk must not rewrite to `goalVendorPrompt`. |
| `/goal pause` / `resume` / `clear` / `status` / bare `/goal` | Same strings go to Grok. Pause/clear may still **cancel** the live ACP turn (desk halt), then send the **literal** `/goal pause` or `/goal clear` so Grok’s driver stops too. Do not return before send. Bare `/goal` and `/goal status` are vendor prompts, not a local-only view. |
| Bare `/pause` | Not a desk goal halt on Grok. Only `/goal pause` (and `/goal clear` / `/goal stop`) halt-then-forward. `/pause` is an ordinary prompt unless Grok advertised it. |
| `/skills` `/hooks` `/plugins` `/marketplace` `/mcps` | Stay forwarded as `run: "grok"`. |
| `/workflow` `/workflows` `/create-workflow` | Forwarded as `run: "grok"`. Add `/create-workflow` to `GROK_SHELL_COMMANDS` if it is missing. |
| `/deep-research` `/loop` `/imagine` `/imagine-video` `/memory` `/flush` `/dream` `/remember` | Stay forwarded. |
| Palette skill `/name` from a grok-origin catalog row | Send `/name` (and rest args) to Grok. Do **not** call `invokeSkillPrompt`. |
| Qualified Grok names `/local:name`, `/repo:name`, `/user:name`, `/plugin:name` | Palette or typed send reaches Grok unchanged. Do not strip the prefix. |
| ACP `available_commands_update` skill or `/goal` | Already extracted as `run: "grok"` (`extractAvailableCommands`). Must survive merge and send. Workhorse `/goal` must not overwrite it on a Grok session. |
| `/goal` or a grok-origin skill on **Codex / Claude / custom** | Current desk behavior. No change. |

Grok TUI modals (extensions, goal HUD, workflow dashboard) will not appear as Electron windows. “Function inside Workhorse” means: **Grok’s process runs the command**, ACP stream shows thought/tools/reply, and the desk does not lie about who owns the goal/skill.

## Done when

### Send path (required helper)

Export a pure function the store send path **must** call (name can vary; tests import the shipped one), e.g. `prepareGrokOrDeskSend` / `vendorPromptForSend`:

```
input:  { provider, text, goal?, match? }
output: { vendorText, haltVendor, applyDeskGoal, skipVendor }
```

Rules:

1. `provider === "grok"` and text is `/goal` or `/goal …` → `vendorText` equals the trimmed typed string. `applyDeskGoal` is false (or only a last-sent mirror — see Goal bar). Never `goalVendorPrompt`.
2. `provider === "grok"` and text is `/goal pause` or `/goal clear` / `/goal stop` → `haltVendor: true` **and** `skipVendor: false`. The store cancels the live turn, then still prompts Grok with that exact string.
3. `provider === "grok"` and `match.run === "grok"` (shell, ACP, or grok-origin skill) → `vendorText` is the typed string. `invokeSkillPrompt` is not applied.
4. `provider !== "grok"` → today’s desk `/goal` + `invokeSkillPrompt` behavior, including halt-without-resend on pause/clear.

`store.send` must not special-case Grok with a second copy of these rules. Tests drive the helper, then assert `store.tsx` calls it (or that the helper is the only place `goalVendorPrompt` / `invokeSkillPrompt` are chosen).

### Palette and merge

5. `commandsForSession({ provider: "grok" })` — `/goal` is **not** `run: "goal"`. It is `run: "grok"`. Hint/input matches Grok: `objective [--budget tokens] \| status \| pause \| resume \| clear`.
6. Same function `{ provider: "custom" }` and `{ provider: "codex" }` — `/goal`.run is still `goal`.
7. Grok-origin catalog skills (`commandsFromSkills` or a grok mapper) have `run: "grok"`, not `skill`, when building a Grok palette.
8. Custom/Codex/Claude + the same skill row stay `run: "skill"` (desk wrap).
9. Workhorse-owned collisions that must **stay** desk-owned even on Grok: `/new`, `/rename`, `/delete`, `/copy`, `/theme`, `/settings`, `/usage`, `/watch`, `/schedule`, `/fork` (desk fork + existing `grokFork`), `/compact` (desk compact RPC). Do not send those to Grok.
10. `/auto` remains a known collision (accept-edits). Out of this slice unless a Grok chat needs classifier auto — do not “fix” it by accident.
11. `/skills` on Grok is `run: "grok"`. `/create-workflow` is present and `run: "grok"`.
12. Qualified names: if the catalog or `grokCommands` advertises `/local:pdf`, `matchCommand("/local:pdf foo", extras)` hits it and does not strip to `/pdf`.
13. `matchCommand` must not re-steal `/goal` on a Grok extras list. Today `matchCommand` always `mergeCommands(COMMANDS, extras)`, so even a correct palette can lose at match time. Fix merge or pass the session palette without letting desk `/goal` overwrite Grok `/goal`.

### Desk Goal bar

14. On a Grok chat, the bar must not pretend a local `session.goal` is Grok’s driver if Grok never got `/goal`. **Mirror, do not invent:**
    - Set/pause/resume/clear always send the Grok `/goal …` line through the same helper as typing.
    - The bar may show the last objective the user actually sent to Grok (`/goal <objective>`), and hide after `/goal clear`.
    - GoalBar buttons emit `goalCommandForAction(...)` (`/goal pause` etc.) into `send`.
    - Do not keep a local-only active goal on a Grok session that was never forwarded.

### Honest empty / errors

15. If Grok rejects `/goal` or a skill (unknown command, goal mode off, workflows off), the user sees Grok’s failure in the transcript. Do not silently fall back to `goalVendorPrompt` or `invokeSkillPrompt`.

## Out of scope

- Rebuilding Grok’s extensions modal, Agent Dashboard, Rhai author UI, or `/share`
- Passing `--worktree`, `--experimental-memory`, `--json-schema`, or classifier `auto` (see `docs/grok-build-workhorse-gaps.md`)
- Changing MiniMax / Codex / Claude desk `/goal`
- Cloning Grok TUI chrome
- Making `/usage` or `/theme` mean Grok billing / TUI theme

## Likely files

- `src/lib/commands.ts` — Grok `/goal` in `GROK_SHELL_COMMANDS` (or drop desk `/goal` from the Grok merge); skill rows `run: "grok"` on Grok chats; `matchCommand` / `commandsForSession` merge order; add `/create-workflow`
- `src/lib/goal.ts` — keep desk parse/prompt for non-Grok; do not intercept Grok sends
- `src/lib/store.tsx` — send path uses the helper; Grok pause/clear halt **then** send
- `src/ui/GoalBar.tsx` — Grok mirror via send, not local-only apply
- `src/lib/skills-catalog.ts` / `commandsFromSkills` — grok mapper; qualified names if already in the catalog
- `electron/grok-agent.ts` — `extractAvailableCommands` stays `run: "grok"`; no wrap
- `test/workhorse.test.ts`, `test/desk-export.test.ts`, optional `test/grok-goal-skills-live.ts`

## Tests (required, extensive)

Drive **shipped** functions. Do not hard-code expected strings that bypass `commandsForSession` / the send helper. Do not reimplement merge logic in the test.

Flip, do not preserve, the assertions that currently require Grok `/goal` to be desk-owned and Grok `/pdf` to be `run: "skill"`.

### Palette and merge

1. `commandsForSession({ provider: "grok" })` — `/goal`.run is `grok`, not `goal`. `commandContinuesToVendor` is true.
2. Same function `{ provider: "custom" }` and `{ provider: "codex" }` — `/goal`.run is still `goal`. `commandContinuesToVendor` is false.
3. Grok session + catalog skill `{ origin: "grok", name: "pdf" }` — palette has `/pdf` with `run: "grok"`, not `skill`.
4. Custom session + same skill row — `/pdf` stays `run: "skill"`.
5. Codex session + `{ origin: "codex", name: "unity-ui-to-figma" }` — still `run: "skill"` (existing Codex palette test stays true for Codex).
6. Workhorse `/usage`, `/theme`, `/settings`, `/schedule`, `/watch`, `/new`, `/compact` still win on a Grok session (`run` is desk, not `grok`).
7. `/skills` on Grok is `run: "grok"`. `/create-workflow` is `run: "grok"`. `/workflow` and `/workflows` stay `run: "grok"`.
8. Qualified name: `grokCommands` or catalog row named `/local:pdf` — `matchCommand("/local:pdf foo", sessionPalette)` hits that command and does not collapse to `/pdf`.
9. ACP extract: `extractAvailableCommands({ availableCommands: [{ name: "goal", description: "…" }, { name: "local:commit", source: "skill" }] })` still yields `run: "grok"`. After `commandsForSession({ provider: "grok", grokCommands })`, `/goal` remains `grok` and `/local:commit` is present.

### Goal send helper

10. Provider `grok`, text `/goal ship the backlog` — `vendorText === "/goal ship the backlog"`. Not `goalVendorPrompt`. `skipVendor` is false.
11. Provider `grok`, text `/goal --budget 80000 migrate auth` — `vendorText` equals that string, including `--budget`.
12. Provider `custom` (and `codex`), text `/goal ship the backlog` — outgoing text is `goalVendorPrompt` (today’s desk set).
13. Provider `grok`, `/goal pause` — `haltVendor === true` and `vendorText === "/goal pause"` and `skipVendor === false`.
14. Provider `custom`, `/goal pause` — `haltVendor === true` and `skipVendor === true` (no vendor think; today’s halt).
15. Provider `grok`, `/goal` and `/goal status` — sent to Grok as those strings. Not a local-only return.
16. Provider `grok`, bare `/pause` — not treated as desk goal halt (helper does not claim a Grok `/goal pause` unless the text is `/goal pause`).
17. `goalCommandForAction("pause") === "/goal pause"`. On Grok, that string is what the helper forwards.

### Skills send helper

18. `invokeSkillPrompt` is **not** applied when `match.run === "grok"` or when provider is grok and the command is a grok-origin skill.
19. Typed `/pdf make a one-pager` on Grok: `vendorText` is that string.
20. Typed `/pdf make a one-pager` on custom with a workhorse/custom skill named pdf: still `invokeSkillPrompt`.
21. Existing desk-export test “Grok palette merges catalog skills from ~/.grok/skills bundled and plugins” still finds `/pdf` and `/commit` on the Grok palette, then **extend** it: those rows are `run: "grok"` for `{ provider: "grok" }` and still absent as `/local:commit` unless the catalog or `grokCommands` actually has that name.
22. Project folder `{project}/.grok/skills/review` with `origin: "grok"` appears on a Grok palette as `/review` with `run: "grok"`.

### Store wiring (source, not a second implementation)

23. `store.tsx` `send` calls the helper (or equivalently: Grok `/goal` is not assigned `goalVendorPrompt`, and Grok pause does not `return` before a vendor prompt).
24. Pause still runs **before** the live-turn queue branch (`goalHaltsVendor` / `haltVendor` index < `status === "running" && !options?.steer`).
25. After Grok pause, a vendor prompt of `/goal pause` is scheduled (not only a local status flip).

### Regression

26. `mergeCommands(COMMANDS, GROK_SHELL_COMMANDS)` — `/theme` remains Workhorse. `/usage` remains Workhorse. `/auto` remains accept-edits.
27. MiniMax / custom desk `/goal` halt tests still pass (`goalHaltsVendor` on custom; no Grok-only leak).
28. Codex `/skills` stays `run: "vendor"`. Grok `/skills` stays `run: "grok"`.
29. `npx tsx --test test/workhorse.test.ts test/desk-export.test.ts` green.

### Live (if `grok` is on PATH)

30. Optional `test/grok-goal-skills-live.ts` (skip cleanly if Grok is not logged in; do not fail CI on missing login):
    - ACP stdio `session/new` then `session/prompt` with `/goal status`. Child must not be fed a Workhorse “ongoing Workhorse goal” rewrite. Accept Grok’s own “goal mode off” / status reply as success of the **send**.
    - `session/prompt` with `/skills`. Child must receive `/skills`, not a skill-wrapper paragraph.
    - `session/prompt` with `/pdf` or another catalog skill if present. Outgoing prompt text is the slash, not `Use the installed skill`.

## Check

Open a **Grok** chat.

- Type `/goal migrate auth`. The transcript shows that command. Grok treats it as a Grok goal (thought/tools/`update_goal` or the workflow goal driver), not a Workhorse paragraph.
- Type `/goal --budget 50000 ship BACKLOG.md`. The budget flag is still on the line Grok received.
- Pause (bar or `/goal pause`) sends `/goal pause`, the live turn stops, and Grok’s driver stops too.
- Palette or typed `/pdf` (or `/create-skill`) sends that slash, not “Use the installed skill pdf”.
- `/skills`, `/workflow`, `/create-workflow` reach Grok.

Open a **MiniMax** (or Codex) chat. `/goal` still drives the desk bar only. Pause still cancels without a fake vendor think. Skill picks still wrap with `invokeSkillPrompt`.
