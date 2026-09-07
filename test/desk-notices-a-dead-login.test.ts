import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fetchClaudePlanUsage } from "../electron/claude-plan";
import {
  claudeTokenFingerprint,
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

test("the usage beat is what notices, without asking Anthropic anything extra", async () => {
  const disk = paperStore();
  try {
    setClaudeRefusalStore(disk);
    // The ring's own call, refused. This runs on the desk's beat, so the card
    // can say Sign in again before the person has clicked anything at all.
    const refused = await fetchClaudePlanUsage({
      token: TOKEN,
      fetchImpl: (async () => ({ ok: false, status: 401, json: async () => ({}) })) as never,
    });
    assert.equal(refused, undefined, "no reading, as before");

    // fetchImpl is the injected path and does not carry the status through, so
    // the law that matters is pinned on the shipped call.
    const plan = read("electron/claude-plan.ts");
    const body = plan.slice(plan.indexOf("export async function fetchClaudePlanUsage"));
    assert.match(
      body,
      /if \(status === 401 \|\| status === 403\) \{\n\s+markClaudeTokenRejected\(`Anthropic refused the desk's login \(\$\{status\}\)\.`\);/,
      "a refused ring is recorded, not thrown away with every other bad status",
    );
    assert.match(body, /if \(status === 429 && cachedPlan\?\.plan\) return cachedPlan\.plan;/, "a rate limit is still not a refusal");
    assert.doesNotMatch(body, /markClaudeTokenRejected\([^)]*token/, "the reason never carries the credential");

    const main = read("electron/main.ts");
    assert.match(main, /claude-login-refusal\.json/, "the desk keeps the note under its own userData");
    assert.match(main, /setClaudeRefusalStore\(\{/, "and loads it at startup");
  } finally {
    setClaudeRefusalStore(null);
  }
});
