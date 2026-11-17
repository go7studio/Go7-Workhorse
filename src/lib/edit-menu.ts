export type EditFieldState = {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  disabled?: boolean;
  readOnly?: boolean;
};

export type EditMenuAction = "cut" | "copy" | "paste" | "selectAll";

export const EDIT_MENU_ITEMS: { id: EditMenuAction; label: string }[] = [
  { id: "copy", label: "Copy" },
  { id: "cut", label: "Cut" },
  { id: "paste", label: "Paste" },
  { id: "selectAll", label: "Select All" },
];

/** The menu shows the keys this computer actually uses. Ctrl+C is not Copy on a Mac. */
export function editMenuShortcut(id: EditMenuAction, mac: boolean): string {
  const key = id === "copy" ? "C" : id === "cut" ? "X" : id === "paste" ? "V" : "A";
  return mac ? `⌘${key}` : `Ctrl+${key}`;
}

export function editMenuIsMac(platform: string): boolean {
  return /Mac|iPhone|iPad/.test(platform);
}

export function selectedText(field: Pick<EditFieldState, "value" | "selectionStart" | "selectionEnd">): string {
  const start = Math.max(0, Math.min(field.selectionStart, field.selectionEnd));
  const end = Math.max(field.selectionStart, field.selectionEnd);
  return field.value.slice(start, end);
}

export function isFieldEditable(field: Pick<EditFieldState, "disabled" | "readOnly">): boolean {
  return !field.disabled && !field.readOnly;
}

export function canCut(field: EditFieldState): boolean {
  return isFieldEditable(field) && selectedText(field).length > 0;
}

export function canCopy(field: EditFieldState): boolean {
  return selectedText(field).length > 0;
}

export function canPaste(field: EditFieldState): boolean {
  return isFieldEditable(field);
}

export function canSelectAll(field: EditFieldState): boolean {
  return field.value.length > 0;
}

export function applyCut(field: EditFieldState): { value: string; caret: number; cut: string } {
  const start = Math.min(field.selectionStart, field.selectionEnd);
  const end = Math.max(field.selectionStart, field.selectionEnd);
  const cut = field.value.slice(start, end);
  return {
    value: field.value.slice(0, start) + field.value.slice(end),
    caret: start,
    cut,
  };
}

/** A denied clipboard read must not become an empty paste that deletes the selection. */
export async function readClipboardText(read: (() => Promise<string>) | undefined): Promise<string | null> {
  if (!read) return null;
  try {
    return await read();
  } catch {
    return null;
  }
}

/** Null or an empty read leaves the selection alone. */
export function clipboardInsert(text: string | null): string | null {
  if (text == null || text.length === 0) return null;
  return text;
}

export function applyPaste(field: EditFieldState, text: string): { value: string; caret: number } {
  const start = Math.min(field.selectionStart, field.selectionEnd);
  const end = Math.max(field.selectionStart, field.selectionEnd);
  return {
    value: field.value.slice(0, start) + text + field.value.slice(end),
    caret: start + text.length,
  };
}

export function applySelectAll(field: Pick<EditFieldState, "value">): { start: number; end: number } {
  return { start: 0, end: field.value.length };
}

export function clampMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportW: number,
  viewportH: number,
  pad = 8,
): { x: number; y: number } {
  const nextX = Math.min(Math.max(pad, x), Math.max(pad, viewportW - width - pad));
  const nextY = Math.min(Math.max(pad, y), Math.max(pad, viewportH - height - pad));
  return { x: nextX, y: nextY };
}

export function isTextEditElement(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  const type = (el.type || "text").toLowerCase();
  return !["button", "submit", "reset", "checkbox", "radio", "file", "color", "range", "hidden", "image"].includes(type);
}
