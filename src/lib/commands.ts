import { parseGoalInput } from "./goal";
import type { Command, DeskSkill, PermissionMode, ProviderId, SandboxProfile, SkillOrigin } from "./types";
import { capabilitiesFor } from "./provider-capabilities";

export const COMMANDS: Command[] = [
  { id: "new", name: "/new", hint: "Back to this project’s home", run: "new", aliases: ["/clear"] },
  { id: "project", name: "/project", hint: "Create a project", run: "project" },
  { id: "link", name: "/link", hint: "Link a folder to this project", run: "link" },
  { id: "providers", name: "/providers", hint: "Choose this chat’s provider and model", run: "providers" },
  { id: "model", name: "/model", hint: "Switch model, e.g. /model grok-4.6", run: "model", aliases: ["/m"] },
  { id: "effort", name: "/effort", hint: "Brain level: low medium high extra", run: "effort" },
  { id: "compact", name: "/compact", hint: "Compress this chat’s context, optional keep-note", run: "compact", inputHint: "what to keep" },
  { id: "ask", name: "/ask", hint: "Ask before tools run", run: "mode:ask" },
  { id: "accept", name: "/accept-edits", hint: "Allow file edits without asking", run: "mode:accept-edits", aliases: ["/auto"] },
  { id: "always", name: "/always-approve", hint: "Skip ordinary permission prompts", run: "mode:always-approve" },
  { id: "plan", name: "/plan", hint: "Plan first — research only, then a reviewable plan", run: "mode:plan" },
  { id: "sandbox", name: "/sandbox", hint: "Sandbox: off, workspace, read-only, or strict", run: "sandbox", inputHint: "off | workspace | read-only | strict" },
  { id: "demo", name: "/demo-permission", hint: "Show a permission prompt", run: "demo-permission" },
  { id: "theme", name: "/theme", hint: "Cycle light, dark, Workhorse, system", run: "theme", aliases: ["/t"] },
  { id: "settings", name: "/settings", hint: "Profile, connected LLMs, usage, watch", run: "settings", aliases: ["/config", "/preferences", "/prefs"] },
  { id: "rename", name: "/rename", hint: "Rename this chat", run: "rename", aliases: ["/title"], inputHint: "new title" },
  { id: "archive", name: "/archive", hint: "Archive this chat", run: "archive" },
  { id: "delete", name: "/delete", hint: "Delete this chat", run: "delete" },
  { id: "copy", name: "/copy", hint: "Copy the latest reply", run: "copy" },
  { id: "fork", name: "/fork", hint: "Branch this chat from the latest turn", run: "fork" },
  { id: "usage", name: "/usage", hint: "Token usage by vendor and model", run: "usage", aliases: ["/cost"] },
  { id: "watch", name: "/watch", hint: "Leftover, daily spend, and send holds", run: "watch" },
  { id: "schedule", name: "/schedule", hint: "Run later or repeat, e.g. /schedule every 30m check build", run: "schedule", inputHint: "[every] 30m prompt" },
  { id: "goal", name: "/goal", hint: "Set or manage a quiet Workhorse goal", run: "goal", inputHint: "objective | status | pause | resume | clear" },
  { id: "quit", name: "/quit", hint: "Close Workhorse", run: "quit", aliases: ["/exit"] },
];

export const CODEX_SHELL_COMMANDS: Command[] = [
  { id: "codex-skills", name: "/skills", hint: "Ask Codex to use an installed skill", run: "vendor", source: "codex" },
  { id: "codex-review", name: "/review", hint: "Review the working tree", run: "vendor", source: "codex" },
];

export const CLAUDE_SHELL_COMMANDS: Command[] = [
  { id: "claude-skills", name: "/skills", hint: "Ask Claude to use an installed skill", run: "vendor", source: "claude" },
];

export function skillSlashName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, "-");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function commandsFromSkills(skills: DeskSkill[], run: Command["run"] = "skill"): Command[] {
  return skills.map((skill) => ({
    id: `skill-${skill.origin}-${skill.name}`,
    name: skillSlashName(skill.name),
    hint: skill.description || `${skill.origin} skill`,
    run,
    source: run === "grok" ? "grok" : "skill",
  }));
}

export function vendorSkillOrigin(provider?: ProviderId | string | null): SkillOrigin | undefined {
  if (provider === "grok" || provider === "codex" || provider === "claude") return provider;
  if (provider === "custom") return "workhorse";
  return undefined;
}

export function invokeSkillPrompt(command: Command, typed: string): string {
  const rest = typed.replace(new RegExp(`^${command.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i"), "").trim();
  const name = command.name.replace(/^\//, "");
  return rest
    ? `Use the installed skill "${name}". Follow its SKILL.md exactly.\n\n${rest}`
    : `Use the installed skill "${name}". Follow its SKILL.md exactly.`;
}

export const GROK_SHELL_COMMANDS: Command[] = [
  { id: "grok-context", name: "/context", hint: "Show what is filling the context window", run: "grok", source: "grok" },
  { id: "grok-session-info", name: "/session-info", hint: "Session details, model, and context", run: "grok", source: "grok", aliases: ["/status", "/info"] },
  { id: "grok-rewind", name: "/rewind", hint: "Roll back to an earlier turn", run: "grok", source: "grok", aliases: ["/undo"] },
  { id: "grok-export", name: "/export", hint: "Export this conversation", run: "grok", source: "grok" },
  { id: "grok-view-plan", name: "/view-plan", hint: "Preview the current saved plan", run: "grok", source: "grok", aliases: ["/show-plan", "/plan-view"] },
  { id: "grok-memory", name: "/memory", hint: "Browse or toggle saved memories", run: "grok", source: "grok", aliases: ["/mem"] },
  { id: "grok-flush", name: "/flush", hint: "Save this session into memory now", run: "grok", source: "grok" },
  { id: "grok-dream", name: "/dream", hint: "Consolidate memories into topics", run: "grok", source: "grok" },
  { id: "grok-remember", name: "/remember", hint: "Save a note to memory", run: "grok", source: "grok", inputHint: "note" },
  { id: "grok-hooks", name: "/hooks", hint: "View and manage hooks", run: "grok", source: "grok" },
  { id: "grok-plugins", name: "/plugins", hint: "Install and manage plugins", run: "grok", source: "grok" },
  { id: "grok-marketplace", name: "/marketplace", hint: "Browse the plugin marketplace", run: "grok", source: "grok" },
  { id: "grok-goal", name: "/goal", hint: "Set or manage a Grok goal", run: "grok", source: "grok", inputHint: "objective [--budget tokens] | status | pause | resume | clear" },
  { id: "grok-skills", name: "/skills", hint: "View installed skills", run: "grok", source: "grok" },
  { id: "grok-create-workflow", name: "/create-workflow", hint: "Author a Grok workflow", run: "grok", source: "grok", inputHint: "name" },
  { id: "grok-imagine", name: "/imagine", hint: "Generate an image", run: "grok", source: "grok", inputHint: "description" },
  { id: "grok-imagine-video", name: "/imagine-video", hint: "Generate a video", run: "grok", source: "grok", inputHint: "description" },
  { id: "grok-loop", name: "/loop", hint: "Run a prompt on a schedule", run: "grok", source: "grok", inputHint: "30m check deploy status" },
  { id: "grok-deep-research", name: "/deep-research", hint: "Start a background research workflow", run: "grok", source: "grok", inputHint: "query" },
  { id: "grok-workflow", name: "/workflow", hint: "Launch or control a workflow", run: "grok", source: "grok", inputHint: "name" },
  { id: "grok-workflows", name: "/workflows", hint: "Open the live workflow run list", run: "grok", source: "grok" },
  { id: "grok-feedback", name: "/feedback", hint: "Send feedback to xAI", run: "grok", source: "grok", inputHint: "message" },
  { id: "grok-btw", name: "/btw", hint: "Ask a side question without breaking the turn", run: "grok", source: "grok", inputHint: "aside" },
  { id: "grok-mcps", name: "/mcps", hint: "Manage MCP servers", run: "grok", source: "grok" },
  { id: "grok-doctor", name: "/doctor", hint: "Check this session for setup issues", run: "grok", source: "grok" },
  { id: "grok-release-notes", name: "/release-notes", hint: "Show Grok release notes", run: "grok", source: "grok", aliases: ["/changelog"] },
  { id: "grok-docs", name: "/docs", hint: "Open Grok how-to guides", run: "grok", source: "grok", aliases: ["/howto", "/guides"] },
  { id: "grok-tutorial", name: "/tutorial", hint: "Open the Grok onboarding tutorial", run: "grok", source: "grok", aliases: ["/tour", "/onboarding"] },
  { id: "grok-import-claude", name: "/import-claude", hint: "Import Claude settings, MCP, and hooks", run: "grok", source: "grok" },
  { id: "grok-config-agents", name: "/config-agents", hint: "Manage agent definitions and personas", run: "grok", source: "grok", aliases: ["/agents"] },
  { id: "grok-personas", name: "/personas", hint: "Create and edit personas", run: "grok", source: "grok" },
  { id: "grok-login", name: "/login", hint: "Log in or re-authenticate Grok", run: "grok", source: "grok" },
  { id: "grok-logout", name: "/logout", hint: "Log out of Grok", run: "grok", source: "grok" },
  { id: "grok-privacy", name: "/privacy", hint: "Coding data, retention, and training", run: "grok", source: "grok" },
  { id: "grok-timestamps", name: "/timestamps", hint: "Toggle message timestamps", run: "grok", source: "grok" },
  { id: "grok-resume", name: "/resume", hint: "Reload a previous Grok session", run: "grok", source: "grok" },
];

function commandKeys(command: Command): string[] {
  return [command.name, ...(command.aliases ?? [])].map((name) => name.toLowerCase());
}

export function mergeCommands(primary: Command[], extra: Command[]): Command[] {
  const taken = new Set<string>();
  const rows: Command[] = [];
  for (const command of [...primary, ...extra]) {
    const keys = commandKeys(command);
    if (keys.some((key) => taken.has(key))) continue;
    for (const key of keys) taken.add(key);
    rows.push(command);
  }
  return rows;
}

export function commandsForSession(
  session?: { provider?: string; grokCommands?: Command[] } | null,
  skills: DeskSkill[] = [],
): Command[] {
  const origin = vendorSkillOrigin(session?.provider);
  const skillRun = session?.provider === "grok" ? "grok" : "skill";
  const skillCmds = origin ? commandsFromSkills(skills.filter((skill) => skill.origin === origin), skillRun) : [];
  const common = capabilitiesFor(session?.provider).conversation.compact === "unavailable"
    ? COMMANDS.filter((command) => command.id !== "compact")
    : COMMANDS;
  if (session?.provider === "grok") {
    const desk = common.filter((command) => command.id !== "goal");
    return mergeCommands(desk, [...GROK_SHELL_COMMANDS, ...(session.grokCommands ?? []), ...skillCmds]);
  }
  if (session?.provider === "codex") return mergeCommands(common, [...CODEX_SHELL_COMMANDS, ...skillCmds]);
  if (session?.provider === "claude") return mergeCommands(common, [...CLAUDE_SHELL_COMMANDS, ...skillCmds]);
  if (session?.provider === "custom") return mergeCommands(common, skillCmds);
  return common;
}

export function filterPalette(query: string, palette: Command[]): Command[] {
  const q = query.replace(/^\//, "").trim().toLowerCase();
  if (!q) return palette;
  return palette.filter((command) => {
    const hay = [command.name, command.hint, command.id, ...(command.aliases ?? [])].join(" ").toLowerCase();
    return hay.includes(q) || command.id.startsWith(q);
  });
}

export function filterCommands(query: string, extras: Command[] = []): Command[] {
  const q = query.replace(/^\//, "").trim().toLowerCase();
  if (!q && extras.length === 0) return COMMANDS;
  return filterPalette(query, mergeCommands(COMMANDS, extras));
}

/** Workhorse-handled runs return; these continue into the attached vendor prompt. */
export function commandContinuesToVendor(run?: string): boolean {
  return run === "vendor" || run === "grok" || run === "skill";
}

/** True when the player sent a Workhorse/vendor slash command (not a normal prompt). */
export function isChatCommand(text: string, extras: Command[] = []): boolean {
  const value = text.trim();
  if (!value.startsWith("/")) return false;
  if (parseGoalInput(value)) return true;
  return Boolean(matchCommand(value, extras));
}

/** Split a /goal line so only the command token is styled. */
export function splitGoalCommand(text: string): { name: string; rest: string } | null {
  const value = text.trim();
  if (!parseGoalInput(value)) return null;
  if (value === "/goal" || value.startsWith("/goal ")) {
    return { name: "/goal", rest: value.slice("/goal".length) };
  }
  return null;
}

function firstCommandMatch(text: string, commands: Command[]): Command | undefined {
  const hits: { command: Command; name: string }[] = [];
  for (const command of commands) {
    for (const name of [command.name, ...(command.aliases ?? [])]) {
      if (text === name || text.startsWith(`${name} `)) hits.push({ command, name });
    }
  }
  hits.sort((left, right) => right.name.length - left.name.length);
  return hits[0]?.command;
}

/** Prefer extras (session palette / Grok rows) so desk `/goal` cannot re-steal a Grok extras list. */
export function matchCommand(text: string, extras: Command[] = []): Command | undefined {
  return firstCommandMatch(text, extras) ?? firstCommandMatch(text, COMMANDS);
}

export function commandNeedsInput(command: Command, typed: string): boolean {
  if (!command.inputHint) return false;
  const names = [command.name, ...(command.aliases ?? [])];
  return names.some((name) => typed === name);
}

export function modeLabel(mode: PermissionMode): string {
  if (mode === "accept-edits") return "Accept edits";
  if (mode === "always-approve") return "Always approve";
  if (mode === "plan") return "Plan";
  return "Ask";
}

export function shortModeLabel(mode: PermissionMode): string {
  if (mode === "accept-edits") return "Accept edits";
  if (mode === "always-approve") return "Always";
  if (mode === "plan") return "Plan";
  return "Ask";
}

export function sandboxLabel(sandbox: SandboxProfile): string {
  if (sandbox === "workspace") return "Workspace";
  if (sandbox === "read-only") return "Read-only";
  if (sandbox === "strict") return "Strict";
  return "Off";
}
