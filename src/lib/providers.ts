import type { Provider, ProviderId } from "./types";

export const PROVIDERS: Provider[] = [
  {
    id: "grok",
    name: "Grok",
    short: "G",
    tagline: "Grok Build via ACP",
    connected: false,
    statusNote: "Adapter next. Uses your existing Grok login when wired.",
  },
  {
    id: "claude",
    name: "Claude",
    short: "C",
    tagline: "Claude Code via ACP",
    connected: false,
    statusNote: "Adapter next. Uses your existing Claude login when wired.",
  },
  {
    id: "codex",
    name: "Codex",
    short: "X",
    tagline: "Codex CLI via ACP",
    connected: false,
    statusNote: "Adapter next. Uses your existing Codex login when wired.",
  },
  {
    id: "custom",
    name: "Custom",
    short: "+",
    tagline: "Any bot you drop in",
    connected: false,
    statusNote: "Point at a command or URL later. Preview only for now.",
  },
];

export function providerById(id: ProviderId): Provider {
  const found = PROVIDERS.find((item) => item.id === id);
  if (!found) throw new Error(`Unknown provider: ${id}`);
  return found;
}
