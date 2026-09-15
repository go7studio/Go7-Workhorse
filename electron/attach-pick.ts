/** Attach dialog shape. Windows cannot mix files and folders in one picker. */

export type AttachKind = "files" | "folder" | "mixed";

export function windowsNeedsAttachChoice(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

export function attachDialogProperties(
  platform: NodeJS.Platform,
  kind: AttachKind,
): Array<"openFile" | "openDirectory" | "multiSelections"> {
  if (kind === "folder") return ["openDirectory"];
  if (kind === "files" || platform === "win32") return ["openFile", "multiSelections"];
  return ["openFile", "openDirectory", "multiSelections"];
}

export function attachDialogTitle(kind: AttachKind): string {
  if (kind === "folder") return "Attach folder";
  if (kind === "files") return "Attach files";
  return "Attach files or folders";
}
