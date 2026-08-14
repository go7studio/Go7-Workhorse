import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectCodexLogin } from "./codex-login";

export type CodexHookSource = {
  path: string;
  scope: "user" | "project";
  kind: "json" | "toml";
};

function hasInlineHooks(filePath: string): boolean {
  try {
    return /^\s*\[hooks(?:\.|\])/m.test(fs.readFileSync(filePath, "utf8"));
  } catch {
    return false;
  }
}

export function discoverCodexHooks(projectRoot?: string): CodexHookSource[] {
  const { codexHome } = detectCodexLogin();
  const candidates: CodexHookSource[] = [
    { path: path.join(codexHome, "hooks.json"), scope: "user", kind: "json" },
    { path: path.join(codexHome, "config.toml"), scope: "user", kind: "toml" },
  ];
  if (projectRoot && path.isAbsolute(projectRoot)) {
    candidates.push(
      { path: path.join(projectRoot, ".codex", "hooks.json"), scope: "project", kind: "json" },
      { path: path.join(projectRoot, ".codex", "config.toml"), scope: "project", kind: "toml" },
    );
  }
  return candidates.filter((item) => fs.existsSync(item.path) && (item.kind === "json" || hasInlineHooks(item.path)));
}

export function codexCapabilitySummary(projectRoot?: string) {
  const login = detectCodexLogin();
  return {
    hooks: discoverCodexHooks(projectRoot),
    cloudEnvironments: { available: false, message: "Cloud environment selection is not exposed by the local ACP fallback." },
    nativeSubagents: { available: Boolean(login.cliBinary), message: login.cliBinary ? "Native child threads are visible through App Server thread history." : "Codex CLI not found." },
    configHome: login.codexHome || path.join(os.homedir(), ".codex"),
  };
}
