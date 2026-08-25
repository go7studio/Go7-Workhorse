import { parseGrokBotWake } from "./grok-bot-shim";

export type GrokBotWakeInput = {
  url: string;
  key: string;
};

export type GrokBotWakeConfig = {
  url: string;
  senderKey: string;
};

export type GrokBotWakeStatus = {
  configured: boolean;
  shimReachable: boolean;
  ready: boolean;
  message: string;
};

/** The on-disk contract shared with the loopback Grok Bot shim. */
export function grokBotWakeConfig(value: unknown): GrokBotWakeConfig | null {
  return parseGrokBotWake(value) ?? null;
}

export function grokBotWakeInput(input: GrokBotWakeInput): GrokBotWakeConfig | null {
  return grokBotWakeConfig({ url: input.url, senderKey: input.key });
}
