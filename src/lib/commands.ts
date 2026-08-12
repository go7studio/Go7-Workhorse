import type { Command, PermissionMode } from "./types";

export const COMMANDS: Command[] = [
  { id: "new", name: "/new", hint: "Back to this project’s home", run: "new" },
  { id: "project", name: "/project", hint: "Create a project", run: "project" },
  { id: "link", name: "/link", hint: "Link a folder to this project", run: "link" },
  { id: "providers", name: "/providers", hint: "Back to this project’s home", run: "providers" },
  { id: "model", name: "/model", hint: "Switch model, e.g. /model grok-4.6", run: "model" },
  { id: "effort", name: "/effort", hint: "Brain level: low medium high extra", run: "effort" },
  { id: "ask", name: "/ask", hint: "Ask before tools run", run: "mode:ask" },
  { id: "accept", name: "/accept-edits", hint: "Allow file edits without asking", run: "mode:accept-edits" },
  { id: "always", name: "/always-approve", hint: "Skip ordinary permission prompts", run: "mode:always-approve" },
  { id: "demo", name: "/demo-permission", hint: "Show a permission prompt", run: "demo-permission" },
  { id: "theme", name: "/theme", hint: "Cycle light, dark, system", run: "theme" },
  { id: "settings", name: "/settings", hint: "Profile, connected LLMs, usage", run: "settings" },
  { id: "usage", name: "/usage", hint: "Token usage by vendor and model", run: "usage" },
  { id: "quit", name: "/quit", hint: "Close Workhorse", run: "quit" },
];

export function filterCommands(query: string): Command[] {
  const q = query.replace(/^\//, "").trim().toLowerCase();
  if (!q) return COMMANDS;
  return COMMANDS.filter(
    (command) =>
      command.name.toLowerCase().includes(q) ||
      command.hint.toLowerCase().includes(q) ||
      command.id.startsWith(q),
  );
}

export function modeLabel(mode: PermissionMode): string {
  if (mode === "accept-edits") return "Accept edits";
  if (mode === "always-approve") return "Always approve";
  return "Ask";
}
