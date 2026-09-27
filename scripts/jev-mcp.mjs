#!/usr/bin/env node
// First-party, narrow MCP bridge for TypeSafe Jev. The model never receives the API key.
import { execFileSync } from "node:child_process";
import readline from "node:readline";

const API_URL = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const MAX_BODY_BYTES = 32_000;
const MAX_QUESTIONS = 12;
const TOOL = {
  name: "jev_evaluate",
  description: "Ask TypeSafe Jev to evaluate non-sensitive text or structured state with bounded yes/no, choice, or score questions. Sends the supplied state and questions to TypeSafe AI. Use for classification, routing, and checks, not open-ended generation or final authorization.",
  inputSchema: {
    type: "object",
    properties: {
      state: { description: "Text or JSON state to evaluate; do not include secrets or sensitive personal data." },
      questions: {
        type: "object",
        description: "One to twelve named typed questions. Types: noul (yes/no), choice (criteria map), score (ordered criteria array).",
        additionalProperties: { type: "object" },
      },
    },
    required: ["state", "questions"],
    additionalProperties: false,
  },
};

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function structured(value) {
  return typeof value === "string" || Array.isArray(value) || object(value);
}

export function validatedRequest(input) {
  if (!object(input) || !structured(input.state)) throw new Error("state must be text, an object, or an array");
  if (!object(input.questions)) throw new Error("questions must be a named object");
  const entries = Object.entries(input.questions);
  if (entries.length < 1 || entries.length > MAX_QUESTIONS) throw new Error(`provide 1-${MAX_QUESTIONS} questions`);
  const questions = {};
  for (const [name, question] of entries) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name)) throw new Error(`invalid question name: ${name.slice(0, 64)}`);
    if (!object(question) || !structured(question.instructions)) throw new Error(`${name}: instructions are required`);
    if (question.type === "noul") {
      questions[name] = { type: "noul", instructions: question.instructions };
      if (question.criteria !== undefined) {
        if (!object(question.criteria)) throw new Error(`${name}: noul criteria must be an object`);
        questions[name].criteria = question.criteria;
      }
    } else if (question.type === "choice") {
      if (!object(question.criteria) || Object.keys(question.criteria).length < 2 || Object.keys(question.criteria).length > 12) {
        throw new Error(`${name}: choice needs 2-12 options`);
      }
      questions[name] = { type: "choice", instructions: question.instructions, criteria: question.criteria };
    } else if (question.type === "score") {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 10) {
        throw new Error(`${name}: score needs 2-10 ordered levels`);
      }
      questions[name] = { type: "score", instructions: question.instructions, criteria: question.criteria };
    } else {
      throw new Error(`${name}: type must be noul, choice, or score`);
    }
  }
  const body = { model: MODEL, state: input.state, questions };
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) throw new Error("request exceeds 32 KB limit");
  return body;
}

function apiKey() {
  const environment = process.env.TYPESAFE_API_KEY?.trim();
  if (environment) return environment;
  if (process.platform === "darwin") {
    try {
      return execFileSync("security", ["find-generic-password", "-a", "workhorse-jev", "-s", "go7.typesafe.jev", "-w"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000,
      }).trim();
    } catch { /* Environment variable remains the portable option. */ }
  }
  throw new Error("TypeSafe key unavailable; set TYPESAFE_API_KEY or configure the Workhorse Jev Keychain item");
}

export async function evaluate(input, { fetchImpl = fetch, readKey = apiKey } = {}) {
  const body = validatedRequest(input);
  const response = await fetchImpl(API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${readKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`TypeSafe Jev returned HTTP ${response.status}`);
  const result = await response.json();
  if (!object(result) || !object(result.answers)) throw new Error("TypeSafe Jev returned no answers");
  return { model: result.model, answers: result.answers, usage: result.usage };
}

export function parseCallLimit(value) {
  if (value === undefined || value === "") return 0;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("JEV_MCP_MAX_CALLS must be a positive integer");
  const limit = Number(value);
  if (!Number.isSafeInteger(limit)) throw new Error("JEV_MCP_MAX_CALLS is too large");
  return limit;
}

export function boundedEvaluator(maxCalls, evaluateImpl = evaluate) {
  let attempts = 0;
  return async (input) => {
    // Malformed requests never reach TypeSafe and do not spend the call budget.
    validatedRequest(input);
    if (maxCalls > 0 && attempts >= maxCalls) {
      throw new Error(`Jev call budget exhausted (${attempts}/${maxCalls})`);
    }
    // Reserve before the network request: a failed or ambiguous response may
    // still have reached TypeSafe, so it cannot authorize another attempt.
    attempts += 1;
    return evaluateImpl(input);
  };
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

export async function handle(message, evaluateWithBudget, sendMessage = send) {
  if (!object(message) || message.jsonrpc !== "2.0" || message.id === undefined) return;
  const id = message.id;
  try {
    if (message.method === "initialize") {
      sendMessage({ id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "go7-jev", version: "1.0.0" } } });
    } else if (message.method === "ping") {
      sendMessage({ id, result: {} });
    } else if (message.method === "tools/list") {
      sendMessage({ id, result: { tools: [TOOL] } });
    } else if (message.method === "tools/call") {
      if (message.params?.name !== TOOL.name) throw new Error("unknown Jev tool");
      try {
        const result = await evaluateWithBudget(message.params.arguments);
        sendMessage({ id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
      } catch (error) {
        sendMessage({ id, result: { content: [{ type: "text", text: error instanceof Error ? error.message : "Jev call failed" }], isError: true } });
      }
    } else {
      sendMessage({ id, error: { code: -32601, message: "Method not found" } });
    }
  } catch (error) {
    sendMessage({ id, error: { code: -32602, message: error instanceof Error ? error.message : "Invalid request" } });
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const evaluateWithBudget = boundedEvaluator(parseCallLimit(process.env.JEV_MCP_MAX_CALLS));
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    try { await handle(JSON.parse(line), evaluateWithBudget); } catch { /* Never write protocol noise to stdout. */ }
  }
}
