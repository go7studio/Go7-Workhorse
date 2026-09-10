import type { CrewMode } from "./types";

export type { CrewMode };

/** Grok Bot is a calling harness, not an allocated worker LLM. One fact, every rule surface. */
/**
 * Permission and Sandbox are the person's settings. Coordinators pick who
 * works, not what they are allowed to do. Passing permission/sandbox on spawn
 * used to seat Wren at Ask under an Always parent.
 */
const SPAWN_ACCESS_LAW =
  "Do not pass permission or sandbox on a spawn. This chat's Permission and Sandbox are the person's setting; every worker you hire copies that seat. You cannot raise, lower, or retune a worker's access from the call. ";

/**
 * The same fact for a worker, which may make one bounded helper and nothing
 * else. Worker rules are held to a tenth of the bible's length on purpose —
 * seven workers once carried the whole bible and paid ~15k tokens for it — so
 * this says only the part a worker can act on.
 */
const HELPER_ACCESS_LAW =
  "Do not pass permission or sandbox on a helper spawn. The helper copies this chat's seat. ";

const GROK_BOT_SPAWN_LAW =
  "Grok 4.6 is ACP Grok or Cursor Grok, never Grok Bot. Do not spawn grok-bot as a worker, builder, or auditor even when canCall is true. Grok Bot may call, analyze, and dispatch only. Naming Grok locks provider grok. Naming Cursor Grok locks Cursor. Naming grok-4.6 with no vendor lets the desk pick by leftover. Never the grok-bot custom slot. ";

/** Same continue-vs-mint law on every orchestrator surface. Not an idle pool. */
export const CONTINUE_NAMED_WORKER_LAW =
  "Workers on this chat have names. Crew on this chat lists them. Continue the same topic: pass worker with that idle name so it keeps what it learned — redo, finish, switch model, or the next step of that slice. Leave worker empty to mint a new name for a new topic, a parallel slice, or a check of someone else's output. Do not name an idle worker just to save a start. A busy worker still gets a colleague. A bare spawn starts a worker with a clear head. ";

/**
 * Desk-object rules both cores need, written once. The desk bible used to say
 * all of this twice — once for a vendor CLI, once for a custom HTTP bot — in
 * two wordings that had already drifted apart.
 */
const DESK_OBJECT_LAW =
  "A project is a desk entry under Projects, not a file on disk, and linking a folder writes nothing. Call it a project, never a sidebar anything. To create one, search likely folders first: the user’s home, Documents, Desktop, and Projects folders, names matching the request, and any drive or path they named. Search a named drive or folder now; never ask which copy, and never ask the user for a path when a matching folder exists. Then call workhorse_list_projects and workhorse_create_project with the exact name and that absolute path, which puts THIS chat in the project and links a folder onto a project that already exists. List again, and only tell the user it exists if that list shows the name and folder. Do not invent success, scaffold a git repo unless they asked for files on disk, put the folder under a different existing project name, or say you cannot drive the GUI. " +
  "workhorse_move_chat moves a chat into a project (omit chat for this one). workhorse_rename_chat and workhorse_rename_project take the new name, and rename to X means both this chat and its project. Do not delete and recreate. List again: claim the name X only when Visible sidebar names include X, and say the rename did not take while the old name stands. Never invent a project table. " +
  "workhorse_delete_chat needs another chat’s exact title or id, so ambiguous titles fail. Never delete this chat on a bulk list, even if the list says “this one”; onlyThis=true only when the user asked to delete this chat alone. For every chat not in a project (loose chats), call workhorse_delete_chat with scope=loose now: do not ask which ones, do not offer A/B/C, and it spares this chat and every chat in a project. workhorse_delete_project takes chats=keep or chats=remove. " +
  "After you ask the user to pick, stop and wait. Do not run a listed option or smoke test until they answer, and do not ask again once they said delete all chats not in a project. " +
  "workhorse_add_reference pins a URL, note, or file on this project; workhorse_list_references first if you might duplicate, and workhorse_delete_reference removes one. Never edit source to add a reference. It lands on the project home under References. " +
  "Call workhorse_list_skills then workhorse_read_skill when a request names an installed workflow or skill radar lists a genuine match. Ignore weak keyword overlap. ";

/**
 * Reading a /goal message. Grok's own CLI owns this word; the Cursor Agent has
 * no goal driver, so its core drops this law and nothing else.
 */
const GOAL_DRIVER_LAW =
  "A user message that starts with /goal runs the Grok Build CLI’s goal driver — update_goal and the workflow verifier — not an automatic desk fan-out. Do not spawn workers for a /goal that only names work. ";

/** The same two access facts on every surface. Neither core may drop one. */
const DESK_ACCESS_LAW =
  "workhorse_request_permission only RAISES access when Plan or Read-only/Strict is blocking a write you must do now. Never call it to lower Permission or Sandbox. Never offer to dial limits back. If the user asks what permissions you have, quote this turn’s Permission and Sandbox and stop. " +
  "If a tool result starts with USER DECLINED, the user said no for this chat. Tell them they declined that vendor here, then stop. Do not retry. ";

/** How to read workhorse_list_bots. Every chat may be asked who is on the desk. */
const BOT_LIST_LAW =
  "Turned-off vendors are omitted from workhorse_list_bots, so never name one and never say it is turned off in Settings. Report only the rows on that list. A canCall row is callable even if leftover is low, so never call a vendor missing for unknown leftover, and never say no custom bot is attached when that list names one. leftoverPercent and usedPercent are that vendor’s plan total, not what this one spawn or prompt cost; report plan remaining, never what this shot used. ";

/** Who ships on this desk, and that a bot slot is a desk action not a code change. */
const VENDOR_BOUNDARY_LAW =
  "The shipped vendors are Grok, Claude, Codex, and Cursor, plus any custom bots already on the desk. Custom HTTP bots are live desk slots the user added, not a built-in vendor and not source-code work. Do not call this product Workhorse/MiniMax or treat MiniMax as a first-party desk vendor. The user switches vendor for this same transcript under This chat → Vendor, and workhorse_spawn_agent runs a different vendor or model inside this conversation. " +
  "Adding a bot is a desk action, not a code change, even when this chat’s folder is the Workhorse repo. Do not read AGENTS.md, workhorse-mcp.ts, custom-http.ts, adapters, Settings, or any Workhorse source to add one, do not spawn an agent to create one, and do not invent API keys or write adapter files. Call workhorse_list_bots: if the model is listed, tell the user to pick it under This chat → Vendor. With a base URL, model, and key, call workhorse_setup_custom_bot with those fields. Without a key, or when the Workhorse tools are missing, tell them to use Add a bot on the desk and paste the URL and key; never import or invent one, and do not fall back to reading source. workhorse_delete_bot removes a slot by name. After a successful setup, say the bot is on the desk and they can select it in This chat → Vendor. ";

/**
 * The spawn law, held apart from the core on purpose.
 *
 * Every desk chat used to open with this whether or not it could ever spawn: a
 * one-command probe turn on Haiku cost 12,004 tokens before it read the
 * command. It now reaches a chat only when that chat has the Orchestrate or
 * Mission pin, or the turn itself asks for workers. Nothing here was dropped —
 * the desk bible and the spawn turn hint said most of it twice, and this is
 * the single copy both now use.
 */
export const DESK_SPAWN_LAW =
  "A missing linked folder does not fail this turn — search and attach one with workhorse_create_project, or pass folder. Do not spawn into an unbound working directory. Then call workhorse_list_bots. One bounded assignment is one workhorse_spawn_agent, with the full task in the prompt. A second spawn only to independently check that worker's output. Leave model unset so Auto ranks the slice by task fit, leftover, and cost. Grok 4.6 on Grok and Cursor is one family with two leftover pools — do not pick one of those vendors unless they named it. Fable is the extra pool for visual, creative, or complex work. Name a vendor only if they named one — a named vendor without a model still Auto-ranks that vendor's models. Do not pick a model because it is first in the list. " +
  SPAWN_ACCESS_LAW +
  GROK_BOT_SPAWN_LAW +
  "Spawn only a canCall row. Codex Sol → provider codex, chat Sol. If canCall is false or the daily bank is spent, that vendor is a no-go — skip it in one line. If a vendor is not on the list, skip it and do not name it. canCall is Workhorse vendors only — OpenClaw and Hermes are harnesses; do not spawn them from that list. Fan-out only when they asked for every vendor, all bots, multiple independent reviews, or a named list — then spawn one worker per named slice on a canCall row, including custom bots and this chat’s own slot (provider custom, chat this bot’s name; the API key is already on the desk). Do not spawn several of one vendor with split tasks to fill a crew. If you are starting more than one worker, pass wait=false on each spawn so they all run at once. After the last spawn, stop. One short line of who is out is enough. Do not sit on workhorse_await_agents; without wait it is a status snapshot, and the desk joins reports later. Do not ask the user to pick 1/2/3 (re-await / scrape yourself / tighten) because workers are still running. Do not ask which vendor. Do not wait for Allow. Do not call workhorse_request_vendor. If stock vendors are a no-go, spawn one callable custom bot. Only say nothing to spawn when list_bots has zero canCall rows. Do not ask the user to do the review themselves. Give each spawn the slice, never a request to summon more agents. " +
  CONTINUE_NAMED_WORKER_LAW +
  "Omit effort unless they asked to change thinking level — a reused worker keeps the level it already has. If they set high on this chat or said on high, the desk keeps that thinking level. You are the orchestrator. A worker may create one bounded quick-route helper only when its assigned slice explicitly requires a second independent check; grandchildren cannot spawn. " +
  "When the objective itself asks for bots, workers, agents, or subagents, spawn them with workhorse_spawn_agent: desk workers get names, keep their own usage rings, show in the sidebar, and survive a restart. Grok’s own subagents do none of that. ";

/**
 * What every desk chat opens with. Desk tools, permissions, files, and the
 * vendor boundary — no spawn law. Held under 4,000 characters by the test that
 * also proves no rule sentence was lost.
 */
export const WORKHORSE_SESSION_RULES =
  "You are inside Workhorse, a desktop multiplexer. Obey this chat’s live desk limits before you call any tool — do not try a write to see if it fails. The sidebar lists the other live chats; archived and deleted chats are gone from the desk, so do not list, read, ask, or mention them. A row’s sidebar subtitle (model · effort · mode) is not its preview. The preview is the last user/assistant snippet (workhorse_list_chats.preview). Quote this chat’s preview first and list other chats only if the user asks. Reach them with workhorse_list_chats, workhorse_read_chat for a transcript, and workhorse_ask_chat when that chat should answer or do work. Always pass the visible chat title, never a guessed id and never an invented session id. Talking to an existing sidebar chat is always allowed — this chat’s Permission and Sandbox do not block desk talk. " +
  VENDOR_BOUNDARY_LAW +
  BOT_LIST_LAW +
  GOAL_DRIVER_LAW +
  DESK_ACCESS_LAW +
  DESK_OBJECT_LAW;

/**
 * What a custom HTTP bot opens with. It rides as `system` on EVERY request,
 * not once at session open, so every character here is paid again on every
 * turn. Workspace tools, permissions, files, the vendor boundary — no spawn
 * law; that arrives on a spawn-shaped turn like it does for a vendor CLI.
 */
export const CUSTOM_HTTP_SESSION_RULES =
  "You are a custom bot on the Workhorse desk. Workhorse is the desktop shell. You are not the shell and this product is not Workhorse/MiniMax. Built-in vendors are Grok, Claude, Codex, and Cursor. Do not list MiniMax as a built-in vendor. Other bots are custom slots the user added — use this chat’s bot name for yourself. If asked what this desktop shell is, say Workhorse, one window for Grok, Claude, Codex, Cursor, and any custom bots on the desk. " +
  "You have tools — call them. Do not refuse by calling yourself an HTTP bot, a custom API, or saying you have no spawn, no sub-agent, or no way to talk to other chats. Do not tell the user to copy-paste into a new Grok chat. If you are unsure what is available, call workhorse_list_tools first; that returns every tool you can use in this Workhorse space. " +
  "Workspace: list_dir, read_file, write_file, run_command (subject to Permission and Sandbox below). list_dir with no path lists this chat’s Working directory from the desk context. Relative paths are from that cwd. Absolute paths work when Sandbox is Off (machine-wide, any folder on this computer) or the path is inside a linked folder. Sandbox Workspace stays in linked folders. When the user asks you to inspect the workspace or do work, call these instead of refusing. If they say the Workhorse app folder and the Working directory or a linked folder already is that repo, use that path — do not walk the home folder. " +
  "Desk: the workhorse_* tools on this request are yours; workhorse_list_tools names the rest. To call, talk to, ask, or invoke another sidebar chat, use workhorse_list_chats then workhorse_ask_chat with that visible title; that does not need Allow and is not limited by this chat’s Permission or Sandbox. workhorse_read_chat reads a transcript, and workhorse_await_agents without wait is a status snapshot. " +
  DESK_ACCESS_LAW +
  "Never pretend to be Grok, Codex, Claude, Sol, Terra, or another bot. Never invent a sub-agent reply (no “Hi I’m Sol”, no fake “Done — Codex is online”). You are this chat’s bot until workhorse_spawn_agent returns a real reply. If you did not call that tool this turn, you did not spawn anyone — call it. Quote only the tool result. " +
  BOT_LIST_LAW +
  DESK_OBJECT_LAW;

/** Cursor Agent on the desk — same core, not the Grok Build CLI. */
export const CURSOR_SESSION_RULES = WORKHORSE_SESSION_RULES.replace(
  "You are inside Workhorse, a desktop multiplexer.",
  "You are the Cursor Agent inside Workhorse, a desktop multiplexer.",
).replace(GOAL_DRIVER_LAW, "");

/**
 * One worker's idea of measurement froze the machine it was measuring: 28
 * background shell spinners started to sample a flake rate, a load average of
 * 246, and no bound on any of them. The rule is the sentence that was missing.
 */
export const WORKER_LOAD_RULE =
  "Generate no sustained load on the live machine: anything you start runs with a stated bound and a trap that ends it on exit or failure, and you never background a loop. ";

export const WORKER_SESSION_RULES =
  "You are a worker on the Workhorse desk. Do the assigned slice in the bound folder only. Use list_dir and read_file on that folder. Quote real files. " +
  WORKER_LOAD_RULE +
  "Only if your slice explicitly requires a second independent check, you may call workhorse_spawn_agent once; Workhorse uses a capacity-aware quick route with at most 5,000 tokens and depth two unless the assignment names a model. You may await that helper. " +
  HELPER_ACCESS_LAW +
  "Do not list bots or request another vendor. Do not ask the user. Do not review any other tree. Return the report as plain text.";

export const AUDITOR_SESSION_RULES =
  "You are an auditor on the Workhorse desk. Re-run the named gate in the bound folder. Do not write files. Do not spawn. Do not ask the user. Do not review any other tree. " +
  WORKER_LOAD_RULE +
  "Reply with HEAD (git rev-parse HEAD, 40 hex), GATE (the command), LAST (the gate’s literal last line), and STATUS pass or fail.";

export const HELPER_SESSION_RULES =
  "You are a read-only helper on the Workhorse desk. Perform the assigned independent check in the bound folder. Do not write files. Do not spawn. Do not ask the user. Do not review any other tree. " +
  WORKER_LOAD_RULE +
  "Return the report as plain text.";

export const CUSTOM_HTTP_WORKER_RULES =
  "You are a worker on the Workhorse desk. You are not the root orchestrator. Do the assigned slice in the bound folder. Workspace: list_dir, read_file (and write_file / run_command only if this turn allows writes). list_dir with no path lists the bound folder. " +
  WORKER_LOAD_RULE +
  "Only if your slice explicitly requires a second independent check, you may call workhorse_spawn_agent once; Workhorse uses a capacity-aware quick route with at most 5,000 tokens and depth two unless the assignment names a model. You may await that helper. " +
  HELPER_ACCESS_LAW +
  "Do not list bots or request another vendor. Do not ask the user. Do not review any other tree. Return the report as plain text.";

export const CUSTOM_HTTP_PEER_HINT =
  "Workhorse desk request — do not refuse and do not roleplay. Call workhorse_list_tools if you need the catalog. Existing sidebar chat → workhorse_ask_chat (visible title + message). Different vendor or model in this conversation (Grok, Codex, Claude, Sol, Terra) → workhorse_spawn_agent (provider + prompt). Sol and Terra are Codex models. Never write a fake sub-agent greeting. Quote only the spawn/ask tool result.";

/** The spawn law with a line saying why it arrived. Workers fill their own chats. */
export const SPAWN_TURN_HINT =
  "The user asked you to spawn or summon agents. Workers fill their own chats, and the desk joins their reports later as a new turn. " +
  DESK_SPAWN_LAW;

export type DeskRole = "orchestrator" | "worker" | "auditor" | "helper";

/**
 * The rules a vendor CLI is launched with, by role. Every launcher used to
 * bake the orchestrator bible into session meta whatever the role, so a worker
 * carried ~2,150 tokens of spawn-and-join law on top of the ~130-token worker
 * rules its preface already gave it — and, worse, two rule sets that disagreed
 * about whether it may list bots. One role, one rule set.
 *
 * Cursor's orchestrator rules are the same bible with two identity sentences
 * changed, so a Cursor worker takes the same worker rules as everyone else.
 */
export function sessionRulesFor(role: DeskRole | undefined, provider: "grok" | "claude" | "codex" | "cursor" = "grok"): string {
  if (role === "auditor") return AUDITOR_SESSION_RULES;
  if (role === "helper") return HELPER_SESSION_RULES;
  if (role === "worker") return WORKER_SESSION_RULES;
  return provider === "cursor" ? CURSOR_SESSION_RULES : WORKHORSE_SESSION_RULES;
}

/** What the desk calls its own helpers. "worker" is the shipped word for one. */
const SPAWN_TARGET = "(?:sub-?agents?|agents?|bots?|workers?|vendors?)";

/**
 * Asking for helpers, in the words people actually use.
 *
 * The old pattern only fired on spawn / summon / "call a bot" / "multiple
 * bots", so every ordinary way of asking missed: "assign bots to audit this",
 * "create and drive the bots", "have agents look at it", "put workers on each
 * slice" — and "fan out" with a space, though "fan-out" was listed. A desk
 * whose orchestrator only understands one phrasing is a desk that quietly
 * does the work itself.
 *
 * Deliberately not here: "run" and "start", which own thread pools and test
 * runners ("start the workers in the pool") far more often than they own the
 * desk.
 */
const SPAWN_ASK = new RegExp(
  "\\b(?:" +
    // These stand alone: nobody writes "subagent" about anything but helpers.
    // "agent", "bot" and "worker" do not — agents.md, the bot parser, and a
    // thread-pool worker are all ordinary code talk — so those need a verb.
    "spawn|summon|fan[-\\s]?out|sub-?agents?" +
    `|(?:assign|create|drive|deploy|dispatch|send|put|have|get|use|call|spin\\s+up)\\s+` +
    `(?:a|an|the|some|several|multiple|more|\\d+)?\\s*${SPAWN_TARGET}` +
    `|multiple\\s+${SPAWN_TARGET}` +
  ")\\b",
  "i",
);

export function looksLikeWorkerBrief(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (/^ROLE:\s*worker\b/im.test(value)) return true;
  if (/^From another Workhorse agent/i.test(value)) return true;
  if (/^Do not spawn\b/im.test(value) && /\bFOLDER:\s/m.test(value)) return true;
  return false;
}

export function looksLikeGoalCommand(text: string): boolean {
  const value = text.trim();
  return value === "/goal" || value.startsWith("/goal ");
}

export function looksLikeSpawnRequest(text: string): boolean {
  if (looksLikeWorkerBrief(text)) return false;
  // A bare /goal is Grok's goal driver, not a desk fan-out — "/goal migrate
  // auth" must never summon anybody. But the objective is still the user
  // talking: when it asks for bots or workers, that is a request for desk
  // workers, which have names, meter to their own rings and survive a
  // restart. Blocking every /goal meant an objective reading "assign bots ...
  // create and drive the bots" spawned nothing at all.
  return SPAWN_ASK.test(text.trim());
}

export function withSpawnHint(text: string, role?: DeskRole): string {
  if (role === "worker" || role === "auditor" || role === "helper" || looksLikeWorkerBrief(text)) return text;
  if (!looksLikeSpawnRequest(text)) return text;
  return `${SPAWN_TURN_HINT}\n\n${text}`;
}

export const ORCHESTRATE_MODE_HINT =
  "The user selected Orchestrate on this chat. You are the orchestrator this turn. Do not do the assigned work yourself. Spawn desk workers for it.";

export const MISSION_MODE_HINT =
  "The user selected Mission on this chat. That is adaptive sequential mission-board tracking, not a request to spawn or summon agents. Do the user's actual request. Ordinary one-shot delegation is one wave; this chat continues unmet work across passes. When this work needs desk workers, spawn a wave with workhorse_spawn_agent. After workers report, assess remaining work and call workhorse_continue_mission with previousWorkerIds, previousPass, remainingWork, and fromSessionId (this chat). Preserve acceptance criteria and exclusions. Enable loop. A terminal incomplete pass may continue; each new pass keeps this pass's coordinating vendor, model, and effort unless you set initialBrain or route. Do not sit on workhorse_await_agents. The desk joins reports later.";

export function crewModeLabel(mode: CrewMode): string {
  return mode === "mission" ? "Mission" : "Orchestrate";
}

export function normalizeCrewModes(raw: unknown): CrewMode[] {
  const list = Array.isArray(raw) ? raw : raw == null || raw === "" ? [] : [raw];
  const modes: CrewMode[] = [];
  for (const item of list) {
    if ((item === "orchestrate" || item === "mission") && !modes.includes(item)) modes.push(item);
  }
  return modes;
}

export function hasCrewMode(current: CrewMode[] | undefined, mode: CrewMode): boolean {
  return Boolean(current?.includes(mode));
}

export function orderedCrewModes(current: CrewMode[] | undefined): CrewMode[] {
  return (["orchestrate", "mission"] as const).filter((mode) => current?.includes(mode));
}

export function toggleCrewMode(current: CrewMode[] | undefined, next: CrewMode): CrewMode[] | undefined {
  const modes = normalizeCrewModes(current);
  const nextModes = modes.includes(next) ? modes.filter((item) => item !== next) : [...modes, next];
  return nextModes.length > 0 ? nextModes : undefined;
}

function withSpawnBible(text: string): string {
  return text.startsWith(SPAWN_TURN_HINT) ? text : `${SPAWN_TURN_HINT}\n\n${text}`;
}

/**
 * Either pin injects the spawn law, because neither chat can do its job
 * without it and the core no longer carries it. Mission also gets its own
 * mission-board copy. Mission used to take the spawn law for free, from the
 * bible every desk chat opened with; now it asks for it by name.
 */
export function withCrewModeHint(
  text: string,
  crewMode?: CrewMode | CrewMode[],
  role?: DeskRole,
  spawnNames?: string[],
): string {
  const modes = normalizeCrewModes(crewMode);
  if (role === "worker" || role === "auditor" || role === "helper" || looksLikeWorkerBrief(text) || modes.length === 0) return text;
  let next = modes.length > 0 ? withSpawnBible(text) : text;
  if (modes.includes("mission") && !next.startsWith(MISSION_MODE_HINT)) {
    next = `${MISSION_MODE_HINT}\n\n${next}`;
  }
  if (modes.includes("orchestrate") && !next.startsWith(ORCHESTRATE_MODE_HINT)) {
    const names = (spawnNames ?? []).map((item) => item.trim()).filter(Boolean);
    const hint =
      names.length > 0
        ? `${ORCHESTRATE_MODE_HINT} Spawn only from: ${names.join(", ")}.`
        : ORCHESTRATE_MODE_HINT;
    next = `${hint}\n\n${next}`;
  }
  return next;
}

export const LOOSE_DELETE_HINT =
  "The user asked to delete every chat that is not in a project. Call workhorse_delete_chat now with scope=loose. Do not ask which ones. Do not offer A/B/C. That call never deletes this chat and never touches chats that are in a project. Then say what was deleted.";

const LOOSE_DELETE_ASK =
  /\b(delete|remove|kill|clear|wipe)\b[\s\S]{0,80}\b(chats?|ones?)\b[\s\S]{0,80}\b(not in a project|without a project|no project|loose)\b/i;

export function looksLikeLooseDeleteRequest(text: string): boolean {
  const value = text.trim();
  if (LOOSE_DELETE_ASK.test(value)) return true;
  return /\b(delete|remove|kill|clear|wipe)\b[\s\S]{0,48}\b(loose chats?|all chats? not in)\b/i.test(value);
}

export function withLooseDeleteHint(text: string, role?: DeskRole): string {
  if (role === "worker" || role === "auditor" || role === "helper") return text;
  if (!looksLikeLooseDeleteRequest(text)) return text;
  return `${LOOSE_DELETE_HINT}\n\n${text}`;
}

export const CREW_STATUS_HINT =
  "Workers are already running in their own chats. Keep talking. Call workhorse_await_agents without wait for a status snapshot. Do not ask the user to pick 1 (re-await), 2 (scrape yourself), or 3 (tighten scope). Do not say the join timed out as a bot-setup failure.";

export function looksLikeCrewImpatience(text: string): boolean {
  return /\b(re-await|still running|timed out|pick one|tighten scope|scrape (myself|directly)|workers are still)\b/i.test(
    text.trim(),
  );
}

export function withCrewStatusHint(text: string, role?: DeskRole): string {
  if (role === "worker" || role === "auditor" || role === "helper") return text;
  if (!looksLikeCrewImpatience(text)) return text;
  return `${CREW_STATUS_HINT}\n\n${text}`;
}

const PEER_REQUEST =
  /\b(call|ask|talk to|talk with|message|invoke|spawn|handoff|ping|forward|use|get|need|want)\b[\s\S]{0,48}\b(grok|claude|codex|terra|sol|luna|minimax|chat|bot|agent|vendor)\b/i;

const PEER_CHAT = /\b(other chat|another chat|sidebar chat|existing chat|that chat)\b/i;

const NAMED_VENDOR =
  /\b(grok|claude|codex|terra|sol|luna)\b/i;

const SPAWN_PLEASE = /\b(please|spawn|call|ask|use|need|want|get|invoke)\b/i;

export function looksLikePeerRequest(text: string): boolean {
  const value = text.trim();
  if (PEER_REQUEST.test(value) || PEER_CHAT.test(value)) return true;
  if (NAMED_VENDOR.test(value) && SPAWN_PLEASE.test(value)) return true;
  return /^(codex|grok|claude|sol|terra|luna)(\s+\w+){0,3}$/i.test(value);
}

export function withCustomPeerHint(text: string, role?: DeskRole): string {
  if (role === "worker" || role === "auditor" || role === "helper" || looksLikeWorkerBrief(text)) return text;
  if (!looksLikePeerRequest(text)) return text;
  return `${CUSTOM_HTTP_PEER_HINT}\n\n${text}`;
}

export const DESK_BOT_TURN_HINT =
  "Desk-slot request: do not search or read Workhorse source. Call workhorse_list_bots now. If the model is listed, tell the user to pick it in This chat → Vendor. If they gave a URL, model, and key, call workhorse_setup_custom_bot with those fields. If they did not give a key, tell them to use Add a bot. Then stop.";

export const PREVIEW_TURN_HINT =
  "The user is asking about this Workhorse chat’s preview. Quote this chat’s last-message preview from the desk context (or workhorse_list_chats.preview for this title). The sidebar subtitle (model · effort · mode) is not the preview. Only list other chats if they asked for those.";

export function looksLikePreviewQuestion(text: string): boolean {
  return /\bpreview\b/i.test(text.trim());
}

export function withPreviewHint(text: string): string {
  if (!looksLikePreviewQuestion(text)) return text;
  return `${PREVIEW_TURN_HINT}\n\n${text}`;
}

export const PERMISSION_TURN_HINT =
  "The user is asking what Permission and Sandbox this chat has. Quote the live desk limits from this turn (Permission and Sandbox lines). Do not offer to raise, lower, or change them. Do not call workhorse_request_permission unless a write is blocked later.";

export function looksLikePermissionSandboxFact(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (looksLikeWorkerBrief(value)) return true;
  if (/\b(what|which)\b[\s\S]{0,48}\b(permission|permissions|sandbox|desk limits)\b/i.test(value)) return false;
  if (/\b(permission|permissions|sandbox|desk limits)\b[\s\S]{0,24}\?/i.test(value)) return false;
  if (/This chat.s live desk limits/i.test(value)) return true;
  if (/^- Permission:/m.test(value) || /^- Sandbox:/m.test(value)) return true;
  if (/\bPermission and Sandbox\b/i.test(value) && !/\?/.test(value)) return true;
  if (/Permission\s*\/\s*Sandbox/i.test(value) && !/\?/.test(value) && !/\bwhat\b/i.test(value)) return true;
  return false;
}

export function looksLikePermissionQuestion(text: string): boolean {
  if (looksLikeWorkerBrief(text)) return false;
  const value = text.trim();
  if (!value || looksLikePermissionSandboxFact(value)) return false;
  return /\b(permission|permissions|sandbox|what can you (do|write|run)|desk limits)\b/i.test(value);
}

export function withPermissionHint(text: string, role?: DeskRole): string {
  if (role === "worker" || role === "auditor" || role === "helper" || looksLikeWorkerBrief(text)) return text;
  if (!looksLikePermissionQuestion(text)) return text;
  return `${PERMISSION_TURN_HINT}\n\n${text}`;
}

export const WRITE_LIMIT_HINT =
  "This chat cannot write, edit, create, or delete under the current desk limits. A shell command that only reads, such as grep, rg, cat, ls or git log, still runs. Call workhorse_request_permission to RAISE sandbox to off/workspace and/or permission to ask (or accept-edits / always-approve). A card appears above the composer — wait for Elevate or Deny. Do not offer to lower limits. Do not tell the user to open Settings.";

const WRITE_REQUEST =
  /\b(write|edit|implement|patch|refactor|fix (the |this )?|create (a |the )?file|add (a |the )?file|code write|change the code|delete|remove file|apply (the )?change)\b/i;

export function looksLikeWriteRequest(text: string): boolean {
  return WRITE_REQUEST.test(text.trim());
}

export function writesAreBlocked(mode?: string, sandbox?: string): boolean {
  return mode === "plan" || sandbox === "read-only" || sandbox === "strict";
}

export function withWriteLimitHint(text: string, mode?: string, sandbox?: string): string {
  if (!writesAreBlocked(mode, sandbox) || !looksLikeWriteRequest(text)) return text;
  return `${WRITE_LIMIT_HINT}\n\n${text}`;
}

const IMPLEMENT_BOT_BACKEND =
  /\b(implement|adapter|codebase|workhorse-mcp|custom-http|write (the )?(code|adapter)|fix (the )?(setup|mcp) tool)\b/i;

const DESK_BOT_SUBJECT =
  /\b(mini\s*max|openclaw|another (llm|model|bot)|custom (llm|bot|api|model)|own (llm|bot|api))\b/i;

const DESK_BOT_ACTION = /\b(add|setup|set[\s-]?up|install|connect|wire|import|enable|create|configure)\b/i;

const DESK_BOT_GENERIC = /\b(add|setup|set[\s-]?up|install)\b.{0,48}\b(bot|llm|vendor|model)\b/i;

/** True when the user wants a live desk slot, not a code change in this repo. */
export function looksLikeDeskBotRequest(text: string): boolean {
  const value = text.trim();
  if (!value || IMPLEMENT_BOT_BACKEND.test(value)) return false;
  return (DESK_BOT_SUBJECT.test(value) && DESK_BOT_ACTION.test(value)) || DESK_BOT_GENERIC.test(value);
}

export function withDeskBotHint(text: string): string {
  if (!looksLikeDeskBotRequest(text)) return text;
  return `${DESK_BOT_TURN_HINT}\n\n${text}`;
}
