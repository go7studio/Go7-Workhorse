import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGrokOneShot } from "../electron/grok-agent";
import { detectGrokLogin } from "../electron/grok-login";
import { composeVendorPrompt } from "../src/lib/context-preface";
import { prepareVendorSend } from "../src/lib/vendor-send";
import { SPAWN_TURN_HINT, WORKHORSE_SESSION_RULES, looksLikeSpawnRequest, withSpawnHint } from "../src/lib/workhorse-rules";

const goalLine = "/goal prove native goal driver. Do not edit files.";
const statusLine = "/goal status";

for (const text of [goalLine, statusLine, "/goal assign skeptic verifier"]) {
  if (looksLikeSpawnRequest(text)) throw new Error(`desk spawn steal on ${text}`);
  if (withSpawnHint(text) !== text) throw new Error(`spawn hint attached to ${text}`);
  const prep = prepareVendorSend({ provider: "grok", text });
  if (prep.vendorText !== text) throw new Error(`send-prep rewrote ${text} -> ${prep.vendorText}`);
  const composed = composeVendorPrompt(text, WORKHORSE_SESSION_RULES, "session/load");
  if (composed.includes(SPAWN_TURN_HINT) || composed.includes("workhorse_spawn_agent")) {
    throw new Error(`composed /goal instructs desk spawn:\n${composed}`);
  }
}

const login = detectGrokLogin();
if (!login.connected || !login.binary || !existsSync(login.binary)) {
  console.log("SKIP: grok is not on PATH or not logged in");
  process.exit(0);
}

const cwd = path.join(os.tmpdir(), "wh-grok-goal-1to1-live");
mkdirSync(cwd, { recursive: true });
const statusPrep = prepareVendorSend({ provider: "grok", text: statusLine });
const goalPrep = prepareVendorSend({ provider: "grok", text: goalLine });
const status = await runGrokOneShot({
  model: process.env.GROK_LIVE_MODEL || "grok-4.6",
  effort: "low",
  cwd,
  mode: "always-approve",
  prompt: statusPrep.vendorText,
});
if (status.text.includes("workhorse_spawn_agent") && /spawn every canCall/i.test(status.text)) {
  throw new Error("live /goal status was treated as desk spawn");
}

const set = await runGrokOneShot({
  model: process.env.GROK_LIVE_MODEL || "grok-4.6",
  effort: "low",
  cwd,
  mode: "always-approve",
  prompt: goalPrep.vendorText,
});
if (set.text.includes("SPAWN_TURN_HINT") || /MiniMax skeptic/i.test(set.text)) {
  throw new Error("live /goal looks like a desk MiniMax skeptic crew");
}

console.log(
  JSON.stringify(
    {
      skip: false,
      sent: [statusPrep.vendorText, goalPrep.vendorText],
      statusStop: status.stopReason ?? null,
      statusText: status.text.slice(0, 400),
      goalStop: set.stopReason ?? null,
      goalText: set.text.slice(0, 400),
    },
    null,
    2,
  ),
);
