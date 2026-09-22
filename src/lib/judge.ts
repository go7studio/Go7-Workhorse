/**
 * The judge: a finished worker's report scored against its mission's
 * acceptance criteria by an evaluation model. Its whole output is "what the
 * report's own text shows" — a probability per criterion — and it is named
 * that way everywhere: `reportSays`, with shown / not shown / unclear. Never
 * met, never verified. It ran nothing.
 *
 * Two rules from the adversarial pass before this was built:
 * - A score never removes a criterion from the next pass. A worker can write
 *   fluent fake evidence; if "shown" took work off the list, the judge would
 *   make that worse than today's honest self-report. Every criterion stays,
 *   and the pass is still told to verify the whole mission.
 * - A pass that could not be scored says so. Silence would read as clean.
 *
 * Pure. The HTTP call lives in electron/judge-client.ts; the desk-side glue
 * in electron/judge-desk.ts.
 */

export const JUDGE_MODEL = "typesafe-ai/jev";

/** One sentence that travels with every score, so no reader mistakes it. */
export const JUDGE_NOTE = "Scores the text of the report. It ran nothing and verified nothing.";

/** Above this a criterion reads shown; below `NOT_SHOWN_BELOW` it reads not shown. */
export const SHOWN_ABOVE = 0.8;
export const NOT_SHOWN_BELOW = 0.2;

/**
 * Jev's window is 32k tokens. Criteria and questions take a few hundred; the
 * report gets the rest. Head and tail both go in, because the status line a
 * worker declares is at the end and the work it did is at the start.
 */
export const REPORT_HEAD_CHARS = 16_000;
export const REPORT_TAIL_CHARS = 8_000;

/** Bounds main enforces before a request is built, so a mission cannot push Jev past its window. */
export const JUDGE_MAX_CRITERIA = 24;
export const JUDGE_CRITERION_CHARS = 400;
/** The bounded report plus its omission marker. Main refuses anything longer. */
export const JUDGE_REPORT_CHARS = REPORT_HEAD_CHARS + REPORT_TAIL_CHARS + 120;

/**
 * A report goes to the judge at most twice, and never twice within half a
 * minute. A judge that failed on every poll would bill on every poll and
 * stall every answer; the failure is kept on the run instead, with why.
 */
export const JUDGE_MAX_TRIES = 2;
export const JUDGE_RETRY_AFTER_MS = 30_000;

export type JudgeSettings = {
  enabled: boolean;
};

export const DEFAULT_JUDGE: JudgeSettings = { enabled: false };

export function normalizeJudge(raw: unknown): JudgeSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_JUDGE };
  const record = raw as Partial<JudgeSettings>;
  return { enabled: record.enabled === true };
}

export type JudgeQuestion =
  | { type: "boolean"; instructions: string; criteria: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

/** The gateway's answer shapes. `boolean` carries `probability`; the others carry `confidence`. */
export type JudgeAnswer =
  | { type: "boolean"; probability: number }
  | { type: "choice"; choice: string; probabilities?: Record<string, number>; confidence?: number }
  | { type: "score"; score: number; probabilities?: Record<string, number>; confidence?: number };

export type JudgeCriterionStatus = "shown" | "not-shown" | "unclear";

export type JudgeCriterionVerdict = {
  text: string;
  probability: number;
  status: JudgeCriterionStatus;
};

export type JudgeClaim = "consistent" | "overclaimed" | "underclaimed";

/**
 * One report's scores. No overall: a worker does its slice, so an honest
 * slice report shows few of the mission's criteria, and one grade for the
 * whole report would read as a grade for the mission.
 */
export type JudgeVerdict = {
  version: 1;
  at: number;
  model: string;
  criteria: JudgeCriterionVerdict[];
  /** The worker's own status line set against its evidence. */
  claim?: { choice: JudgeClaim; confidence?: number };
  /** 0 vague, 1 gaps, 2 concrete. */
  specificity?: { score: number; confidence?: number };
  usage?: { inputTokens?: number; outputTokens?: number };
  truncated: boolean;
};

/**
 * A judge call that gave no score, kept on the run so the next poll does not
 * bill again. `tries` counts only calls that reached the gateway.
 */
export type JudgeFailure = { at: number; why: string; tries: number };

export type JudgeOutcome = { verdict: JudgeVerdict } | { failed: JudgeFailure };

/** What rides on a status or await payload beside the report. */
export type ReportSays =
  | (JudgeVerdict & { status: "scored"; note: string })
  | { status: "not-scored"; why: string; note: string };

export const CLAIM_KEY = "claim";
export const SPECIFICITY_KEY = "specificity";

export function criterionKey(index: number): string {
  return `c${index + 1}`;
}

/** The worker's own last `status:` line, the way the desk already reads it. */
export function declaredStatus(text: string | undefined): "complete" | "continue" | "blocked" | undefined {
  if (!text) return undefined;
  const declarations = [...text.matchAll(/^\s*(?:mission\s+)?status:\s*(blocked|continue|complete(?:d)?)\s*[.!]?\s*$/gim)];
  const last = declarations.at(-1)?.[1]?.toLowerCase();
  if (!last) return undefined;
  return last.startsWith("complete") ? "complete" : (last as "continue" | "blocked");
}

/**
 * The report the judge reads. A long one keeps its head and its tail: the
 * work is at the start and the declared status line at the end.
 */
export function boundJudgeReport(report: string): { text: string; truncated: boolean } {
  const trimmed = report.trim();
  const limit = REPORT_HEAD_CHARS + REPORT_TAIL_CHARS;
  if (trimmed.length <= limit) return { text: trimmed, truncated: false };
  return {
    text: `${trimmed.slice(0, REPORT_HEAD_CHARS)}\n\n[… ${trimmed.length - limit} characters omitted …]\n\n${trimmed.slice(-REPORT_TAIL_CHARS)}`,
    truncated: true,
  };
}

/** Why a criteria list cannot go to the judge, or nothing. */
export function judgeCriteriaProblem(criteria: string[]): string | undefined {
  if (criteria.length > JUDGE_MAX_CRITERIA) return `${criteria.length} criteria; the judge takes at most ${JUDGE_MAX_CRITERIA}`;
  const long = criteria.findIndex((text) => text.length > JUDGE_CRITERION_CHARS);
  if (long >= 0) return `criterion ${long + 1} is ${criteria[long].length} characters; the judge takes at most ${JUDGE_CRITERION_CHARS}`;
  return undefined;
}

/**
 * What the model reads. The report is data here, never instructions. Pass
 * `truncatedAlready` for text that went through `boundJudgeReport` and was
 * cut, so it is not cut twice.
 */
export function judgeState(
  criteria: string[],
  report: string,
  workerStatus?: string,
  truncatedAlready = false,
): { state: Record<string, unknown>; truncated: boolean } {
  const { text, truncated } = truncatedAlready ? { text: report.trim(), truncated: true } : boundJudgeReport(report);
  return {
    state: {
      acceptance_criteria: criteria.map((text, index) => ({ id: criterionKey(index), text })),
      worker_report: text,
      ...(workerStatus ? { worker_declared_status: workerStatus } : {}),
      ...(truncated ? { note: "The report was longer than fits; its middle is omitted." } : {}),
    },
    truncated,
  };
}

/** 0 vague, 1 gaps, 2 concrete. A score off this scale is not an answer. */
const SPECIFICITY_SCALE = ["vague or empty", "some specifics, gaps remain", "concrete and complete"];

export function judgeQuestions(criteria: string[]): Record<string, JudgeQuestion> {
  const questions: Record<string, JudgeQuestion> = {};
  criteria.forEach((text, index) => {
    questions[criterionKey(index)] = {
      type: "boolean",
      instructions: `Does the worker report show, in its own text, direct evidence for this acceptance criterion: "${text}"? Judge only what the report shows. A claim with no specifics is not evidence.`,
      criteria: {
        true: "The report shows a concrete result, artifact, command output, or change that meets the criterion.",
        false: "The report does not address the criterion, addresses it without specifics, or shows it unmet or failing.",
      },
    };
  });
  questions[CLAIM_KEY] = {
    type: "choice",
    instructions: "Set the worker's own declared status against the evidence in its report.",
    criteria: {
      consistent: "The declared status matches what the evidence supports.",
      overclaimed: "The worker declares more done than its evidence supports.",
      underclaimed: "The evidence supports more than the worker declares.",
    },
  };
  questions[SPECIFICITY_KEY] = {
    type: "score",
    instructions: "How complete and specific is this report as evidence of the work?",
    criteria: [...SPECIFICITY_SCALE],
  };
  return questions;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A probability or a confidence: within 0..1, or not an answer. */
function unit(value: unknown): number | undefined {
  const number = finite(value);
  return number !== undefined && number >= 0 && number <= 1 ? number : undefined;
}

export function criterionStatus(probability: number, shownAbove = SHOWN_ABOVE, notShownBelow = NOT_SHOWN_BELOW): JudgeCriterionStatus {
  if (probability >= shownAbove) return "shown";
  if (probability <= notShownBelow) return "not-shown";
  return "unclear";
}

/**
 * Answers to a verdict. A missing or malformed answer reads unclear, never
 * shown: the judge's silence must not pass work.
 */
export function verdictFromAnswers(
  criteria: string[],
  answers: Record<string, unknown> | undefined,
  input: { model?: string; usage?: JudgeVerdict["usage"]; truncated?: boolean; at?: number; shownAbove?: number; notShownBelow?: number } = {},
): JudgeVerdict {
  const rows: JudgeCriterionVerdict[] = criteria.map((text, index) => {
    const answer = answers?.[criterionKey(index)] as Partial<Extract<JudgeAnswer, { type: "boolean" }>> | undefined;
    const probability = answer?.type === "boolean" ? unit(answer.probability) : undefined;
    if (probability === undefined) return { text, probability: 0.5, status: "unclear" };
    return { text, probability, status: criterionStatus(probability, input.shownAbove, input.notShownBelow) };
  });
  const claimAnswer = answers?.[CLAIM_KEY] as Partial<Extract<JudgeAnswer, { type: "choice" }>> | undefined;
  const choice = claimAnswer?.type === "choice" ? claimAnswer.choice : undefined;
  const claimChoice: JudgeClaim | undefined =
    choice === "consistent" || choice === "overclaimed" || choice === "underclaimed" ? choice : undefined;
  const claimConfidence = unit(claimAnswer?.confidence);
  const claim: JudgeVerdict["claim"] = claimChoice
    ? { choice: claimChoice, ...(claimConfidence !== undefined ? { confidence: claimConfidence } : {}) }
    : undefined;
  const scoreAnswer = answers?.[SPECIFICITY_KEY] as Partial<Extract<JudgeAnswer, { type: "score" }>> | undefined;
  const rawScore = scoreAnswer?.type === "score" ? finite(scoreAnswer.score) : undefined;
  const score = rawScore !== undefined && rawScore >= 0 && rawScore <= SPECIFICITY_SCALE.length - 1 ? rawScore : undefined;
  const specificity =
    score !== undefined
      ? { score, ...(unit(scoreAnswer?.confidence) !== undefined ? { confidence: unit(scoreAnswer?.confidence) } : {}) }
      : undefined;
  return {
    version: 1,
    at: input.at ?? Date.now(),
    model: input.model ?? JUDGE_MODEL,
    criteria: rows,
    ...(claim ? { claim } : {}),
    ...(specificity ? { specificity } : {}),
    ...(input.usage ? { usage: input.usage } : {}),
    truncated: input.truncated === true,
  };
}

/** A persisted verdict, or nothing. Never a partial: a half verdict would read as a whole one. */
export function normalizeJudgeVerdict(raw: unknown): JudgeVerdict | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Partial<JudgeVerdict>;
  if (row.version !== 1 || typeof row.at !== "number" || !Array.isArray(row.criteria)) return undefined;
  const criteria: JudgeCriterionVerdict[] = [];
  for (const item of row.criteria) {
    const entry = item as Partial<JudgeCriterionVerdict>;
    if (typeof entry?.text !== "string" || typeof entry.probability !== "number" || !Number.isFinite(entry.probability)) return undefined;
    if (entry.status !== "shown" && entry.status !== "not-shown" && entry.status !== "unclear") return undefined;
    criteria.push({ text: entry.text, probability: entry.probability, status: entry.status });
  }
  const claim =
    row.claim && (row.claim.choice === "consistent" || row.claim.choice === "overclaimed" || row.claim.choice === "underclaimed")
      ? { choice: row.claim.choice, ...(typeof row.claim.confidence === "number" ? { confidence: row.claim.confidence } : {}) }
      : undefined;
  const specificity =
    row.specificity && typeof row.specificity.score === "number"
      ? { score: row.specificity.score, ...(typeof row.specificity.confidence === "number" ? { confidence: row.specificity.confidence } : {}) }
      : undefined;
  return {
    version: 1,
    at: row.at,
    model: typeof row.model === "string" && row.model ? row.model : JUDGE_MODEL,
    criteria,
    ...(claim ? { claim } : {}),
    ...(specificity ? { specificity } : {}),
    ...(row.usage && typeof row.usage === "object" ? { usage: row.usage } : {}),
    truncated: row.truncated === true,
  };
}

export function normalizeJudgeFailure(raw: unknown): JudgeFailure | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Partial<JudgeFailure>;
  if (typeof row.at !== "number" || typeof row.why !== "string" || typeof row.tries !== "number" || !Number.isFinite(row.tries)) return undefined;
  return { at: row.at, why: row.why, tries: Math.max(0, Math.floor(row.tries)) };
}

/** Whether a finished run goes to the judge now: no score yet, a try left, and the retry gap past. */
export function judgeMayTry(run: { verdict?: JudgeVerdict; judgeFailed?: JudgeFailure } | undefined, now: number): boolean {
  if (!run || run.verdict) return false;
  const failed = run.judgeFailed;
  if (!failed) return true;
  if (failed.tries >= JUDGE_MAX_TRIES) return false;
  return now - failed.at >= JUDGE_RETRY_AFTER_MS;
}

/** The failure to keep after a call that gave no score. Only a call that reached the gateway counts as a try. */
export function judgeFailureAfter(previous: JudgeFailure | undefined, why: string, called: boolean, at: number): JudgeFailure {
  return { at, why, tries: (previous?.tries ?? 0) + (called ? 1 : 0) };
}

const GATEWAY_HOST = /(^|\.)ai-gateway\.vercel\.sh$/i;

/**
 * The custom bot whose key the judge borrows: the person's Vercel AI Gateway
 * bot, with a key stored and `typesafe-ai/jev` ticked like any other model.
 * The judge has no key of its own, no ring, and no model the person did not
 * approve; its spend shows on that bot's credits.
 */
export function judgeBotFor<T extends { baseUrl: string; model: string; models?: string[]; apiKey?: string; credentialId?: string; enabled?: boolean }>(
  bots: T[],
): T | undefined {
  return bots.find((bot) => {
    if (bot.enabled === false) return false;
    // A key just typed sits on the bot until the vault hands back its id.
    if (!bot.apiKey?.trim() && !bot.credentialId) return false;
    if (!(bot.models ?? [bot.model]).includes(JUDGE_MODEL)) return false;
    try {
      return GATEWAY_HOST.test(new URL(bot.baseUrl).hostname);
    } catch {
      return false;
    }
  });
}

/**
 * What a payload carries for one finished mission worker. With the judge on,
 * a worker that has no score says so, so a failed call never looks clean.
 */
export function reportSaysFor(
  run: { status?: string; verdict?: JudgeVerdict; judgeFailed?: JudgeFailure; mission?: { acceptanceCriteria?: string[] } } | undefined,
  judgeEnabled: boolean,
): ReportSays | undefined {
  if (!run?.mission?.acceptanceCriteria?.length) return undefined;
  if (run.verdict) return { ...run.verdict, status: "scored", note: JUDGE_NOTE };
  if (!judgeEnabled || run.status !== "completed") return undefined;
  return { status: "not-scored", why: run.judgeFailed?.why ?? "no score yet", note: JUDGE_NOTE };
}

function percent(probability: number): string {
  return `${Math.round(probability * 100)}%`;
}

/** One line for a label. */
export function verdictSummary(verdict: JudgeVerdict): string {
  const shown = verdict.criteria.filter((row) => row.status === "shown").length;
  const notShown = verdict.criteria.filter((row) => row.status === "not-shown").length;
  const unclear = verdict.criteria.length - shown - notShown;
  const parts = [`${shown} of ${verdict.criteria.length} shown`];
  if (notShown > 0) parts.push(`${notShown} not shown`);
  if (unclear > 0) parts.push(`${unclear} unclear`);
  if (verdict.claim && verdict.claim.choice !== "consistent") parts.push(verdict.claim.choice);
  return parts.join(" · ");
}

export type WaveGaps = {
  scored: number;
  unscored: number;
  /** No report in the pass showed it. */
  notShown: { text: string; best: number }[];
  /** Some report may have; none clearly did. */
  unclear: { text: string; best: number }[];
  overclaimed: number;
  truncated: number;
};

/**
 * Scores merged across a pass. A criterion is shown when any report shows
 * it, not shown when every scored report reads not shown, unclear otherwise.
 * Each worker did its slice, so the mission's evidence is spread across them.
 */
export function waveGaps(criteria: string[], says: (ReportSays | undefined)[]): WaveGaps {
  const scored = says.filter((item): item is Extract<ReportSays, { status: "scored" }> => item?.status === "scored");
  const unscored = says.filter((item) => item?.status === "not-scored").length;
  const notShown: WaveGaps["notShown"] = [];
  const unclear: WaveGaps["unclear"] = [];
  criteria.forEach((text) => {
    const rows = scored.map((item) => item.criteria.find((row) => row.text === text)).filter((row): row is JudgeCriterionVerdict => Boolean(row));
    if (rows.length === 0) return;
    const best = Math.max(...rows.map((row) => row.probability));
    if (rows.some((row) => row.status === "shown")) return;
    if (rows.every((row) => row.status === "not-shown")) notShown.push({ text, best });
    else unclear.push({ text, best });
  });
  return {
    scored: scored.length,
    unscored,
    notShown,
    unclear,
    overclaimed: scored.filter((item) => item.claim?.choice === "overclaimed").length,
    truncated: scored.filter((item) => item.truncated).length,
  };
}

/**
 * The block the next pass reads. It adds to the acceptance list; it never
 * shortens it. When nothing was scored it says that, in the same place.
 */
export function judgeBlockLines(gaps: WaveGaps): string[] {
  const lines = [`JUDGE (${JUDGE_NOTE} Every criterion above still applies.)`];
  if (gaps.scored === 0) {
    lines.push(`- The last pass was not scored${gaps.unscored > 0 ? ` (${gaps.unscored} report${gaps.unscored === 1 ? "" : "s"} without a score)` : ""}. Treat nothing as shown.`);
    return lines;
  }
  if (gaps.notShown.length > 0) {
    lines.push("- No report in the last pass showed evidence for:");
    for (const row of gaps.notShown) lines.push(`  - ${row.text} (${percent(row.best)})`);
  }
  if (gaps.unclear.length > 0) {
    lines.push("- Evidence was unclear for:");
    for (const row of gaps.unclear) lines.push(`  - ${row.text} (${percent(row.best)})`);
  }
  if (gaps.notShown.length === 0 && gaps.unclear.length === 0) {
    lines.push("- Every criterion had evidence in some report. That is what the reports say; verify it.");
  }
  if (gaps.unscored > 0) lines.push(`- ${gaps.unscored} report${gaps.unscored === 1 ? " was" : "s were"} not scored.`);
  if (gaps.overclaimed > 0) lines.push(`- ${gaps.overclaimed} report${gaps.overclaimed === 1 ? "" : "s"} declared more done than its own evidence showed.`);
  if (gaps.truncated > 0) lines.push(`- ${gaps.truncated} report${gaps.truncated === 1 ? " was" : "s were"} cut to fit; the middle was not scored.`);
  return lines;
}
