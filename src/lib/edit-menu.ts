export type EditFieldState = {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  disabled?: boolean;
  readOnly?: boolean;
};

export type EditMenuAction = "cut" | "copy" | "paste" | "selectAll";

export const EDIT_MENU_ITEMS: { id: EditMenuAction; label: string; shortcut: string }[] = [
  { id: "cut", label: "Cut", shortcut: "Ctrl+X" },
  { id: "copy", label: "Copy", shortcut: "Ctrl+C" },
  { id: "paste", label: "Paste", shortcut: "Ctrl+V" },
  { id: "selectAll", label: "Select All", shortcut: "Ctrl+A" },
];

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
