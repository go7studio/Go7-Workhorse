export function uid(prefix = "id"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

export function folderName(folder: string): string {
  const parts = folder.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || folder;
}
