import { useEffect, useRef, useState } from "react";
import {
  applyCut,
  applyPaste,
  applySelectAll,
  canCopy,
  canCut,
  canPaste,
  canSelectAll,
  clampMenuPosition,
  EDIT_MENU_ITEMS,
  isTextEditElement,
  selectedText,
  type EditFieldState,
  type EditMenuAction,
} from "../lib/edit-menu";

type MenuState = {
  x: number;
  y: number;
  field: HTMLInputElement | HTMLTextAreaElement | null;
  start: number;
  end: number;
  snapshot: EditFieldState;
  pageSelected: string;
};

function fieldState(el: HTMLInputElement | HTMLTextAreaElement): EditFieldState {
  return {
    value: el.value,
    selectionStart: el.selectionStart ?? el.value.length,
    selectionEnd: el.selectionEnd ?? el.value.length,
    disabled: el.disabled,
    readOnly: el.readOnly,
  };
}

function resolveField(target: EventTarget | null): HTMLInputElement | HTMLTextAreaElement | null {
  if (!(target instanceof Element)) return null;
  if (isTextEditElement(target)) return target;
  const composer = target.closest(".composer");
  const inComposer = composer?.querySelector("textarea");
  if (inComposer && isTextEditElement(inComposer)) return inComposer;
  const nested = target.closest("textarea, input");
  return isTextEditElement(nested) ? nested : null;
}

function writeField(el: HTMLInputElement | HTMLTextAreaElement, value: string, caret: number) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
  el.setSelectionRange(caret, caret);
}

export function EditContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const open = (event: MouseEvent) => {
      const field = resolveField(event.target);
      const pageSelected = window.getSelection()?.toString() ?? "";
      if (!field && !pageSelected) return;
      event.preventDefault();
      const snapshot = field
        ? fieldState(field)
        : { value: pageSelected, selectionStart: 0, selectionEnd: pageSelected.length };
      const nextMenu = {
        x: event.clientX,
        y: event.clientY,
        field,
        start: snapshot.selectionStart,
        end: snapshot.selectionEnd,
        snapshot,
        pageSelected: field ? selectedText(snapshot) : pageSelected,
      };
      setActive(0);
      setMenu(nextMenu);
    };
    document.addEventListener("contextmenu", open);
    return () => document.removeEventListener("contextmenu", open);
  }, []);

  const run = async (action: EditMenuAction, current: MenuState) => {
    const field = current.field;
    if (field && document.contains(field)) {
      field.focus();
      field.setSelectionRange(current.start, current.end);
      const live = { ...fieldState(field), selectionStart: current.start, selectionEnd: current.end };
      if (action === "cut" && canCut(live)) {
        const next = applyCut(live);
        await navigator.clipboard?.writeText(next.cut).catch(() => undefined);
        writeField(field, next.value, next.caret);
      } else if (action === "copy" && canCopy(live)) {
        await navigator.clipboard?.writeText(selectedText(live)).catch(() => undefined);
      } else if (action === "paste" && canPaste(live)) {
        const text = (await navigator.clipboard?.readText().catch(() => "")) ?? "";
        const next = applyPaste(live, text);
        writeField(field, next.value, next.caret);
      } else if (action === "selectAll" && canSelectAll(live)) {
        const next = applySelectAll(live);
        field.focus();
        field.setSelectionRange(next.start, next.end);
      }
    } else if (action === "copy" && current.pageSelected) {
      await navigator.clipboard?.writeText(current.pageSelected).catch(() => undefined);
    }
    setMenu(null);
  };

  useEffect(() => {
    if (!menu) return;
    const frame = window.requestAnimationFrame(() => {
      const node = box.current;
      if (!node) return;
      const next = clampMenuPosition(
        menu.x,
        menu.y,
        node.offsetWidth,
        node.offsetHeight,
        window.innerWidth,
        window.innerHeight,
      );
      if (next.x !== menu.x || next.y !== menu.y) setMenu((current) => (current ? { ...current, ...next } : current));
    });
    const close = (event: Event) => {
      if (event instanceof MouseEvent && box.current?.contains(event.target as Node)) return;
      setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenu(null);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const enabled = visibleMenuItems(menu);
        if (enabled.length === 0) return;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setActive((active + delta + enabled.length) % enabled.length);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const item = visibleMenuItems(menu)[active];
        if (item) void run(item.id, menu);
      }
    };
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [menu, active]);

  if (!menu) return null;

  return (
    <div
      ref={box}
      className="edit-menu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {visibleMenuItems(menu).map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={index === active ? "active" : undefined}
            onMouseEnter={() => setActive(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void run(item.id, menu)}
          >
            <span>{item.label}</span>
            <kbd>{item.shortcut}</kbd>
          </button>
      ))}
    </div>
  );
}

function visibleMenuItems(menu: MenuState) {
  return EDIT_MENU_ITEMS.filter((item) => enabledAction(menu, item.id));
}

function enabledAction(menu: MenuState, action: EditMenuAction): boolean {
  if (menu.field) {
    const field = { ...menu.snapshot, selectionStart: menu.start, selectionEnd: menu.end };
    if (action === "cut") return canCut(field);
    if (action === "copy") return canCopy(field);
    if (action === "paste") return canPaste(field);
    return canSelectAll(field);
  }
  return action === "copy" && menu.pageSelected.length > 0;
}
