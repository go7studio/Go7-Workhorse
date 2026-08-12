import type { Command, PermissionMode } from "./types";

export const COMMANDS: Command[] = [
  { id: "new", name: "/new", hint: "Back to this project’s home", run: "new" },
  { id: "project", name: "/project", hint: "Create a project", run: "project" },
  { id: "link", name: "/link", hint: "Link a folder to this project", run: "link" },
  { id: "providers", name: "/providers", hint: "Show Grok, Claude, Codex, Custom", run: "providers" },
  { id: "ask", name: "/ask", hint: "Ask before tools run", run: "mode:ask" },
  { id: "accept", name: "/accept-edits", hint: "Allow file edits without asking", run: "mode:accept-edits" },
  { id: "always", name: "/always-approve", hint: "Skip ordinary permission prompts", run: "mode:always-approve" },
  { id: "demo", name: "/demo-permission", hint: "Show the permission bar", run: "demo-permission" },
  { id: "theme", name: "/theme", hint: "Cycle light, dark, system", run: "theme" },
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
