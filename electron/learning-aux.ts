import { streamCustomHttp, type CustomHttpConfig } from "./custom-http";
import type { AuxiliaryCallRequest, AuxiliaryCallResult } from "../src/lib/learning-types";
import { PROVIDER_CAPABILITIES } from "../src/lib/provider-capabilities";

export type CompilerBot = {
  id: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  credentialId?: string;
  api?: CustomHttpConfig["api"];
  enabled?: boolean;
};

export function providerAllowsEphemeralAuxiliary(provider: AuxiliaryCallRequest["provider"]): boolean {
  return PROVIDER_CAPABILITIES[provider].ephemeralAuxiliary === "native";
}

/** Assigned desk bot + its vaulted key. No other bot, no imported host config. */
export function resolveCompilerBotConfig(
  bots: CompilerBot[],
  request: Pick<AuxiliaryCallRequest, "customBotId" | "model">,
  getSecret?: (credentialId: string) => string,
): CustomHttpConfig | null {
  const id = request.customBotId?.trim();
  if (!id) return null;
  const bot = bots.find((item) => item.id === id && item.enabled !== false);
  if (!bot) return null;
  const fromRow = typeof bot.apiKey === "string" ? bot.apiKey.trim() : "";
  let fromVault = "";
  if (!fromRow && bot.credentialId && getSecret) {
    try {
      fromVault = getSecret(bot.credentialId).trim();
    } catch {
      fromVault = "";
    }
  }
  const apiKey = fromRow || fromVault;
  const model = (request.model || bot.model).trim();
  const baseUrl = bot.baseUrl.trim();
  if (!apiKey || !baseUrl || !model) return null;
  return { baseUrl, apiKey, model, api: bot.api };
}

export async function ephemeralCustomAuxiliary(
  config: CustomHttpConfig,
  request: AuxiliaryCallRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<AuxiliaryCallResult> {
  const result = await streamCustomHttp(
    config,
    { messages: [{ role: "user", text: request.prompt }], effort: request.effort, maxTokens: 8192 },
    {},
    fetchImpl,
  );
  return {
    text: result.text,
    inputTokens: result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
    createdWorkhorseChat: false,
    leftoverVendorThread: false,
  };
}
