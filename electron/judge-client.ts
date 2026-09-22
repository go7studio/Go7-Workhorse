/**
 * One call to the evaluation model through the Vercel AI Gateway. The route
 * is the gateway's REST one, not the AI SDK's: POST <bot base>/evaluate with
 * the model in the body. Proven live 2026-09-22: 200 in 395 ms.
 *
 * Never throws. A judge that cannot answer is a judge that stays silent, and
 * the desk carries on as if there were none.
 */
import { JUDGE_MODEL, type JudgeAnswer, type JudgeQuestion } from "../src/lib/judge";

export type JudgeEndpoint = {
  /** The custom bot's base, e.g. https://ai-gateway.vercel.sh/v1 */
  baseUrl: string;
  apiKey: string;
  model?: string;
};

export type JudgeCallResult =
  | {
      ok: true;
      model: string;
      answers: Record<string, JudgeAnswer>;
      usage?: { inputTokens?: number; outputTokens?: number };
      elapsedMs: number;
    }
  | {
      ok: false;
      reason: string;
      status?: number;
      elapsedMs: number;
      /** False only when the request never left: DNS, TLS, no network. A timeout may have been billed and counts as reached. */
      reached: boolean;
      /** What the gateway billed for an answer that gave no verdict. */
      usage?: { inputTokens?: number; outputTokens?: number };
    };

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * The judge answers inside a status reply. The Link's bridge gives
 * agent-status 8 seconds and await-agents 15, or the cursor plus 5, so a
 * judge allowed 20 would hand the caller a timeout instead of a payload.
 * Jev answered the live sample in 395 ms.
 */
export const JUDGE_TIMEOUT_MS = 4_000;

export function judgeUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}/evaluate`;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A probability or a confidence: within 0..1, or not an answer. */
function readUnit(value: unknown): number | undefined {
  const number = readNumber(value);
  return number !== undefined && number >= 0 && number <= 1 ? number : undefined;
}

function readUsage(raw: unknown): { inputTokens?: number; outputTokens?: number } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as { inputTokens?: unknown; outputTokens?: unknown };
  const usage = {
    ...(readNumber(record.inputTokens) !== undefined ? { inputTokens: readNumber(record.inputTokens) } : {}),
    ...(readNumber(record.outputTokens) !== undefined ? { outputTokens: readNumber(record.outputTokens) } : {}),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** Keeps only answers whose type matches the question it answers and whose numbers are on the question's scale. */
function readAnswers(raw: unknown, questions: Record<string, JudgeQuestion>): Record<string, JudgeAnswer> {
  const out: Record<string, JudgeAnswer> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, question] of Object.entries(questions)) {
    const answer = (raw as Record<string, unknown>)[key];
    if (!answer || typeof answer !== "object") continue;
    const record = answer as Record<string, unknown>;
    if (record.type !== question.type) continue;
    if (question.type === "boolean") {
      const probability = readUnit(record.probability);
      if (probability !== undefined) out[key] = { type: "boolean", probability };
    } else if (question.type === "choice") {
      if (typeof record.choice === "string") {
        out[key] = {
          type: "choice",
          choice: record.choice,
          ...(record.probabilities && typeof record.probabilities === "object" ? { probabilities: record.probabilities as Record<string, number> } : {}),
          ...(readUnit(record.confidence) !== undefined ? { confidence: readUnit(record.confidence) } : {}),
        };
      }
    } else {
      const raw = readNumber(record.score);
      const score = raw !== undefined && raw >= 0 && raw <= question.criteria.length - 1 ? raw : undefined;
      if (score !== undefined) {
        out[key] = {
          type: "score",
          score,
          ...(record.probabilities && typeof record.probabilities === "object" ? { probabilities: record.probabilities as Record<string, number> } : {}),
          ...(readUnit(record.confidence) !== undefined ? { confidence: readUnit(record.confidence) } : {}),
        };
      }
    }
  }
  return out;
}

export async function callJudge(
  endpoint: JudgeEndpoint,
  state: Record<string, unknown>,
  questions: Record<string, JudgeQuestion>,
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<JudgeCallResult> {
  const started = Date.now();
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? JUDGE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(judgeUrl(endpoint.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${endpoint.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: endpoint.model ?? JUDGE_MODEL, state, questions }),
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown = undefined;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    const elapsedMs = Date.now() - started;
    if (!response.ok) {
      const message =
        body && typeof body === "object" && (body as { error?: { message?: unknown } }).error &&
        typeof (body as { error: { message?: unknown } }).error.message === "string"
          ? (body as { error: { message: string } }).error.message
          : `HTTP ${response.status}`;
      return { ok: false, reason: message, status: response.status, elapsedMs, reached: true };
    }
    if (!body || typeof body !== "object") return { ok: false, reason: "empty or non-JSON response", status: response.status, elapsedMs, reached: true };
    const record = body as { model?: unknown; answers?: unknown; usage?: unknown };
    // Read the bill before judging the answers: a 200 with nothing usable was still billed.
    const usage = readUsage(record.usage);
    const answers = readAnswers(record.answers, questions);
    // A verdict needs at least one criterion scored. The claim and the
    // specificity alone would persist as a scored report with every
    // criterion unclear, which reads as a verdict and is none.
    if (!Object.values(answers).some((answer) => answer.type === "boolean")) {
      return { ok: false, reason: "no criterion answers in response", status: response.status, elapsedMs, reached: true, ...(usage ? { usage } : {}) };
    }
    return {
      ok: true,
      model: typeof record.model === "string" && record.model ? record.model : endpoint.model ?? JUDGE_MODEL,
      answers,
      ...(usage ? { usage } : {}),
      elapsedMs,
    };
  } catch (error) {
    const elapsedMs = Date.now() - started;
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      reason: aborted ? `timed out after ${options.timeoutMs ?? JUDGE_TIMEOUT_MS} ms` : error instanceof Error ? error.message : String(error),
      elapsedMs,
      reached: aborted,
    };
  } finally {
    clearTimeout(timer);
  }
}
