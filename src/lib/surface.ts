import type { Panel } from "./types";

export type Surface = "settings" | "welcome" | "project-home" | "session";

export function selectSurface(input: {
  panel: Panel;
  hasProject: boolean;
  hasSession: boolean;
}): Surface {
  if (input.panel === "settings") return "settings";
  if (!input.hasProject) return "welcome";
  if (!input.hasSession) return "project-home";
  return "session";
}

export function titlebarLabel(
  projectName?: string | null,
  sessionTitle?: string | null,
  panel?: Panel,
): string {
  if (panel === "settings") return "Settings";
  if (projectName && sessionTitle) return `${projectName}  ·  ${sessionTitle}`;
  return projectName ?? "";
}
