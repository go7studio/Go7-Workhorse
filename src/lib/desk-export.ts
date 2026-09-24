import path from "node:path";
import type { ChatMessage, Project, ProviderId, Session } from "./types";

export function vendorExportDirName(provider: ProviderId, botName?: string): string {
  if (provider === "custom") return `workhorse-${slugTitle(botName || "custom", "custom")}`;
  return `workhorse-${provider}`;
}

/** Desktop/Workhorse exports on every OS. Falls back to the home folder if Desktop is missing. */
export function defaultExportRoot(homedir: string, desktopExists = true): string {
  return desktopExists
    ? path.join(homedir, "Desktop", "Workhorse exports")
    : path.join(homedir, "Workhorse exports");
}

export function exportableSessions(
  provider: ProviderId,
  sessions: Session[],
  customBotId?: string,
): Session[] {
  return sessions.filter((session) => {
    if (session.hidden || typeof session.archivedAt === "number") return false;
    if (session.provider !== provider) return false;
    if (provider === "custom" && customBotId) return session.customBotId === customBotId;
    return true;
  });
}

export function slugTitle(title: string, fallback = "chat"): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

export function sessionToMarkdown(session: Session, projectName?: string): string {
  const when = session.messages.at(-1)?.createdAt ?? session.messages[0]?.createdAt;
  const lines = [
    `# ${session.title.trim() || "Untitled chat"}`,
    "",
    `- Vendor: ${session.provider}`,
    `- Model: ${session.model}`,
  ];
  if (projectName) lines.push(`- Project: ${projectName}`);
  if (when) lines.push(`- Updated: ${new Date(when).toISOString()}`);
  lines.push("");
  for (const message of session.messages) {
    const body = visibleTurn(message);
    if (!body) continue;
    const heading = message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : "System";
    lines.push(`## ${heading}`, "", body, "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function visibleTurn(message: ChatMessage): string {
  if (message.kind && message.kind !== "thought") return "";
  const text = message.text.trim();
  return text;
}

export function chatExportFiles(
  provider: ProviderId,
  sessions: Session[],
  projects: Project[],
  customBotId?: string,
): { relPath: string; body: string }[] {
  // Keyed by the file that is written, not the slug: two chats called "notes"
  // and a third called "notes-2" used to share notes-2.md, and the host writes
  // them in turn, so one chat vanished from the export.
  const taken = new Set<string>();
  const files: { relPath: string; body: string }[] = [];
  for (const session of exportableSessions(provider, sessions, customBotId)) {
    const project = session.projectId ? projects.find((item) => item.id === session.projectId) : undefined;
    const folder = project ? slugTitle(project.name, "project") : "_chats";
    const base = slugTitle(session.title, session.id.slice(-8));
    let file = `${base}.md`;
    for (let copy = 2; taken.has(`${folder}/${file}`); copy += 1) file = `${base}-${copy}.md`;
    taken.add(`${folder}/${file}`);
    files.push({
      relPath: `projects/${folder}/${file}`,
      body: sessionToMarkdown(session, project?.name),
    });
  }
  return files;
}
