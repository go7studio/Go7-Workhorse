import { isDefaultTitle } from "./titles";
import type { Panel } from "./types";

export type Surface = "settings" | "add-bot" | "welcome" | "session" | "project-home";

export function selectSurface(input: {
  panel: Panel;
  hasProject: boolean;
  hasSession: boolean;
}): Surface {
  if (input.panel === "add-bot") return "add-bot";
  if (input.panel === "settings") return "settings";
  if (input.hasSession) return "session";
  if (input.hasProject) return "project-home";
  return "welcome";
}

export function titlebarLabel(
  projectName?: string | null,
  sessionTitle?: string | null,
  panel?: Panel,
): string {
  const named = sessionTitle && !isDefaultTitle(sessionTitle) ? sessionTitle : null;
  if (panel === "add-bot") return "Add a bot";
  if (panel === "settings") return "Settings";
  if (projectName && named) return `${projectName}  ·  ${named}`;
  if (named) return named;
  return projectName ?? "";
}
