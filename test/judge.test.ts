import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLAIM_KEY,
  DEFAULT_JUDGE,
  JUDGE_MODEL,
  JUDGE_NOTE,
  REPORT_HEAD_CHARS,
  REPORT_TAIL_CHARS,
  SPECIFICITY_KEY,
  declaredStatus,
  judgeBlockLines,
  judgeBotFor,
  judgeQuestions,
  judgeState,
  normalizeJudge,
  normalizeJudgeVerdict,
  reportSaysFor,
  verdictFromAnswers,
  verdictSummary,
  waveGaps,
} from "../src/lib/judge";
import { callJudge, judgeUrl } from "../electron/judge-client";
import { judgeReadiness, judgeReport } from "../electron/judge-desk";
import { normalizeAgentRun } from "../src/lib/subagents";

const CRITERIA = ["All 807 tests pass", "The README mentions the new setting"];

// The gateway's answer, verbatim from the live call on 2026-09-22.
const LIVE_ANSWERS = {
  c1: { type: "boolean", probability: 0.98 },
  c2: { type: "boolean", probability: 0.02 },
  claim: { type: "choice", choice: "overclaimed", probabilities: { consistent: 0.42, overclaimed: 0.55, underclaimed: 0.03 }, confidence: 0.33 },
  specificity: { type: "score", score: 1.13, probabilities: { "0": 0, "1": 0.87, "2": 0.13 }, confidence: 0.8 },
};

test("judge is off unless the person turned it on", () => {
  assert.deepEqual(DEFAULT_JUDGE, { enabled: false });
  assert.deepEqual(normalizeJudge(undefined), { enabled: false });
  assert.deepEqual(normalizeJudge({ enabled: "yes" }), { enabled: false });
  assert.deepEqual(normalizeJudge({ enabled: true, extra: 1 }), { enabled: true });
});

test("the judge borrows the Vercel bot's key only when jev is ticked like any other model", () => {
  const bots = [
    { id: "a", baseUrl: "https://api.minimax.io/v1", model: "MiniMax-M3", credentialId: "k1" },
    { id: "b", baseUrl: "https://ai-gateway.vercel.sh/v1", model: "moonshotai/kimi-k3", credentialId: "k2" },
    { id: "c", baseUrl: "https://ai-gateway.vercel.sh/v1", model: "moonshotai/kimi-k3", models: ["moonshotai/kimi-k3", JUDGE_MODEL], credentialId: "k3" },
    { id: "d", baseUrl: "https://ai-gateway.vercel.sh/v1", model: JUDGE_MODEL, credentialId: "k4", enabled: false },
    { id: "e", baseUrl: "https://ai-gateway.vercel.sh/v1", model: JUDGE_MODEL },
  ];
  assert.equal(judgeBotFor(bots)?.id, "c");
  assert.equal(judgeBotFor(bots.filter((bot) => bot.id !== "c")), undefined);
  assert.equal(judgeBotFor([{ baseUrl: "not a url", model: JUDGE_MODEL, credentialId: "k" }]), undefined);
});

test("questions: one boolean per criterion, then the claim and specificity", () => {
  const questions = judgeQuestions(CRITERIA);
  assert.deepEqual(Object.keys(questions), ["c1", "c2", CLAIM_KEY, SPECIFICITY_KEY]);
  // The gateway rejects TypeSafe's own `noul`; the yes/no type is `boolean`.
  assert.equal(questions.c1.type, "boolean");
  assert.match(questions.c1.instructions, /All 807 tests pass/);
  assert.match(questions.c1.instructions, /Judge only what the report shows/);
  assert.equal(questions[CLAIM_KEY].type, "choice");
  assert.equal(questions[SPECIFICITY_KEY].type, "score");
});

test("state carries the criteria and the report as data; a long report keeps its head and its tail", () => {
  const short = judgeState(CRITERIA, "  did the work\nstatus: complete  ", "complete");
  assert.equal(short.truncated, false);
  assert.deepEqual(short.state.acceptance_criteria, [
    { id: "c1", text: CRITERIA[0] },
    { id: "c2", text: CRITERIA[1] },
  ]);
  assert.equal(short.state.worker_report, "did the work\nstatus: complete");
  assert.equal(short.state.worker_declared_status, "complete");
  const long = judgeState(CRITERIA, `${"H".repeat(REPORT_HEAD_CHARS + 500)}\n${"M".repeat(50_000)}\nstatus: blocked`);
  assert.equal(long.truncated, true);
  const text = String(long.state.worker_report);
  assert.ok(text.startsWith("H".repeat(100)));
  // The status line a worker declares is at the end. It must survive the cut.
  assert.ok(text.endsWith("status: blocked"));
  assert.ok(text.length < REPORT_HEAD_CHARS + REPORT_TAIL_CHARS + 200);
  assert.equal(declaredStatus("work\nstatus: complete\nmore\nStatus: blocked."), "blocked");
  assert.equal(declaredStatus("status: completed"), "complete");
  assert.equal(declaredStatus("no line"), undefined);
});

test("verdict: shown above 0.8, not shown below 0.2, unclear between; no overall grade", () => {
  const verdict = verdictFromAnswers(CRITERIA, LIVE_ANSWERS, { at: 1, model: "typesafe-ai/jev", usage: { inputTokens: 612, outputTokens: 95 } });
  assert.deepEqual(verdict.criteria, [
    { text: CRITERIA[0], probability: 0.98, status: "shown" },
    { text: CRITERIA[1], probability: 0.02, status: "not-shown" },
  ]);
  assert.equal("overall" in verdict, false);
  assert.deepEqual(verdict.claim, { choice: "overclaimed", confidence: 0.33 });
  assert.deepEqual(verdict.specificity, { score: 1.13, confidence: 0.8 });
  assert.equal(verdictSummary(verdict), "1 of 2 shown · 1 not shown · overclaimed");
  const none = verdictFromAnswers(CRITERIA, undefined);
  assert.ok(none.criteria.every((row) => row.status === "unclear" && row.probability === 0.5));
  const wrong = verdictFromAnswers(CRITERIA, { c1: { type: "choice", choice: "yes" }, c2: { type: "boolean", probability: "0.99" }, claim: { type: "choice", choice: "made-up" } });
  assert.ok(wrong.criteria.every((row) => row.status === "unclear"));
  assert.equal(wrong.claim, undefined);
});

test("a verdict survives the run record's normalizer, and a half verdict does not", () => {
  const verdict = verdictFromAnswers(CRITERIA, LIVE_ANSWERS, { at: 5 });
  const run = normalizeAgentRun({ status: "completed", startedAt: 1, isolation: "shared", verdict } as never, undefined);
  assert.deepEqual(run?.verdict, verdict);
  assert.equal(normalizeJudgeVerdict({ ...verdict, criteria: [{ text: "x", probability: 1, status: "met" }] }), undefined);
  assert.equal(normalizeJudgeVerdict({ version: 2 }), undefined);
  assert.equal(normalizeAgentRun({ status: "completed", startedAt: 1, isolation: "shared", verdict: { version: 1 } } as never, undefined)?.verdict, undefined);
});

test("reportSays: a score carries its note; with the judge on, a finished mission report without one says not-scored", () => {
  const verdict = verdictFromAnswers(CRITERIA, LIVE_ANSWERS, { at: 1 });
  const mission = { acceptanceCriteria: CRITERIA };
  const scored = reportSaysFor({ status: "completed", mission, verdict }, true);
  assert.equal(scored?.status, "scored");
  assert.equal(scored?.note, JUDGE_NOTE);
  assert.deepEqual(reportSaysFor({ status: "completed", mission }, true), { status: "not-scored", why: "no score for this report", note: JUDGE_NOTE });
  assert.equal(reportSaysFor({ status: "completed", mission }, false), undefined);
  assert.equal(reportSaysFor({ status: "running", mission }, true), undefined);
  assert.equal(reportSaysFor({ status: "completed" }, true), undefined);
  // Off, an old score still shows: it is a fact about that report.
  assert.equal(reportSaysFor({ status: "completed", mission, verdict }, false)?.status, "scored");
});

test("wave: a criterion shown by any report is not listed; not shown only when every scored report says so", () => {
  const note = JUDGE_NOTE;
  const a = { ...verdictFromAnswers(CRITERIA, { c1: { type: "boolean", probability: 0.95 }, c2: { type: "boolean", probability: 0.1 } }, { at: 1 }), status: "scored" as const, note };
  const b = { ...verdictFromAnswers(CRITERIA, { c1: { type: "boolean", probability: 0.1 }, c2: { type: "boolean", probability: 0.5 } }, { at: 1 }), status: "scored" as const, note };
  const gaps = waveGaps(CRITERIA, [a, b, { status: "not-scored", why: "x", note }, undefined]);
  assert.equal(gaps.scored, 2);
  assert.equal(gaps.unscored, 1);
  assert.deepEqual(gaps.notShown, []);
  assert.deepEqual(gaps.unclear, [{ text: CRITERIA[1], best: 0.5 }]);
  const lines = judgeBlockLines(gaps);
  assert.match(lines[0], /^JUDGE \(Scores the text of the report\. It ran nothing and verified nothing\. Every criterion above still applies\.\)/);
  assert.ok(lines.some((line) => /Evidence was unclear for:/.test(line)));
  assert.ok(lines.some((line) => /README.*\(50%\)/.test(line)));
  assert.ok(lines.some((line) => /1 report was not scored/.test(line)));
  // Never a "met" or "done" bucket the next pass could skip.
  assert.ok(lines.every((line) => !/\bmet\b|verified|done\b/i.test(line) || /verified nothing/.test(line)));
  const silent = judgeBlockLines(waveGaps(CRITERIA, [{ status: "not-scored", why: "403", note }]));
  assert.match(silent[1], /was not scored \(1 report without a score\)\. Treat nothing as shown\./);
  const clean = judgeBlockLines(waveGaps(CRITERIA, [{ ...verdictFromAnswers(CRITERIA, { c1: { type: "boolean", probability: 1 }, c2: { type: "boolean", probability: 0.9 } }, { at: 1 }), status: "scored" as const, note }]));
  assert.match(clean[1], /Every criterion had evidence in some report\. That is what the reports say; verify it\./);
});

function fakeFetch(status: number, body: unknown, capture?: { url?: string; init?: RequestInit }) {
  return async (url: string, init: RequestInit) => {
    if (capture) {
      capture.url = url;
      capture.init = init;
    }
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
}

test("client: posts the model in the body to <base>/evaluate and keeps only well-typed answers", async () => {
  const capture: { url?: string; init?: RequestInit } = {};
  const questions = judgeQuestions(CRITERIA);
  const result = await callJudge(
    { baseUrl: "https://ai-gateway.vercel.sh/v1/", apiKey: "vck_test" },
    { acceptance_criteria: [], worker_report: "x" },
    questions,
    { fetchImpl: fakeFetch(200, { model: "typesafe-ai/jev", answers: { ...LIVE_ANSWERS, c2: { type: "score", score: 2 } }, usage: { inputTokens: 612, outputTokens: 95 } }, capture) },
  );
  assert.equal(judgeUrl("https://ai-gateway.vercel.sh/v1/"), "https://ai-gateway.vercel.sh/v1/evaluate");
  assert.equal(capture.url, "https://ai-gateway.vercel.sh/v1/evaluate");
  const sent = JSON.parse(String(capture.init?.body));
  assert.equal(sent.model, JUDGE_MODEL);
  assert.equal((capture.init?.headers as Record<string, string>).Authorization, "Bearer vck_test");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.answers.c1, { type: "boolean", probability: 0.98 });
  assert.equal(result.answers.c2, undefined);
  assert.deepEqual(result.usage, { inputTokens: 612, outputTokens: 95 });
});

test("client: never throws; a 400, a 403, a non-JSON body and a timeout come back as ok:false", async () => {
  const questions = judgeQuestions(CRITERIA);
  const endpoint = { baseUrl: "https://ai-gateway.vercel.sh/v1", apiKey: "k" };
  const bad = await callJudge(endpoint, {}, questions, { fetchImpl: fakeFetch(400, { error: { message: "questions.c1.type: Invalid discriminator value" } }) });
  assert.deepEqual([bad.ok, (bad as { status?: number }).status], [false, 400]);
  const tier = await callJudge(endpoint, {}, questions, { fetchImpl: fakeFetch(403, { error: { message: "Free tier users do not have access to this model." } }) });
  assert.match((tier as { reason: string }).reason, /Free tier/);
  assert.equal((await callJudge(endpoint, {}, questions, { fetchImpl: fakeFetch(200, "<!DOCTYPE html>") })).ok, false);
  assert.equal((await callJudge(endpoint, {}, questions, { fetchImpl: fakeFetch(200, { answers: {} }) })).ok, false);
  const slow = await callJudge(endpoint, {}, questions, {
    timeoutMs: 20,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
  });
  assert.match((slow as { reason: string }).reason, /timed out after 20 ms/);
});

test("desk: readiness names why the judge would not run, and a report is scored once with the bot's key", async () => {
  const bots = [{ id: "v", name: "Vercel", color: "#000", baseUrl: "https://ai-gateway.vercel.sh/v1", model: JUDGE_MODEL, credentialId: "cred" }] as never;
  assert.deepEqual(judgeReadiness({ enabled: false, bots, readKey: () => "k" }), { ready: false, why: "off" });
  assert.deepEqual(judgeReadiness({ enabled: true, bots: [], readKey: () => "k" }), { ready: false, why: "no-bot" });
  assert.deepEqual(judgeReadiness({ enabled: true, bots, readKey: () => "" }), { ready: false, why: "no-key" });
  const ready = judgeReadiness({ enabled: true, bots, readKey: (id) => (id === "cred" ? "vck_x" : null) });
  assert.equal(ready.ready, true);
  if (!ready.ready) return;
  assert.deepEqual(ready.endpoint, { baseUrl: "https://ai-gateway.vercel.sh/v1", apiKey: "vck_x", model: JUDGE_MODEL });
  const lines: string[] = [];
  const verdict = await judgeReport({
    criteria: CRITERIA,
    report: "Ran npm test: 807 pass.\nstatus: complete",
    workerStatus: "complete",
    endpoint: ready.endpoint,
    fetchImpl: fakeFetch(200, { model: "typesafe-ai/jev", answers: LIVE_ANSWERS, usage: { inputTokens: 612, outputTokens: 95 } }),
    log: (line) => lines.push(line),
    now: () => 7,
  });
  assert.equal(verdict?.at, 7);
  assert.equal(verdict?.criteria[0].status, "shown");
  assert.match(lines[0], /judge: 2 criteria in \d+ ms \(612 in\)/);
  assert.equal(await judgeReport({ criteria: [], report: "x", endpoint: ready.endpoint, fetchImpl: fakeFetch(200, {}) }), undefined);
  const failed: string[] = [];
  assert.equal(await judgeReport({ criteria: CRITERIA, report: "x", endpoint: ready.endpoint, fetchImpl: fakeFetch(403, { error: { message: "no" } }), log: (line) => failed.push(line) }), undefined);
  assert.match(failed[0], /judge: no verdict \(403: no\)/);
});
