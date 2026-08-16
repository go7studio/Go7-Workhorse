export type CursorUsageLane = "cursor-models" | "other-models" | "auto-cost" | "auto-routed" | "unknown";

export type CursorWatchKey = "cursor:cursor-models" | "cursor:other-models";

export type CursorLaneParams = {
  optimize_for?: string;
  optimizeFor?: string;
};

const CURSOR_MODEL_SLUGS = new Set([
  "composer",
  "composer-2",
  "composer-2.5",
  "composer-2-5",
  "grok-4.6",
  "grok-4-6",
  "grok-4.5",
  "grok-4-5",
]);

function slugOf(model?: string | null): string {
  return (model ?? "").trim().toLowerCase().replace(/_/g, "-");
}

function baseSlug(slug: string): string {
  return slug
    .replace(/\[.*?\]/g, "")
    .replace(/-(fast|thinking|high|low|xhigh|max)$/g, "")
    .replace(/\s+/g, "-")
    .trim();
}

function optimizeFor(params?: CursorLaneParams | null): string {
  const raw = params?.optimize_for ?? params?.optimizeFor ?? "";
  return String(raw).trim().toLowerCase();
}

export function cursorUsageLane(model?: string | null, params?: CursorLaneParams | null): CursorUsageLane {
  const slug = slugOf(model);
  if (!slug) return "unknown";
  if (slug === "auto-smart" || slug === "auto") {
    const mode = optimizeFor(params);
    if (mode === "cost") return "auto-cost";
    if (mode === "balanced" || mode === "balance" || mode === "intelligence") return "auto-routed";
    return "auto-routed";
  }
  const base = baseSlug(slug);
  if (CURSOR_MODEL_SLUGS.has(base) || CURSOR_MODEL_SLUGS.has(slug) || /^composer/.test(slug)) {
    return "cursor-models";
  }
  if (slug.includes("grok-4.6") || slug.includes("grok-4-6") || slug.includes("grok-4.5") || slug.includes("grok-4-5")) {
    return "cursor-models";
  }
  if (/^(claude|gpt|gemini|sonnet|opus|haiku|fable|o[1-4])\b/.test(slug) || slug.includes("claude") || slug.includes("gpt-") || slug.includes("gemini")) {
    return "other-models";
  }
  return "other-models";
}

export function cursorWatchLane(model?: string | null, params?: CursorLaneParams | null): CursorWatchKey {
  const lane = cursorUsageLane(model, params);
  if (lane === "other-models" || lane === "auto-routed") return "cursor:other-models";
  return "cursor:cursor-models";
}

export function cursorWatchKeyLabel(key: string): string {
  if (key === "cursor:other-models") return "Cursor · API";
  if (key === "cursor:cursor-models") return "Cursor · Composer";
  return "Cursor";
}

export function isCursorWatchKey(key: string): key is CursorWatchKey {
  return key === "cursor:cursor-models" || key === "cursor:other-models";
}

export function isCursorInnerTask(input: { method?: string; title?: string; toolName?: string; kind?: string }): boolean {
  const hay = `${input.method ?? ""} ${input.title ?? ""} ${input.toolName ?? ""} ${input.kind ?? ""}`.toLowerCase();
  return hay.includes("cursor/task") || hay.includes("cursor.task") || /\bsubagenttype\b/.test(hay);
}

export const CURSOR_ACP_NOT_INSTALLED =
  "Cursor ACP is not installed. Install the Cursor CLI (`agent`) or set CURSOR_ACP_BIN to a real file.";

export const CURSOR_AGENT_FAILED_PREFIX = "Cursor agent failed:";
