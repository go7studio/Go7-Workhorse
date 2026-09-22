/**
 * The desk's side of the judge: find the key, score one report, say what
 * happened. Runs in main, where the credential store is. Never throws.
 */
import { callJudge, type FetchLike, type JudgeEndpoint } from "./judge-client";
import {
  JUDGE_MODEL,
  judgeBotFor,
  judgeQuestions,
  judgeState,
  verdictFromAnswers,
  type JudgeVerdict,
} from "../src/lib/judge";
import type { CustomBot } from "../src/lib/types";

export type JudgeReadiness =
  | { ready: true; endpoint: JudgeEndpoint; botId: string }
  | { ready: false; why: "off" | "no-bot" | "no-key" };

/** Why the judge would not run, or the endpoint it runs on. */
export function judgeReadiness(input: {
  enabled: boolean;
  bots: CustomBot[];
  readKey: (credentialId: string) => string | null | undefined;
}): JudgeReadiness {
  if (!input.enabled) return { ready: false, why: "off" };
  const bot = judgeBotFor(input.bots);
  if (!bot?.credentialId) return { ready: false, why: "no-bot" };
  const apiKey = input.readKey(bot.credentialId)?.trim();
  if (!apiKey) return { ready: false, why: "no-key" };
  return { ready: true, endpoint: { baseUrl: bot.baseUrl, apiKey, model: JUDGE_MODEL }, botId: bot.id };
}

export type JudgeReportInput = {
  criteria: string[];
  report: string;
  workerStatus?: string;
  endpoint: JudgeEndpoint;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
  now?: () => number;
};

/**
 * One report, one verdict. Nothing to judge (no criteria, no report) is not
 * an error; it is no verdict. A failed call is a log line and no verdict.
 */
export async function judgeReport(input: JudgeReportInput): Promise<JudgeVerdict | undefined> {
  const criteria = input.criteria.map((item) => item.trim()).filter(Boolean);
  const report = input.report.trim();
  if (criteria.length === 0 || !report) return undefined;
  const { state, truncated } = judgeState(criteria, report, input.workerStatus);
  const questions = judgeQuestions(criteria);
  const result = await callJudge(input.endpoint, state, questions, { fetchImpl: input.fetchImpl });
  if (!result.ok) {
    input.log?.(`judge: no verdict (${result.status ?? "network"}: ${result.reason}) after ${result.elapsedMs} ms`);
    return undefined;
  }
  const verdict = verdictFromAnswers(criteria, result.answers, {
    model: result.model,
    usage: result.usage,
    truncated,
    at: input.now?.() ?? Date.now(),
  });
  input.log?.(`judge: ${criteria.length} criteria in ${result.elapsedMs} ms (${result.usage?.inputTokens ?? "?"} in)`);
  return verdict;
}
