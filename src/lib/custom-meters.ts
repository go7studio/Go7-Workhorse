/**
 * Official leftover meters for custom HTTP bots.
 * Add a row only when current vendor docs name a key-only JSON path.
 * Dashboard-only or account-id paths stay unknown.
 */

export type CustomMeterKind = "plan" | "prepaid";

export type CustomMeterSpec = {
  id: string;
  /** Match the chat host, not the leftover host. */
  host: RegExp;
  kind: CustomMeterKind;
  docs: string;
  remainsUrl: (base: URL) => string;
};

export const CUSTOM_METERS: CustomMeterSpec[] = [
  {
    id: "minimax",
    host: /minimax/i,
    kind: "plan",
    docs: "https://www.minimax.io/v1/token_plan/remains",
    remainsUrl: (url) => {
      const host = /minimaxi\.com$/i.test(url.hostname) ? "www.minimaxi.com" : "www.minimax.io";
      return `${url.protocol}//${host}/v1/token_plan/remains`;
    },
  },
  {
    id: "synthetic",
    host: /(^|\.)synthetic\.new$/i,
    kind: "plan",
    docs: "https://dev.synthetic.new/docs/synthetic/quotas",
    remainsUrl: (url) => `${url.protocol}//api.synthetic.new/v2/quotas`,
  },
  {
    id: "openrouter",
    host: /(^|\.)openrouter\.ai$/i,
    kind: "plan",
    docs: "https://openrouter.ai/docs/api-reference/limits",
    remainsUrl: (url) => `${url.protocol}//${url.hostname}/api/v1/key`,
  },
  {
    id: "deepseek",
    host: /(^|\.)deepseek\.com$/i,
    kind: "prepaid",
    docs: "https://api-docs.deepseek.com/api/get-user-balance/",
    remainsUrl: (url) => `${url.protocol}//api.deepseek.com/user/balance`,
  },
  {
    id: "novita",
    host: /(^|\.)novita\.ai$/i,
    kind: "prepaid",
    docs: "https://novita.ai/docs/api-reference/basic-get-user-balance",
    remainsUrl: (url) => `${url.protocol}//api.novita.ai/openapi/v1/billing/balance/detail`,
  },
  {
    id: "aimlapi",
    host: /(^|\.)aimlapi\.com$/i,
    kind: "prepaid",
    docs: "https://docs.aimlapi.com/api-references/service-endpoints/account-balance",
    remainsUrl: (url) => `${url.protocol}//api.aimlapi.com/v2/billing`,
  },
  {
    id: "vercel",
    host: /(^|\.)ai-gateway\.vercel\.sh$/i,
    kind: "prepaid",
    docs: "https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api",
    remainsUrl: (url) => `${url.protocol}//${url.hostname}/v1/credits`,
  },
];

function asUrl(baseUrl: string): URL | undefined {
  const trimmed = baseUrl.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return undefined;
  }
}

export function customMeterForUrl(baseUrl: string): CustomMeterSpec | undefined {
  const url = asUrl(baseUrl);
  if (!url) return undefined;
  return CUSTOM_METERS.find((meter) => meter.host.test(url.hostname));
}

export function customPlanRemainsUrl(baseUrl: string): string | undefined {
  const url = asUrl(baseUrl);
  if (!url) return undefined;
  const meter = CUSTOM_METERS.find((item) => item.host.test(url.hostname));
  return meter?.remainsUrl(url);
}
