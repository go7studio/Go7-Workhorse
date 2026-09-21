/** Read only target fields, never replacement text, commands, or flags. */
export function explicitToolPath(input: unknown): string {
  if (typeof input === "string") {
    try { input = JSON.parse(input); } catch { return ""; }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const record = input as Record<string, unknown>;
  for (const key of ["path", "file", "file_path", "filePath", "target_file", "targetFile", "filename", "file_name", "relative_path", "relativePath"]) {
    const value = record[key];
    if (typeof value === "string" && isToolPath(value)) return value.trim();
  }
  return "";
}

/** ACP locations occasionally contain an argument summary instead of a path. */
export function isToolPath(value: string): boolean {
  return Boolean(value.trim()) && !/[\r\n]/.test(value) &&
    !/^\s*(?:replace_all|old_string|new_string|old_text|new_text)\s*[:=]/i.test(value);
}
