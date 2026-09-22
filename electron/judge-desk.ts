/**
 * The desk's side of the judge: find the key, score one report, say what
 * happened. Runs in main, where the credential store is. Never throws.
 */
import { callJudge, type FetchLike, type JudgeEndpoint } from "./judge-client";
import {
  JUDGE_MODEL,
  JUDGE_REPORT_CHARS,
  judgeBotsFor,
  judgeCriteriaProblem,
  judgeQuestions,
  judgeState,
  verdictFromAnswers,
  type JudgeVerdict,
} from "../src/lib/judge";
import type { CustomBot } from "../src/lib/types";

export type JudgeReadiness =
  | { ready: true; endpoint: JudgeEndpoint; botId: string }
  | { ready: false; why: "off" | "no-bot" | "no-key" };

/**
 * Why the judge would not run, or the endpoint it runs on. `readKey` is the
 * caller's own resolution for a bot's key, so the judge borrows it the way a
 * chat on that bot does. Every bot with jev ticked is tried; the first with
 * a real key wins, so one stale slot does not hide a good one.
 */
export function judgeReadiness(input: {
  enabled: boolean;
  bots: CustomBot[];
  readKey: (bot: CustomBot) => string | null | undefined;
}): JudgeReadiness {
  if (!input.enabled) return { ready: false, why: "off" };
  const candidates = judgeBotsFor(input.bots);
  if (candidates.length === 0) return { ready: false, why: "no-bot" };
  for (const bot of candidates) {
    const apiKey = input.readKey(bot)?.trim();
    if (apiKey) return { ready: true, endpoint: { baseUrl: bot.baseUrl, apiKey, model: JUDGE_MODEL }, botId: bot.id };
  }
  return { ready: false, why: "no-key" };
}

export type JudgeReportInput = {
  criteria: string[];
  report: string;
  /** The report already went through `boundJudgeReport` and was cut. */
  truncated?: boolean;
  workerStatus?: string;
  endpoint: JudgeEndpoint;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
  now?: () => number;
};

/**
 * One report, one outcome. No score says why, whether the call reached the
 * gateway (so the desk can count tries), and what was billed anyway.
 */
export type JudgeReportOutcome = { verdict: JudgeVerdict } | { why: string; called: boolean; usage?: JudgeVerdict["usage"] };

/**
 * Nothing to judge (no criteria, no report) is not an error; it is no
 * verdict. Over the bounds, the request is never built. A failed call is a
 * log line and no verdict.
 */
export async function judgeReport(input: JudgeReportInput): Promise<JudgeReportOutcome> {
  const criteria = input.criteria.map((item) => item.trim()).filter(Boolean);
  const report = input.report.trim();
  if (criteria.length === 0) return { why: "no acceptance criteria to score against", called: false };
  if (!report) return { why: "the worker left no report to score", called: false };
  const problem =
    judgeCriteriaProblem(criteria) ??
    (report.length > JUDGE_REPORT_CHARS ? `the report is ${report.length} characters; the judge takes at most ${JUDGE_REPORT_CHARS}` : undefined);
  if (problem) {
    input.log?.(`judge: not sent (${problem})`);
    return { why: problem, called: false };
  }
  const { state, truncated } = judgeState(criteria, report, input.workerStatus, input.truncated === true);
  const questions = judgeQuestions(criteria);
  const result = await callJudge(input.endpoint, state, questions, { fetchImpl: input.fetchImpl });
  if (!result.ok) {
    input.log?.(`judge: no verdict (${result.status ?? "network"}: ${result.reason}) after ${result.elapsedMs} ms`);
    return { why: result.status ? `${result.status}: ${result.reason}` : result.reason, called: result.reached, ...(result.usage ? { usage: result.usage } : {}) };
  }
  const verdict = verdictFromAnswers(criteria, result.answers, {
    model: result.model,
    usage: result.usage,
    truncated,
    at: input.now?.() ?? Date.now(),
  });
  input.log?.(`judge: ${criteria.length} criteria in ${result.elapsedMs} ms (${result.usage?.inputTokens ?? "?"} in)`);
  return { verdict };
}
