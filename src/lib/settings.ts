import type { CustomLlm, LlmLink, Profile, Settings, SettingsSection } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  profile: { name: "", handle: "" },
  llms: {
    grok: { connected: false },
    claude: { connected: false },
    codex: { connected: false },
    custom: { connected: false, baseUrl: "", model: "", apiKey: "" },
  },
};

export function normalizeProfile(raw: unknown): Profile {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS.profile };
  const record = raw as Partial<Profile>;
  return {
    name: typeof record.name === "string" ? record.name : "",
    handle: typeof record.handle === "string" ? record.handle : "",
  };
}

function link(raw: unknown): LlmLink {
  if (!raw || typeof raw !== "object") return { connected: false };
  return { connected: Boolean((raw as LlmLink).connected) };
}

function custom(raw: unknown): CustomLlm {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS.llms.custom };
  const record = raw as Partial<CustomLlm>;
  return {
    connected: Boolean(record.connected),
    baseUrl: typeof record.baseUrl === "string" ? record.baseUrl : "",
    model: typeof record.model === "string" ? record.model : "",
    apiKey: typeof record.apiKey === "string" ? record.apiKey : "",
  };
}

export function normalizeSettings(raw: unknown): Settings {
  if (!raw || typeof raw !== "object") return structuredClone(DEFAULT_SETTINGS);
  const record = raw as Partial<Settings> & { llms?: Partial<Settings["llms"]> };
  return {
    profile: normalizeProfile(record.profile),
    llms: {
      grok: link(record.llms?.grok),
      claude: link(record.llms?.claude),
      codex: link(record.llms?.codex),
      custom: custom(record.llms?.custom),
    },
  };
}

export function isSettingsSection(value: unknown): value is SettingsSection {
  return value === "profile" || value === "llms" || value === "usage";
}
