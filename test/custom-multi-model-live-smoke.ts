import { fetchCustomModels } from "../electron/custom-models";

const baseUrl = (
  process.env.WORKHORSE_EVAL_MULTI_MODEL_BASE_URL
  || process.env.WORKHORSE_EVAL_SYNTHETIC_BASE_URL
  || "https://api.synthetic.new/openai/v1"
).replace(/\/+$/, "");
const apiKey = (
  process.env.WORKHORSE_EVAL_MULTI_MODEL_API_KEY
  || process.env.WORKHORSE_EVAL_SYNTHETIC_API_KEY
  || ""
).trim();
const models = (
  process.env.WORKHORSE_EVAL_MULTI_MODEL_MODELS
  || process.env.WORKHORSE_EVAL_SYNTHETIC_MODELS
  || "syn:large:text,syn:large:vision"
)
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

if (!apiKey) throw new Error("WORKHORSE_EVAL_MULTI_MODEL_API_KEY is required; no live call was made.");
if (models.length !== 2 || models[0] === models[1]) throw new Error("Choose two distinct models on the same key.");

const boundedFetch: typeof fetch = (input, init = {}) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(45_000) });
const discovered = await fetchCustomModels({ baseUrl, apiKey, fetchImpl: boundedFetch });

async function call(model: string) {
  const response = await boundedFetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      stream: false,
      messages: [{ role: "user", content: "Reply with exactly: MULTI_MODEL_OK" }],
    }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${model} returned HTTP ${response.status}: ${raw.slice(0, 180)}`);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`${model} returned invalid JSON.`);
  }
  const choice = Array.isArray(parsed.choices) ? parsed.choices[0] as { message?: { content?: unknown } } : undefined;
  const reply = typeof choice?.message?.content === "string" ? choice.message.content.trim() : "";
  if (!reply) throw new Error(`${model} returned an empty reply.`);
  return {
    requestedModel: model,
    observedModel: typeof parsed.model === "string" ? parsed.model : null,
    exactReply: reply === "MULTI_MODEL_OK",
  };
}

const calls = [];
for (const model of models) calls.push(await call(model));
console.log(JSON.stringify({
  connection: new URL(baseUrl).host,
  discoveredRequestedModels: models.map((model) => discovered.includes(model)),
  calls,
  sameKey: true,
  distinctRequestedModels: new Set(calls.map((item) => item.requestedModel)).size === 2,
}, null, 2));
