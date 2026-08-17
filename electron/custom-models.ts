import https from "node:https";

/**
 * Ask a custom provider which models it serves.
 *
 * A provider like Synthetic sells many models behind one key and one quota:
 * `hf:moonshotai/Kimi-K3`, `hf:zai-org/GLM-5.2`, and routing aliases such as
 * `syn:large:text`. Typing one id by hand turned each into its own bot, and
 * two bots on one account draw two leftover rings from the same pool.
 *
 * Both dialects answer the same shape — OpenAI at `/models`, Anthropic at
 * `/models` too — `{ data: [{ id }] }`. Nothing here fails a connection: a
 * provider with no such endpoint keeps the model the user typed.
 */
export function customModelsUrl(baseUrl: string): string | undefined {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return `${trimmed}/models`;
  } catch {
    return undefined;
  }
}

export function parseCustomModels(raw: unknown): string[] {
  const root = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const rows = Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : Array.isArray(raw) ? raw : [];
  const ids: string[] = [];
  for (const row of rows) {
    if (typeof row === "string") {
      if (row.trim()) ids.push(row.trim());
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const id = record.id ?? record.name ?? record.model;
    if (typeof id === "string" && id.trim()) ids.push(id.trim());
  }
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

export async function fetchCustomModels(input: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  const url = customModelsUrl(input.baseUrl);
  const apiKey = input.apiKey.trim();
  if (!url || !apiKey) return [];
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    Accept: "application/json",
    "User-Agent": "go7-workhorse",
  };
  try {
    if (input.fetchImpl) {
      const response = await input.fetchImpl(url, { headers });
      if (!response.ok) return [];
      return parseCustomModels(await response.json());
    }
    // Electron's Chromium fetch can strip User-Agent, and these hosts 429 or
    // empty the body when it does. Same workaround as the quota reader.
    const json = await new Promise<unknown>((resolve, reject) => {
      const request = https.get(url, { headers }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk as Buffer));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if ((response.statusCode ?? 500) >= 400) {
            resolve(null);
            return;
          }
          try {
            resolve(body ? JSON.parse(body) : null);
          } catch {
            resolve(null);
          }
        });
      });
      request.on("error", reject);
      request.setTimeout(10_000, () => request.destroy(new Error("timed out")));
    });
    return parseCustomModels(json);
  } catch {
    return [];
  }
}
