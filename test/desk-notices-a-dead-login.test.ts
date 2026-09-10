import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fetchClaudePlanUsage, judgeClaudeRingStatus } from "../electron/claude-plan";
import {
  clearClaudeTokenRejection,
  claudeTokenFingerprint,
  claudeMeterTokenProblem,
  claudeTokenProblem,
  forgetClaudeRefusalWithoutToken,
  markClaudeTokenRejected,
  resetClaudeTokenRejection,
  setClaudeRefusalStore,
} from "../electron/claude-stored-token";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

/** Not a real token. Only its identity matters here. */
const TOKEN = "sk-ant-oat01-FAKEFAKEFAKEFAKEFAKEFAKE0123456789";
const OTHER = "sk-ant-oat01-SECONDSECONDSECONDSECOND9876543210";

/** The file main keeps under userData, standing in as memory. */
function paperStore() {
  const io = {
    text: null as string | null,
    read: () => io.text,
    write: (text: string | null) => {
      io.text = text;
    },
  };
  return io;
}

test("a refused login is still refused after the desk restarts", () => {
  const disk = paperStore();
  try {
    setClaudeRefusalStore(disk);
    markClaudeTokenRejected("Anthropic refused the desk's login (401).", TOKEN);
    assert.equal(claudeTokenProblem(TOKEN), "Anthropic refused the desk's login (401).");
    assert.ok(disk.text, "it is written down, not only remembered");

    // The desk restarts: a new process, the same file.
    setClaudeRefusalStore({ read: disk.read, write: disk.write });
    assert.equal(
      claudeTokenProblem(TOKEN),
      "Anthropic refused the desk's login (401).",
      "a card that read On after every restart is how a dead login stayed invisible",
    );
    assert.equal(claudeTokenProblem(OTHER), null, "a token that was never refused is not refused");

    // Minting a new one clears it, and clears the file with it.
    resetClaudeTokenRejection();
    assert.equal(claudeTokenProblem(TOKEN), null);
    assert.equal(disk.text, null, "nothing is left behind to resurrect");
  } finally {
    setClaudeRefusalStore(null);
  }
});

test("the file names the token by a fingerprint, never by its value", () => {
  const disk = paperStore();
  try {
    setClaudeRefusalStore(disk);
    markClaudeTokenRejected("refused", TOKEN);
    assert.doesNotMatch(String(disk.text), /sk-ant-/, "a credential must not be written to userData twice");
    assert.match(String(disk.text), new RegExp(claudeTokenFingerprint(TOKEN)));
    assert.equal(claudeTokenFingerprint(TOKEN).length, 16);
    assert.notEqual(claudeTokenFingerprint(TOKEN), claudeTokenFingerprint(OTHER));
    assert.equal(claudeTokenFingerprint(null), "none", "a CLI login with no desk token still has a name");

    // A torn or hostile file is no refusal, and never throws.
    setClaudeRefusalStore({ read: () => "{not json", write: () => undefined });
    assert.equal(claudeTokenProblem(TOKEN), null);
    setClaudeRefusalStore({ read: () => JSON.stringify({ fingerprint: 7, reason: "" }), write: () => undefined });
    assert.equal(claudeTokenProblem(TOKEN), null);
    setClaudeRefusalStore({
      read: () => {
        throw new Error("unreadable");
      },
      write: () => undefined,
    });
    assert.equal(claudeTokenProblem(TOKEN), null, "a desk that cannot read its own note simply forgets");
  } finally {
    setClaudeRefusalStore(null);
  }
});

test("Recheck clears a refusal of the CLI login, and writes that down too", () => {
  const disk = paperStore();
  try {
    setClaudeRefusalStore(disk);
    markClaudeTokenRejected("not logged in", null);
    assert.equal(claudeTokenProblem(null), "not logged in");
    forgetClaudeRefusalWithoutToken();
    assert.equal(claudeTokenProblem(null), null);
    assert.equal(disk.text, null, "so a restart does not bring it back");

    markClaudeTokenRejected("refused", TOKEN);
    forgetClaudeRefusalWithoutToken();
    assert.equal(claudeTokenProblem(TOKEN), "refused", "a refused desk token is not cleared by Recheck");
  } finally {
    setClaudeRefusalStore(null);
  }
});

test("the usage beat marks its token suspect without refusing a launch", async () => {
  const disk = paperStore();
  try {
    setClaudeRefusalStore(disk);
    // A meter refusal questions its token without deciding whether inference works.
    const refused = await fetchClaudePlanUsage({
      userAgent: "claude-code/test",
      token: TOKEN,
      fetchImpl: (async () => ({ ok: false, status: 401, json: async () => ({}) })) as never,
    });
    assert.equal(refused, undefined, "no reading, as before");

    assert.equal(claudeTokenProblem(TOKEN), null, "a meter refusal cannot refuse a launch");
    assert.equal(claudeMeterTokenProblem(TOKEN), "Anthropic refused the desk's usage token (401).");
    setClaudeRefusalStore(disk);
    assert.equal(claudeTokenProblem(TOKEN), null, "a restart cannot promote suspicion into a launch refusal");
    assert.ok(claudeMeterTokenProblem(TOKEN));

    // A blip must not condemn a good login for ever: the same call that
    // refused it is the one that clears it.
    await fetchClaudePlanUsage({
      userAgent: "claude-code/test",
      token: TOKEN,
      fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({}) })) as never,
    });
    assert.equal(claudeTokenProblem(TOKEN), null, "one 401 from a proxy or an incident never blocks launch");
    assert.equal(claudeMeterTokenProblem(TOKEN), null, "the next good beat clears suspicion");

    // Every other status says nothing about the login, either way.
    markClaudeTokenRejected("Anthropic refused the desk's login (401).", TOKEN);
    judgeClaudeRingStatus(429, TOKEN);
    assert.equal(claudeTokenProblem(TOKEN), "Anthropic refused the desk's login (401).", "a rate limit is not an answer");
    judgeClaudeRingStatus(500, TOKEN);
    assert.equal(claudeTokenProblem(TOKEN), "Anthropic refused the desk's login (401).", "nor is an outage");
    judgeClaudeRingStatus(200, TOKEN);
    assert.equal(claudeTokenProblem(TOKEN), null);

    // Clearing is per token: a success on one login says nothing about another.
    markClaudeTokenRejected("refused", TOKEN);
    clearClaudeTokenRejection(OTHER);
    assert.equal(claudeTokenProblem(TOKEN), "refused", "another token's success does not absolve this one");
    clearClaudeTokenRejection(TOKEN);
    assert.equal(claudeTokenProblem(TOKEN), null);
    assert.equal(disk.text, null, "and the note goes with it");

    const plan = read("electron/claude-plan.ts");
    const body = plan.slice(plan.indexOf("export function judgeClaudeRingStatus"));
    assert.doesNotMatch(body.slice(0, body.indexOf("export async function")), /\$\{token\}/, "the reason never carries the credential");
    const main = read("electron/main.ts");
    assert.match(main, /if \(isMcpHelper\) return;/, "the Link helper does not keep the desk's note");
    assert.match(main, /fs\.renameSync\(scratch, file\);/, "a reader never meets half a note");

    assert.match(main, /claude-login-refusal\.json/, "the desk keeps the note under its own userData");
    assert.match(main, /setClaudeRefusalStore\(\{/, "and loads it at startup");
  } finally {
    setClaudeRefusalStore(null);
  }
});

test("source-less usage refusals migrate without forgiving old launch refusals", () => {
  try {
    for (const reason of ["Anthropic refused the desk's login (401).", "Anthropic refused the desk's login (403).", "Anthropic refused the desk's usage token (401).", "OAuth session expired"]) {
      const raw = JSON.stringify({ fingerprint: claudeTokenFingerprint(TOKEN), reason, at: "2026-09-09" });
      setClaudeRefusalStore({ read: () => raw, write: () => undefined });
      const usage = reason.includes("Anthropic");
      assert.equal(claudeTokenProblem(TOKEN), usage ? null : reason);
      assert.equal(claudeMeterTokenProblem(TOKEN), usage ? reason : null);
    }
  } finally {
    setClaudeRefusalStore(null);
  }
});
