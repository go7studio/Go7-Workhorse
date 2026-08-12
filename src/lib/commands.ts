import type { Command, PermissionMode } from "./types";

export const COMMANDS: Command[] = [
  { id: "new", name: "/new", hint: "Start a session in this project", run: "new" },
  { id: "project", name: "/project", hint: "Open a project folder", run: "project" },
  { id: "providers", name: "/providers", hint: "Show Grok, Claude, Codex, Custom", run: "providers" },
  { id: "ask", name: "/ask", hint: "Ask before tools run", run: "mode:ask" },
  { id: "accept", name: "/accept-edits", hint: "Allow file edits without asking", run: "mode:accept-edits" },
  { id: "always", name: "/always-approve", hint: "Skip ordinary permission prompts", run: "mode:always-approve" },
  { id: "demo", name: "/demo-permission", hint: "Show the permission bar", run: "demo-permission" },
  { id: "theme", name: "/theme", hint: "Cycle light, dark, system", run: "theme" },
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
