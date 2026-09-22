import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLAIM_KEY,
  DEFAULT_JUDGE,
  JUDGE_CRITERION_CHARS,
  JUDGE_FORGET_AFTER_MS,
  JUDGE_MAX_CRITERIA,
  JUDGE_MAX_TRIES,
  JUDGE_MODEL,
  JUDGE_NOTE,
  JUDGE_REPORT_CHARS,
  JUDGE_RETRY_AFTER_MS,
  REPORT_HEAD_CHARS,
  REPORT_TAIL_CHARS,
  SPECIFICITY_KEY,
  boundJudgeReport,
  declaredStatus,
  forgetJudgeFailures,
  judgeBlockLines,
  judgeBotFor,
  judgeBotsFor,
  judgeCriteriaProblem,
  judgeFailureAfter,
  judgeMayTry,
  judgeQuestions,
  judgeRunKey,
  judgeState,
  normalizeJudge,
  normalizeJudgeFailure,
  normalizeJudgeVerdict,
  reportSaysFor,
  verdictFromAnswers,
  verdictSummary,
  waveGaps,
} from "../src/lib/judge";
import { JUDGE_TIMEOUT_MS, callJudge, judgeUrl } from "../electron/judge-client";
import { judgeReadiness, judgeReport } from "../electron/judge-desk";
import { applyJudgeOutcomes, continueWorkerRun, normalizeAgentRun, workerReportText } from "../src/lib/subagents";
import {
  createJudgeSlots,
  judgeSlotKey,
  outcomeShownOnRun,
  rearmJudgeSlots,
  runWithOutcome,
  sweepJudgeSlots,
  type JudgeSlot,
} from "../src/lib/judge-slots";
import type { Session } from "../src/lib/types";

const CRITERIA = ["All 807 tests pass", "The README mentions the new setting"];
const VERCEL = "https://ai-gateway.vercel.sh/v1";

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
    { id: "b", baseUrl: VERCEL, model: "moonshotai/kimi-k3", credentialId: "k2" },
    { id: "c", baseUrl: VERCEL, model: "moonshotai/kimi-k3", models: ["moonshotai/kimi-k3", JUDGE_MODEL], credentialId: "k3" },
    { id: "d", baseUrl: VERCEL, model: JUDGE_MODEL, credentialId: "k4", enabled: false },
    { id: "e", baseUrl: VERCEL, model: JUDGE_MODEL },
  ];
  assert.equal(judgeBotFor(bots)?.id, "c");
  assert.equal(judgeBotFor(bots.filter((bot) => bot.id !== "c")), undefined);
  // Every candidate, in order: main walks them, since only main can tell whose key is real.
  assert.deepEqual(judgeBotsFor([...bots, { id: "f", baseUrl: VERCEL, model: JUDGE_MODEL, credentialId: "k6" }]).map((bot) => bot.id), ["c", "f"]);
  assert.equal(judgeBotFor([{ baseUrl: "not a url", model: JUDGE_MODEL, credentialId: "k" }]), undefined);
  // A key just typed sits on the bot until the vault hands back its id. That bot is ready; a blank key is not.
  assert.equal(judgeBotFor([{ baseUrl: VERCEL, model: JUDGE_MODEL, apiKey: "vck_fresh" }])?.apiKey, "vck_fresh");
  assert.equal(judgeBotFor([{ baseUrl: VERCEL, model: JUDGE_MODEL, apiKey: "  " }]), undefined);
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

test("state carries the criteria and the report as data; a long report keeps its head and its tail, and is cut once", () => {
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
  // The renderer cuts before IPC; main takes cut text as cut and never cuts it again.
  const cut = boundJudgeReport(`${"H".repeat(REPORT_HEAD_CHARS + 500)}\n${"M".repeat(50_000)}\nstatus: blocked`);
  assert.equal(cut.truncated, true);
  assert.ok(cut.text.length <= JUDGE_REPORT_CHARS);
  assert.equal(cut.text, text);
  const again = judgeState(CRITERIA, cut.text, undefined, true);
  assert.equal(again.state.worker_report, cut.text);
  assert.equal(again.truncated, true);
  assert.deepEqual(boundJudgeReport("  short  "), { text: "short", truncated: false });
  assert.equal(declaredStatus("work\nstatus: complete\nmore\nStatus: blocked."), "blocked");
  assert.equal(declaredStatus("status: completed"), "complete");
  assert.equal(declaredStatus("no line"), undefined);
});

test("verdict: shown above 0.8, not shown below 0.2, unclear between; no overall grade; off the scale is no answer", () => {
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
  // 200% is not a probability, 3 is not a confidence, 7 is not on a 0..2 scale.
  const range = verdictFromAnswers(CRITERIA, {
    c1: { type: "boolean", probability: 2 },
    c2: { type: "boolean", probability: -0.1 },
    claim: { type: "choice", choice: "consistent", confidence: 3 },
    specificity: { type: "score", score: 7, confidence: 0.5 },
  });
  assert.ok(range.criteria.every((row) => row.status === "unclear" && row.probability === 0.5));
  assert.deepEqual(range.claim, { choice: "consistent" });
  assert.equal(range.specificity, undefined);
});

test("a verdict and a failure survive the run record's normalizer; a half of either does not", () => {
  const verdict = verdictFromAnswers(CRITERIA, LIVE_ANSWERS, { at: 5 });
  const run = normalizeAgentRun({ status: "completed", startedAt: 1, isolation: "shared", verdict } as never, undefined);
  assert.deepEqual(run?.verdict, verdict);
  assert.equal(normalizeJudgeVerdict({ ...verdict, criteria: [{ text: "x", probability: 1, status: "met" }] }), undefined);
  assert.equal(normalizeJudgeVerdict({ version: 2 }), undefined);
  assert.equal(normalizeAgentRun({ status: "completed", startedAt: 1, isolation: "shared", verdict: { version: 1 } } as never, undefined)?.verdict, undefined);
  const failed = { at: 9, why: "403: no", tries: 1 };
  assert.deepEqual(normalizeAgentRun({ status: "completed", startedAt: 1, isolation: "shared", judgeFailed: failed } as never, undefined)?.judgeFailed, failed);
  assert.equal(normalizeJudgeFailure({ at: 9, why: "x" }), undefined);
  assert.deepEqual(normalizeJudgeFailure({ at: 9, why: "x", tries: 1.7 }), { at: 9, why: "x", tries: 1 });
  assert.equal(normalizeAgentRun({ status: "completed", startedAt: 1, isolation: "shared", judgeFailed: { at: "9" } } as never, undefined)?.judgeFailed, undefined);
});

test("reportSays: a score carries its note; with the judge on, a finished mission report without one says not-scored, and why", () => {
  const verdict = verdictFromAnswers(CRITERIA, LIVE_ANSWERS, { at: 1 });
  const mission = { acceptanceCriteria: CRITERIA };
  const scored = reportSaysFor({ status: "completed", mission, verdict }, true);
  assert.equal(scored?.status, "scored");
  assert.equal(scored?.note, JUDGE_NOTE);
  assert.deepEqual(reportSaysFor({ status: "completed", mission }, true), { status: "not-scored", why: "no score yet", note: JUDGE_NOTE });
  const failed = { at: 2, why: "403: customer_verification_required", tries: 1 };
  assert.deepEqual(reportSaysFor({ status: "completed", mission, judgeFailed: failed }, true), { status: "not-scored", why: failed.why, note: JUDGE_NOTE });
  assert.equal(reportSaysFor({ status: "completed", mission }, false), undefined);
  assert.equal(reportSaysFor({ status: "running", mission }, true), undefined);
  assert.equal(reportSaysFor({ status: "completed" }, true), undefined);
  // Off, an old score still shows: it is a fact about that report.
  assert.equal(reportSaysFor({ status: "completed", mission, verdict }, false)?.status, "scored");
});

test("a report goes to the judge at most twice, never twice within the retry gap; only a call that reached the gateway counts", () => {
  const verdict = verdictFromAnswers(CRITERIA, LIVE_ANSWERS, { at: 1 });
  assert.equal(judgeMayTry(undefined, 0), false);
  assert.equal(judgeMayTry({ verdict }, 0), false);
  assert.equal(judgeMayTry({}, 0), true);
  const first = judgeFailureAfter(undefined, "timed out after 4000 ms", true, 1_000);
  assert.deepEqual(first, { at: 1_000, why: "timed out after 4000 ms", tries: 1 });
  assert.equal(judgeMayTry({ judgeFailed: first }, 1_000 + JUDGE_RETRY_AFTER_MS - 1), false);
  assert.equal(judgeMayTry({ judgeFailed: first }, 1_000 + JUDGE_RETRY_AFTER_MS), true);
  const second = judgeFailureAfter(first, "403: no", true, 60_000);
  assert.equal(second.tries, JUDGE_MAX_TRIES);
  // Exhausted for the rest of the hour.
  assert.equal(judgeMayTry({ judgeFailed: second }, 60_000 + JUDGE_FORGET_AFTER_MS - 1), false);
  // No bot, no key, nothing to send: the desk answered without the gateway. That is not a try.
  const cheap = judgeFailureAfter(undefined, "no-key", false, 5);
  assert.equal(cheap.tries, 0);
  assert.equal(judgeMayTry({ judgeFailed: cheap }, 5 + JUDGE_RETRY_AFTER_MS), true);
  // An hour on, the failures are forgotten: two tries again, counted from zero.
  assert.equal(judgeMayTry({ judgeFailed: second }, 60_000 + JUDGE_FORGET_AFTER_MS), true);
  assert.equal(judgeFailureAfter(second, "503: gone", true, 60_000 + JUDGE_FORGET_AFTER_MS).tries, 1);
  // Saving a bot or switching the judge back on forgets them now. Scores stay.
  const sessions = [{ id: "a", agentRun: { judgeFailed: second } }, { id: "b", agentRun: { verdict } }, { id: "c" }];
  const forgotten = forgetJudgeFailures(sessions);
  assert.equal("judgeFailed" in forgotten[0].agentRun!, false);
  assert.deepEqual(forgotten[1], sessions[1]);
  assert.equal(forgetJudgeFailures(forgotten), forgotten);
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

test("client: posts the model in the body to <base>/evaluate and keeps only well-typed answers on their scale", async () => {
  const capture: { url?: string; init?: RequestInit } = {};
  const questions = judgeQuestions(CRITERIA);
  const result = await callJudge(
    { baseUrl: `${VERCEL}/`, apiKey: "vck_test" },
    { acceptance_criteria: [], worker_report: "x" },
    questions,
    { fetchImpl: fakeFetch(200, { model: "typesafe-ai/jev", answers: { ...LIVE_ANSWERS, c2: { type: "score", score: 2 } }, usage: { inputTokens: 612, outputTokens: 95 } }, capture) },
  );
  assert.equal(judgeUrl(`${VERCEL}/`), `${VERCEL}/evaluate`);
  assert.equal(capture.url, `${VERCEL}/evaluate`);
  const sent = JSON.parse(String(capture.init?.body));
  assert.equal(sent.model, JUDGE_MODEL);
  assert.equal((capture.init?.headers as Record<string, string>).Authorization, "Bearer vck_test");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.answers.c1, { type: "boolean", probability: 0.98 });
  assert.equal(result.answers.c2, undefined);
  assert.deepEqual(result.usage, { inputTokens: 612, outputTokens: 95 });
  const endpoint = { baseUrl: VERCEL, apiKey: "k" };
  // A claim with no criterion scored is no verdict: it would persist as scored with every criterion unclear.
  const claimOnly = await callJudge(endpoint, {}, questions, { fetchImpl: fakeFetch(200, { answers: { claim: { type: "choice", choice: "consistent" } } }) });
  assert.deepEqual([claimOnly.ok, (claimOnly as { reason: string }).reason], [false, "no criterion answers in response"]);
  // Off the scale is not an answer: 200% is dropped, a score of 5 on 0..2 is dropped, and c2 alone carries the verdict.
  const range = await callJudge(endpoint, {}, questions, {
    fetchImpl: fakeFetch(200, { answers: { c1: { type: "boolean", probability: 2 }, c2: { type: "boolean", probability: 0.1 }, specificity: { type: "score", score: 5 }, claim: { type: "choice", choice: "consistent", confidence: 4 } } }),
  });
  assert.equal(range.ok, true);
  if (range.ok) {
    assert.deepEqual(Object.keys(range.answers).sort(), ["c2", "claim"]);
    assert.deepEqual(range.answers.claim, { type: "choice", choice: "consistent" });
  }
  // The judge answers inside a status reply, and the Link's bridge waits 8 seconds for one.
  assert.ok(JUDGE_TIMEOUT_MS < 8_000);
  // A 200 with nothing usable was billed all the same: the failure carries the bill and says the gateway was reached.
  const billed = await callJudge(endpoint, {}, questions, { fetchImpl: fakeFetch(200, { answers: { claim: { type: "choice", choice: "consistent" } }, usage: { inputTokens: 100, outputTokens: 5 } }) });
  assert.deepEqual([billed.ok, (billed as { reached: boolean }).reached, (billed as { usage?: unknown }).usage], [false, true, { inputTokens: 100, outputTokens: 5 }]);
  // A request that never left is no try: DNS, TLS, no network.
  const offline = await callJudge(endpoint, {}, questions, { fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  assert.deepEqual([offline.ok, (offline as { reason: string }).reason, (offline as { reached: boolean }).reached], [false, "fetch failed", false]);
  // A response whose body fails to read was still handled, and maybe billed: it reached.
  const torn = await callJudge(endpoint, {}, questions, {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => { throw new Error("body reset"); } }) as unknown as Response,
  });
  assert.deepEqual([torn.ok, (torn as { reason: string }).reason, (torn as { reached: boolean }).reached], [false, "body reset", true]);
});

test("client: never throws; a 400, a 403, a non-JSON body and a timeout come back as ok:false", async () => {
  const questions = judgeQuestions(CRITERIA);
  const endpoint = { baseUrl: VERCEL, apiKey: "k" };
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
  // A timeout may have been billed on the far side; it counts as reached.
  assert.equal((slow as { reached: boolean }).reached, true);
});

test("bounds: too many or too long criteria, or a report past the cut, never reach the gateway", async () => {
  assert.equal(judgeCriteriaProblem(CRITERIA), undefined);
  assert.match(judgeCriteriaProblem(Array.from({ length: JUDGE_MAX_CRITERIA + 1 }, (_, index) => `c${index}`)) ?? "", /25 criteria; the judge takes at most 24/);
  assert.match(judgeCriteriaProblem(["ok", "A".repeat(JUDGE_CRITERION_CHARS + 1)]) ?? "", /criterion 2 is 401 characters; the judge takes at most 400/);
  let calls = 0;
  const endpoint = { baseUrl: VERCEL, apiKey: "k" };
  const counting = async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  };
  const lines: string[] = [];
  const many = await judgeReport({ criteria: Array.from({ length: 25 }, (_, index) => `c${index}`), report: "x", endpoint, fetchImpl: counting, log: (line) => lines.push(line) });
  assert.deepEqual(many, { why: "25 criteria; the judge takes at most 24", called: false });
  const huge = await judgeReport({ criteria: CRITERIA, report: "R".repeat(JUDGE_REPORT_CHARS + 1), endpoint, fetchImpl: counting });
  assert.deepEqual(huge, { why: `the report is ${JUDGE_REPORT_CHARS + 1} characters; the judge takes at most ${JUDGE_REPORT_CHARS}`, called: false });
  assert.equal(calls, 0);
  assert.match(lines[0], /judge: not sent \(25 criteria/);
});

test("desk: readiness names why the judge would not run, reads the key the way a chat would, and a report's outcome says whether the gateway was reached", async () => {
  const bots = [{ id: "v", name: "Vercel", color: "#000", baseUrl: VERCEL, model: JUDGE_MODEL, credentialId: "cred" }] as never;
  assert.deepEqual(judgeReadiness({ enabled: false, bots, readKey: () => "k" }), { ready: false, why: "off" });
  assert.deepEqual(judgeReadiness({ enabled: true, bots: [], readKey: () => "k" }), { ready: false, why: "no-bot" });
  assert.deepEqual(judgeReadiness({ enabled: true, bots, readKey: () => "" }), { ready: false, why: "no-key" });
  const ready = judgeReadiness({ enabled: true, bots, readKey: (bot) => (bot.credentialId === "cred" ? "vck_x" : null) });
  assert.equal(ready.ready, true);
  if (!ready.ready) return;
  assert.deepEqual(ready.endpoint, { baseUrl: VERCEL, apiKey: "vck_x", model: JUDGE_MODEL });
  assert.equal(ready.botId, "v");
  // A fresh bot holds its key in memory until the vault hands back an id; the caller's own resolution reads it.
  const fresh = [{ id: "f", name: "Vercel", color: "#000", baseUrl: VERCEL, model: JUDGE_MODEL, apiKey: "vck_fresh" }] as never;
  assert.equal(judgeReadiness({ enabled: true, bots: fresh, readKey: (bot) => bot.apiKey }).ready, true);
  // One stale slot does not hide a good one: every jev bot is tried, the first with a real key wins.
  const stale = { id: "s", name: "Old", color: "#000", baseUrl: VERCEL, model: JUDGE_MODEL, credentialId: "gone" };
  const two = judgeReadiness({ enabled: true, bots: [stale, ...(bots as never[])] as never, readKey: (bot) => (bot.credentialId === "cred" ? "vck_x" : null) });
  assert.equal(two.ready && two.botId, "v");
  assert.deepEqual(judgeReadiness({ enabled: true, bots: [stale] as never, readKey: () => null }), { ready: false, why: "no-key" });
  const lines: string[] = [];
  const outcome = await judgeReport({
    criteria: CRITERIA,
    report: "Ran npm test: 807 pass.\nstatus: complete",
    workerStatus: "complete",
    endpoint: ready.endpoint,
    fetchImpl: fakeFetch(200, { model: "typesafe-ai/jev", answers: LIVE_ANSWERS, usage: { inputTokens: 612, outputTokens: 95 } }),
    log: (line) => lines.push(line),
    now: () => 7,
  });
  assert.ok("verdict" in outcome);
  if (!("verdict" in outcome)) return;
  assert.equal(outcome.verdict.at, 7);
  assert.equal(outcome.verdict.criteria[0].status, "shown");
  assert.match(lines[0], /judge: 2 criteria in \d+ ms \(612 in\)/);
  assert.deepEqual(await judgeReport({ criteria: [], report: "x", endpoint: ready.endpoint, fetchImpl: fakeFetch(200, {}) }), { why: "no acceptance criteria to score against", called: false });
  assert.deepEqual(await judgeReport({ criteria: CRITERIA, report: "   ", endpoint: ready.endpoint, fetchImpl: fakeFetch(200, {}) }), { why: "the worker left no report to score", called: false });
  const failed: string[] = [];
  assert.deepEqual(
    await judgeReport({ criteria: CRITERIA, report: "x", endpoint: ready.endpoint, fetchImpl: fakeFetch(403, { error: { message: "no" } }), log: (line) => failed.push(line) }),
    { why: "403: no", called: true },
  );
  assert.match(failed[0], /judge: no verdict \(403: no\)/);
  // No verdict, but billed: the outcome carries the bill so the ledger still gets it.
  const billed = await judgeReport({
    criteria: CRITERIA,
    report: "x",
    endpoint: ready.endpoint,
    fetchImpl: fakeFetch(200, { answers: { claim: { type: "choice", choice: "consistent" } }, usage: { inputTokens: 100, outputTokens: 5 } }),
  });
  assert.deepEqual(billed, { why: "200: no criterion answers in response", called: true, usage: { inputTokens: 100, outputTokens: 5 } });
  // A request that never left is not a try.
  const offline = await judgeReport({ criteria: CRITERIA, report: "x", endpoint: ready.endpoint, fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  assert.deepEqual(offline, { why: "fetch failed", called: false });
});

test("the judge reads this run's reply, not a reused worker's earlier pass; outcomes land on the run", () => {
  const message = (id: string, role: "user" | "assistant", createdAt: number, text: string, kind?: "tool") => ({ id, role, createdAt, text, ...(kind ? { kind } : {}) });
  const earlier = message("m1", "assistant", 10, "Earlier pass: all done.\nstatus: complete");
  const run = normalizeAgentRun({ status: "completed", startedAt: 100, isolation: "shared" } as never, undefined)!;
  // Tool rows only since the run began: no report, and not the earlier pass's.
  assert.equal(workerReportText({ messages: [earlier, message("m2", "user", 100, "new slice"), message("m3", "assistant", 120, "ran tests", "tool")], agentRun: run }), "");
  assert.equal(
    workerReportText({ messages: [earlier, message("m2", "user", 100, "new slice"), message("m4", "assistant", 130, "New pass: fixed it.\nstatus: complete")], agentRun: run }),
    "New pass: fixed it.\nstatus: complete",
  );
  // No run to bound by: the last reply.
  assert.equal(workerReportText({ messages: [earlier] }), "Earlier pass: all done.\nstatus: complete");
  // A retired worker's messages are gone and its retained report stands in. With replies present, it does not.
  assert.equal(workerReportText({ messages: [], retainedReport: " kept ", agentRun: run }), "kept");
  assert.equal(workerReportText({ messages: [earlier], retainedReport: "kept", agentRun: run }), "");
  const verdict = verdictFromAnswers(CRITERIA, LIVE_ANSWERS, { at: 1 });
  const failed = { at: 2, why: "timed out after 4000 ms", tries: 1 };
  // A run's key is its own id; a run saved by an older desk has only its start.
  assert.equal(judgeRunKey(run), "start:100");
  const withId = normalizeAgentRun({ status: "completed", startedAt: 100, isolation: "shared", runId: "run_1" } as never, undefined)!;
  assert.equal(withId.runId, "run_1");
  assert.equal(judgeRunKey(withId), "run:run_1");
  const sessions = [{ id: "a", agentRun: run }, { id: "b", agentRun: run }, { id: "c" }, { id: "d", agentRun: withId }] as unknown as Session[];
  const applied = applyJudgeOutcomes(
    sessions,
    new Map([
      ["a", { verdict, runKey: "start:100" }],
      ["b", { failed, runKey: "start:100" }],
      ["c", { failed, runKey: "start:100" }],
      // Scored the run before this one: the worker was reused with the same start. That outcome is not this run's.
      ["d", { verdict, runKey: "start:100" }],
    ]),
  );
  assert.deepEqual(applied[0].agentRun?.verdict, verdict);
  assert.deepEqual(applied[1].agentRun?.judgeFailed, failed);
  assert.equal(applied[2].agentRun, undefined);
  assert.equal(applied[3], sessions[3]);
  assert.equal(applyJudgeOutcomes(sessions, new Map()), sessions);
  // A finished worker sent on is a new run: new id, no score and no failure carried; a checkpoint on a live one keeps all three.
  const done = normalizeAgentRun({ status: "completed", startedAt: 100, isolation: "shared", runId: "run_1", verdict, judgeFailed: failed } as never, undefined)!;
  const next = continueWorkerRun(done, { now: 200 });
  assert.ok(next.runId && next.runId !== "run_1");
  assert.equal(next.verdict, undefined);
  assert.equal(next.judgeFailed, undefined);
  const live = normalizeAgentRun({ status: "running", startedAt: 100, isolation: "shared", runId: "run_1", verdict } as never, undefined, true)!;
  const kept = continueWorkerRun(live, { now: 200 });
  assert.equal(kept.runId, "run_1");
  assert.deepEqual(kept.verdict, verdict);
});

test("the judge's table: a slot lives from the call until the store shows its outcome, and never past a re-arm, a gone chat, or a new run", () => {
  const verdict = verdictFromAnswers(CRITERIA, LIVE_ANSWERS, { at: 1 });
  const failed = { at: 2, why: "403: no", tries: 2 };
  // Two different pairs cannot share a key, whatever a persisted id contains.
  assert.notEqual(judgeSlotKey("a:run", { runId: "x", startedAt: 1 }), judgeSlotKey("a", { runId: "run:x", startedAt: 1 }));
  assert.equal(judgeSlotKey("s", { startedAt: 100 }), JSON.stringify(["s", "start:100"]));
  const run = (extra: Record<string, unknown> = {}) => ({ runId: "r1", startedAt: 100, ...extra });
  assert.equal(outcomeShownOnRun(run(), { verdict, runKey: "run:r1" }), false);
  assert.equal(outcomeShownOnRun(run({ verdict }), { verdict, runKey: "run:r1" }), true);
  assert.equal(outcomeShownOnRun(run({ judgeFailed: { ...failed, at: 9 } }), { failed, runKey: "run:r1" }), false);
  assert.equal(outcomeShownOnRun(run({ judgeFailed: failed }), { failed, runKey: "run:r1" }), true);
  assert.deepEqual(runWithOutcome(run(), { failed, runKey: "run:r1" }), run({ judgeFailed: failed }));
  const slot = (settled?: JudgeSlot["settled"], generation = 0): JudgeSlot => ({ task: Promise.resolve(settled ?? { verdict, runKey: "run:r1" }), settled, generation });
  const slots = createJudgeSlots();
  const key = (id: string, r = run()) => judgeSlotKey(id, r);
  slots.map.set(key("shown"), slot({ verdict, runKey: "run:r1" }));
  slots.map.set(key("pending"), slot({ failed, runKey: "run:r1" }));
  slots.map.set(key("inflight-gone"), slot(undefined));
  slots.map.set(key("gone"), slot({ failed, runKey: "run:r1" }));
  slots.map.set(key("replaced"), slot({ verdict, runKey: "run:r1" }));
  sweepJudgeSlots(slots, [
    { id: "shown", agentRun: run({ verdict }) },
    { id: "pending", agentRun: run() },
    { id: "replaced", agentRun: run({ runId: "r2" }) },
  ]);
  // Shown, gone and replaced go; a settled outcome the store has not committed stays; a call still out stays even with its chat gone.
  assert.deepEqual([...slots.map.keys()].sort(), [key("inflight-gone"), key("pending")].sort());
  // A re-arm moves the table on: the settled failure left behind no longer speaks for its run. The call still out is left alone.
  rearmJudgeSlots(slots);
  sweepJudgeSlots(slots, [{ id: "pending", agentRun: run() }, { id: "inflight-gone", agentRun: run() }]);
  assert.deepEqual([...slots.map.keys()], [key("inflight-gone")]);
  // No cap: a settled outcome the store has yet to commit is the one thing the table exists to hold,
  // however many there are. They go the moment the store shows them.
  const crowded = createJudgeSlots();
  const wave = Array.from({ length: 300 }, (_, index) => `w${index}`);
  for (const id of wave) crowded.map.set(key(id), slot({ failed, runKey: "run:r1" }));
  sweepJudgeSlots(crowded, wave.map((id) => ({ id, agentRun: run() })));
  assert.equal(crowded.map.size, 300);
  sweepJudgeSlots(crowded, wave.map((id) => ({ id, agentRun: run({ judgeFailed: failed }) })));
  assert.equal(crowded.map.size, 0);
});
