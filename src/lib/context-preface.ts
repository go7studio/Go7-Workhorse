import type { CrewMode, LinkedReference, PermissionMode, SandboxProfile } from "./types";
import {
  AUDITOR_SESSION_RULES,
  CURSOR_SESSION_RULES,
  CUSTOM_HTTP_SESSION_RULES,
  CUSTOM_HTTP_WORKER_RULES,
  WORKHORSE_SESSION_RULES,
  WORKER_SESSION_RULES,
  type DeskRole,
  withCrewModeHint,
  withCrewStatusHint,
  withDeskBotHint,
  withLooseDeleteHint,
  withPermissionHint,
  withPreviewHint,
  withSpawnHint,
  withWriteLimitHint,
  writesAreBlocked,
} from "./workhorse-rules";

export type DeskContext = {
  title: string;
  projectName?: string;
  sidebar: string;
  preview: string;
};

export type PrefaceInput = {
  sessionId?: string;
  cwd: string;
  folders: string[];
  references: Array<Pick<LinkedReference, "kind" | "value" | "label">>;
  desk?: DeskContext;
  mode?: PermissionMode;
  sandbox?: SandboxProfile;
  /** mcp = Grok/Codex/Claude with Workhorse tools. http = custom HTTP. cursor = Cursor Agent ACP. */
  surface?: "mcp" | "http" | "cursor";
  role?: DeskRole;
};

/** Workspace map for this turn: cwd, extra folders, and project references. */
export function buildVendorPreface(input: PrefaceInput): string {
  const cwd = input.cwd.trim();
  const extras = input.folders.map((folder) => folder.trim()).filter((folder) => folder && folder !== cwd);
  const refs = input.references.filter((item) => item.value.trim());
  const lines = ["This Workhorse workspace (this turn):"];
  if (cwd) {
    lines.push(`- Working directory: ${cwd}`);
    lines.push(
      "- list_dir with no path lists that working directory. Relative paths are from there. If the user means the Workhorse app folder and this path is it, use this path — do not search the home folder.",
    );
  } else {
    lines.push("- No project folder is linked to this chat.");
    lines.push(
      "- This turn still runs from the desk base (empty bootstrap, not the project). Do not refuse because no folder is linked.",
    );
    lines.push(
      "- Search likely folders with absolute paths, then attach with workhorse_create_project using this chat’s project name and the found folder. If that project already exists, that call links the folder.",
    );
    lines.push(
      "- list_dir with no path lists the desk base. Sandbox Off can take any absolute path on the machine, subject to Permission.",
    );
    lines.push(
      "- Do not spawn workers until a real project folder is bound, unless you pass folder on spawn.",
    );
  }
  if (extras.length > 0) {
    lines.push("Additional linked folders (already on this project — list_dir their absolute path):");
    for (const folder of extras) lines.push(`- ${folder}`);
  }
  if (refs.length > 0) {
    lines.push("Linked references:");
    for (const ref of refs) {
      const label = ref.label.trim() && ref.label !== ref.value ? ` (${ref.label.trim()})` : "";
      lines.push(`- ${ref.kind}: ${ref.value.trim()}${label}`);
    }
  }
  return lines.join("\n");
}

export function withVendorPreface(text: string, preface: string | undefined): string {
  const head = preface?.trim();
  if (!head) return text;
  return `${head}\n\n${text}`;
}

/**
 * Which shell the machine actually speaks. An ACP vendor learns this from its
 * own CLI; a custom HTTP bot has no CLI and guesses. Kimi guessed Windows on a
 * Mac and ran `dir D:/ harbour* 2>nul`, which failed, and the turn then had
 * nothing to report.
 */
export function machineLine(platform: string): string {
  if (platform === "win32") {
    return "- Machine: Windows. Shell commands are cmd/PowerShell — backslash paths, `dir`, `2>nul`. Never POSIX paths or `/dev/null`.";
  }
  const name = platform === "darwin" ? "macOS" : "Linux";
  return `- Machine: ${name}. Shell commands are POSIX — forward-slash paths, \`ls\`, \`2>/dev/null\`. Never a drive letter, \`dir\`, or \`2>nul\`.`;
}

export function buildPolicyContext(
  input: Pick<PrefaceInput, "mode" | "sandbox"> & { platform?: string },
): string {
  const mode = input.mode ?? "ask";
  const sandbox = input.sandbox ?? "off";
  const permission =
    mode === "plan"
      ? "Plan — research and propose only. Project writes are blocked."
      : mode === "always-approve"
        ? "Always — tools run without asking."
        : mode === "accept-edits"
          ? "Accept edits — file edits run; shell still asks."
          : "Ask — changing tools wait for the user.";
  const box =
    sandbox === "read-only"
      ? "Read-only — writes, edits, creates, deletes, and shell commands are blocked."
      : sandbox === "strict"
        ? "Strict — tightest box. Writes and shell commands are blocked."
        : sandbox === "workspace"
          ? "Workspace — writes stay in the project folder."
          : "Off — full machine access, subject to Permission.";
  const lines = [
    "This chat’s live desk limits for THIS turn (already enforced — do not probe them). These override any earlier message in this chat about what you can do:",
    `- Permission: ${permission}`,
    `- Sandbox: ${box}`,
  ];
  if (input.platform) lines.push(machineLine(input.platform));
  if (writesAreBlocked(mode, sandbox)) {
    lines.push(
      "You cannot write files this turn until the user elevates. Call workhorse_request_permission with sandbox=off or workspace and permission=ask (or accept-edits / always-approve), then continue. A card appears above the composer. Do not tell them to open Settings.",
    );
  } else {
    lines.push(
      "Writes are allowed this turn, subject to Permission. If an earlier turn said you cannot write, ignore that — the user changed This chat settings. Do not offer to lower Permission or Sandbox. Do not call workhorse_request_permission unless a write is actually blocked.",
    );
  }
  return lines.join("\n");
}

export function buildDeskContext(desk: DeskContext): string {
  const title = desk.title.trim() || "New chat";
  const preview = desk.preview.trim() || "(empty)";
  const lines = ["This Workhorse chat:"];
  lines.push(`- Title: ${title}`);
  if (desk.projectName?.trim()) lines.push(`- Project: ${desk.projectName.trim()}`);
  lines.push(`- Sidebar subtitle (under the title): ${desk.sidebar.trim() || "(none)"}`);
  lines.push(`- Preview (last message snippet): ${preview}`);
  lines.push("If the user asks what the preview says, quote Preview. The sidebar subtitle is not the preview.");
  return lines.join("\n");
}

export function capabilityFromPreface(preface: string | undefined): string {
  const text = preface?.trim() ?? "";
  if (!text) return "";
  const at = text.indexOf("This chat’s live desk limits");
  return at >= 0 ? text.slice(at).trim() : "";
}

/** First-prompt context: desk-slot rules, live limits, extra folders/refs and this-chat map. */
export function buildSessionPreface(input: PrefaceInput): string {
  const worker = input.role === "worker";
  const rules = input.role === "auditor"
    ? AUDITOR_SESSION_RULES
    : worker
    ? input.surface === "http"
      ? CUSTOM_HTTP_WORKER_RULES
      : WORKER_SESSION_RULES
    : input.surface === "http"
      ? CUSTOM_HTTP_SESSION_RULES
      : input.surface === "cursor"
        ? CURSOR_SESSION_RULES
        : WORKHORSE_SESSION_RULES;
  const parts = [
    input.sessionId
      ? `This chat's immutable Workhorse session ID is ${input.sessionId}. Use it exactly; never invent or alter a session ID.`
      : "",
    buildPolicyContext(input),
    buildVendorPreface(input),
    input.desk ? buildDeskContext(input.desk) : "",
  ].filter((item) => item.trim());
  const extra = parts.join("\n\n");
  return extra ? `${rules}\n\n${extra}` : rules;
}

export function composeVendorPrompt(
  text: string,
  preface: string | undefined,
  opened: "session/new" | "session/load",
  limits?: { mode?: PermissionMode; sandbox?: SandboxProfile; role?: DeskRole; crewMode?: CrewMode | CrewMode[] },
  visibleText?: string,
): string {
  const hinted = withWriteLimitHint(
    withCrewStatusHint(
      withLooseDeleteHint(
        withCrewModeHint(
          withSpawnHint(withPermissionHint(withPreviewHint(withDeskBotHint(text)), limits?.role), limits?.role),
          limits?.crewMode,
          limits?.role,
        ),
        limits?.role,
      ),
      limits?.role,
    ),
    limits?.mode,
    limits?.sandbox,
  );
  const live = limits
    ? buildPolicyContext(limits)
    : capabilityFromPreface(preface);
  if (opened === "session/new") {
    const visible = visibleText?.trim() || text.trim();
    if (!visible) return withVendorPreface(hinted, preface);
    // Turn hints are prefixes, so the last occurrence is the real prompt when
    // the same words also happen to appear inside a Workhorse instruction.
    const at = hinted.lastIndexOf(visible);
    const privateTurnContext = at >= 0
      ? `${hinted.slice(0, at)}${hinted.slice(at + visible.length)}`.trim()
      : hinted.trim() === visible
        ? ""
        : hinted.trim();
    return [
      visible,
      "Workhorse private operating context follows. Do not use this section to name or title the chat; title it from the user request above.",
      preface?.trim() ?? "",
      privateTurnContext,
    ].filter((item) => item.trim()).join("\n\n");
  }
  return live ? `${live}\n\n${hinted}` : hinted;
}
