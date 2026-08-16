import type { Provider, ProviderId } from "./types";

export const PROVIDERS: Provider[] = [
  {
    id: "grok",
    name: "Grok",
    short: "G",
    tagline: "Grok Build via ACP",
    connected: false,
    statusNote: "Adapter ready. Uses your existing Grok login on this machine.",
  },
  {
    id: "claude",
    name: "Claude",
    short: "C",
    tagline: "Claude Code via ACP",
    connected: false,
    statusNote: "Live ACP adapter. Uses @agentclientprotocol/claude-agent-acp and your existing Claude login.",
  },
  {
    id: "codex",
    name: "Codex",
    short: "X",
    tagline: "Codex CLI via ACP",
    connected: false,
    statusNote: "Live ACP adapter. Uses @agentclientprotocol/codex-acp and your existing Codex login.",
  },
  {
    id: "cursor",
    name: "Cursor",
    short: "U",
    tagline: "Cursor Agent via ACP",
    connected: false,
    statusNote: "Live ACP adapter. Uses the Cursor CLI (`agent acp`) and your existing Cursor login.",
  },
  {
    id: "custom",
    name: "Custom",
    short: "+",
    tagline: "Any bot you drop in",
    connected: false,
    statusNote: "Create a bot from an API. Preview first, then Create to add a slot.",
  },
];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && PROVIDERS.some((provider) => provider.id === value);
}

export function providerById(id: ProviderId): Provider {
  const found = PROVIDERS.find((item) => item.id === id);
  if (!found) throw new Error(`Unknown provider: ${id}`);
  return found;
}
