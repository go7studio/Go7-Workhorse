import type { ProviderId } from "./types";

export type CapabilitySupport = "native" | "workhorse" | "unavailable";

export type ProviderCapabilities = {
  transport: "acp" | "http" | "cli";
  ephemeralAuxiliary: CapabilitySupport;
  conversation: {
    resume: CapabilitySupport;
    fork: CapabilitySupport;
    rewind: CapabilitySupport;
    compact: CapabilitySupport;
    portableReplay: boolean;
  };
  tools: {
    workspace: boolean;
    desk: boolean;
    mcp: boolean;
    subagents: boolean;
  };
  input: {
    images: boolean;
    files: boolean;
    documents: CapabilitySupport;
    audio: CapabilitySupport;
    video: CapabilitySupport;
  };
  security: {
    permissions: boolean;
    filesystem: CapabilitySupport;
    network: CapabilitySupport;
    outsideWorkspace: CapabilitySupport;
  };
  usage: CapabilitySupport;
};

const ACP_SHARED = {
  transport: "acp" as const,
  ephemeralAuxiliary: "unavailable" as const,
  tools: { workspace: true, desk: true, mcp: true, subagents: true },
  input: { images: true, files: true, documents: "workhorse" as const, audio: "workhorse" as const, video: "workhorse" as const },
  usage: "native" as const,
};

/**
 * Features Workhorse can honestly expose for each live adapter today.
 * Keep this registry descriptive: UI must not promise a capability merely
 * because another provider happens to implement it.
 */
export const PROVIDER_CAPABILITIES: Record<ProviderId, ProviderCapabilities> = {
  grok: {
    ...ACP_SHARED,
    conversation: {
      resume: "native",
      fork: "native",
      rewind: "native",
      compact: "native",
      portableReplay: true,
    },
    security: {
      permissions: true,
      filesystem: "native",
      network: "workhorse",
      outsideWorkspace: "workhorse",
    },
  },
  claude: {
    ...ACP_SHARED,
    conversation: {
      resume: "native",
      fork: "workhorse",
      rewind: "workhorse",
      compact: "workhorse",
      portableReplay: true,
    },
    security: {
      permissions: true,
      filesystem: "native",
      network: "workhorse",
      outsideWorkspace: "workhorse",
    },
  },
  codex: {
    ...ACP_SHARED,
    conversation: {
      resume: "native",
      fork: "workhorse",
      rewind: "workhorse",
      compact: "workhorse",
      portableReplay: true,
    },
    security: {
      permissions: true,
      filesystem: "native",
      network: "native",
      outsideWorkspace: "native",
    },
  },
  cursor: {
    ...ACP_SHARED,
    conversation: {
      resume: "native",
      fork: "workhorse",
      rewind: "workhorse",
      compact: "workhorse",
      portableReplay: true,
    },
    security: {
      permissions: true,
      filesystem: "native",
      network: "workhorse",
      outsideWorkspace: "workhorse",
    },
  },
  gemini: {
    transport: "cli",
    ephemeralAuxiliary: "unavailable",
    conversation: {
      resume: "native",
      fork: "unavailable",
      rewind: "unavailable",
      compact: "unavailable",
      portableReplay: false,
    },
    tools: { workspace: true, desk: false, mcp: false, subagents: false },
    input: { images: false, files: true, documents: "unavailable", audio: "unavailable", video: "unavailable" },
    security: {
      permissions: false,
      filesystem: "native",
      network: "unavailable",
      outsideWorkspace: "workhorse",
    },
    usage: "native",
  },
  custom: {
    transport: "http",
    ephemeralAuxiliary: "native",
    conversation: {
      resume: "workhorse",
      fork: "workhorse",
      rewind: "workhorse",
      compact: "workhorse",
      portableReplay: true,
    },
    tools: { workspace: true, desk: true, mcp: true, subagents: true },
    input: { images: true, files: true, documents: "workhorse", audio: "workhorse", video: "workhorse" },
    security: {
      permissions: true,
      filesystem: "workhorse",
      network: "workhorse",
      outsideWorkspace: "workhorse",
    },
    usage: "workhorse",
  },
};

export function capabilitiesFor(provider?: ProviderId | string | null): ProviderCapabilities {
  if (provider === "claude" || provider === "codex" || provider === "cursor" || provider === "gemini" || provider === "custom") {
    return PROVIDER_CAPABILITIES[provider];
  }
  return PROVIDER_CAPABILITIES.grok;
}
