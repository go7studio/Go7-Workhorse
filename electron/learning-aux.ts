import { streamCustomHttp, type CustomHttpConfig } from "./custom-http";
import type { AuxiliaryCallRequest, AuxiliaryCallResult } from "../src/lib/learning-types";
import { PROVIDER_CAPABILITIES } from "../src/lib/provider-capabilities";

export function providerAllowsEphemeralAuxiliary(provider: AuxiliaryCallRequest["provider"]): boolean {
  return PROVIDER_CAPABILITIES[provider].ephemeralAuxiliary === "native";
}

export async function ephemeralCustomAuxiliary(
  config: CustomHttpConfig,
  request: AuxiliaryCallRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<AuxiliaryCallResult> {
  const result = await streamCustomHttp(
    config,
    { messages: [{ role: "user", text: request.prompt }], effort: request.effort },
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
